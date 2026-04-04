/**
 * @module bot/bot
 * @description Telegraf bot setup, lifecycle management, and polling configuration.
 *
 * Provides the {@link TelegramBot} class which wraps a Telegraf instance with:
 * - A configurable middleware stack (logging → auth → error handling)
 * - Graceful shutdown on SIGINT / SIGTERM
 * - Structured pino logging via a child logger scoped to `"bot"`
 *
 * The class intentionally does **not** depend on the global config singleton;
 * the bot token and allowed-user ID are passed in at construction /
 * initialisation time so the module stays easily testable.
 */

import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import { createLoggingMiddleware } from "./middleware/logging.js";
import { createAuthMiddleware } from "./middleware/auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link TelegramBot.initialize}.
 */
export interface BotInitOptions {
  /** Telegram user ID that is allowed to interact with the bot. */
  allowedUserId: number;

  /** Handler invoked for every incoming text message. */
  onMessage: (ctx: Context, text: string) => Promise<void>;

  /**
   * Optional handler invoked for bot commands.
   *
   * Receives the command name (without the leading `/`) and the remaining
   * argument string.
   */
  onCommand?: (ctx: Context, command: string, args: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// TelegramBot
// ---------------------------------------------------------------------------

/**
 * High-level wrapper around a Telegraf instance.
 *
 * Usage:
 * ```ts
 * const bot = createBot(token);
 * bot.initialize({ allowedUserId: 12345, onMessage: handler });
 * await bot.launch();
 * ```
 */
export class TelegramBot {
  private bot: Telegraf;
  private isRunning: boolean = false;
  private logger: Logger;

  /**
   * @param token - The Telegram Bot API token obtained from BotFather.
   */
  constructor(token: string) {
    this.bot = new Telegraf(token);
    this.logger = createChildLogger("bot");
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Register the middleware stack and message / command handlers.
   *
   * **Must** be called before {@link launch}. Middleware is applied in the
   * following order:
   *
   * 1. Logging middleware — logs every incoming update
   * 2. Auth guard middleware — drops unauthorised updates
   * 3. Error-handling middleware — catches downstream errors
   * 4. Command handler (if `onCommand` provided)
   * 5. Text-message handler
   * 6. Catch-all for unhandled update types
   */
  initialize(options: BotInitOptions): void {
    const { allowedUserId, onMessage, onCommand } = options;

    // 1. Logging
    this.bot.use(createLoggingMiddleware());

    // 2. Auth guard
    this.bot.use(createAuthMiddleware(allowedUserId));

    // 3. Error handling — wraps every subsequent handler in a try/catch
    this.bot.use(async (ctx, next) => {
      try {
        await next();
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        this.logger.error(
          { err, updateId: ctx.update.update_id },
          "Unhandled error in middleware chain",
        );
        try {
          await ctx.reply(
            "⚠️ An unexpected error occurred. Please try again later.",
          );
        } catch (replyErr) {
          this.logger.error(
            { err: replyErr },
            "Failed to send error reply to user",
          );
        }
      }
    });

    // 4. Command handler (optional)
    //
    // Handlers are dispatched as fire-and-forget background tasks so that
    // Telegraf's update loop is NOT blocked. This allows parallel messages
    // to be dispatched to the session pool concurrently.  Errors are caught
    // inside the handlers themselves (not the middleware error handler).
    if (onCommand) {
      this.bot.on(message("text"), async (ctx, next) => {
        const text = ctx.message.text;
        if (!text.startsWith("/")) {
          return next();
        }

        const parts = text.slice(1).split(/\s+/);
        const command = parts[0] ?? "";
        const cleanCommand = command.split("@")[0]!;
        const args = parts.slice(1).join(" ");

        // Fire-and-forget — don't await so the next update can be dispatched
        onCommand(ctx, cleanCommand, args).catch((err: unknown) => {
          this.logger.error({ err, command: cleanCommand }, "Unhandled error in command handler");
        });
      });
    }

    // 5. Text message handler (fire-and-forget for parallel processing)
    this.bot.on(message("text"), async (ctx) => {
      onMessage(ctx, ctx.message.text).catch((err: unknown) => {
        this.logger.error({ err }, "Unhandled error in message handler");
      });
    });

    // 6. Catch-all for unhandled update types
    this.bot.on("message", (ctx) => {
      this.logger.debug(
        { updateType: ctx.updateType, messageType: "non-text" },
        "Received non-text message — ignoring",
      );
    });

    this.logger.info("Bot initialised — middleware and handlers registered");
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the bot in long-polling mode.
   *
   * Telegraf's `launch()` never resolves — it runs the polling loop forever.
   * We use the `onLaunch` callback to detect when the initial handshake
   * (getMe + deleteWebhook) succeeds, then let polling continue in the
   * background.
   *
   * @throws {Error} If the Telegram API is unreachable after all retry attempts.
   */
  async launch(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("launch() called but bot is already running");
      return;
    }

    const maxRetries = 3;
    const retryDelayMs = 5_000;
    /** Timeout for the initial getMe + deleteWebhook handshake. */
    const connectTimeoutMs = 30_000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // launch() never resolves because it runs the polling loop.
        // The onLaunch callback fires right after getMe + deleteWebhook
        // succeed and before polling starts — that's our "connected" signal.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Object.assign(
              new Error("Telegram connection timed out"),
              { code: "ETIMEDOUT" },
            )),
            connectTimeoutMs,
          );

          // Fire-and-forget: launch runs the polling loop in the background.
          // Errors during the initial handshake are caught via .catch().
          this.bot.launch(() => {
            clearTimeout(timer);
            resolve();
          }).catch((err: unknown) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        this.isRunning = true;

        const botInfo = this.bot.botInfo;
        if (botInfo) {
          this.logger.info(
            { username: botInfo.username },
            `Bot launched as @${botInfo.username}`,
          );
        } else {
          this.logger.info("Bot launched (username not yet available)");
        }

        // NOTE: Signal handlers for graceful shutdown are registered by the
        // App orchestrator (app.ts), NOT here — avoids duplicate handlers.

        return; // success
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as NodeJS.ErrnoException).code;

        const isNetworkError = code === "ETIMEDOUT" || code === "ECONNREFUSED" ||
          code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENETUNREACH";

        if (isNetworkError && attempt < maxRetries) {
          console.log(`  ⚠ Telegram connection failed (${code}). Retrying in ${retryDelayMs / 1000}s… (${attempt}/${maxRetries})`);
          this.logger.warn(
            { attempt, maxRetries, code },
            `Telegram connection failed (${code}). Retrying in ${retryDelayMs / 1000}s…`,
          );
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }

        this.logger.error({ err, code }, `Failed to connect to Telegram API: ${msg}`);
        throw new Error(
          `Could not connect to Telegram (${code || "UNKNOWN"}): ${msg}\n` +
          "  → Check your internet connection and bot token.\n" +
          "  → Verify the token with: https://api.telegram.org/bot<TOKEN>/getMe",
        );
      }
    }
  }

  /**
   * Stop the bot gracefully.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.debug("stop() called but bot is not running");
      return;
    }

    this.bot.stop("graceful shutdown");
    this.isRunning = false;
    this.logger.info("Bot stopped");
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /**
   * Return the underlying Telegraf instance for advanced or low-level usage.
   */
  getBot(): Telegraf {
    return this.bot;
  }

  /**
   * Check whether the bot is currently running (polling).
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link TelegramBot} instance.
 *
 * @param token - The Telegram Bot API token.
 * @returns An uninitialised `TelegramBot` — call {@link TelegramBot.initialize}
 *   then {@link TelegramBot.launch} to start it.
 */
export function createBot(token: string): TelegramBot {
  return new TelegramBot(token);
}

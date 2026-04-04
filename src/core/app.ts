/**
 * @module core/app
 * @description Main application orchestrator — boots the database, plugin
 * system, AI session, and Telegram bot in the correct order, and tears
 * everything down gracefully on shutdown.
 *
 * Usage:
 * ```ts
 * const app = new App();
 * await app.start({ verbose: true });
 * ```
 */

import dns from "node:dns";
import type { Logger } from "pino";
import { createChildLogger, setLogLevel } from "./logger.js";
import { getConfig } from "./config.js";

// Force IPv4-first DNS resolution. Many networks have broken IPv6 connectivity,
// which causes Node.js (which defaults to IPv6-first) to hang when connecting
// to services like api.telegram.org that publish both A and AAAA records.
dns.setDefaultResultOrder("ipv4first");
import { getDatabase, closeDatabase } from "../storage/database.js";
import { ConversationRepository } from "../storage/repositories/conversation.js";
import { PreferencesRepository } from "../storage/repositories/preferences.js";
import { PluginStateRepository } from "../storage/repositories/plugin-state.js";
import { createModelRegistry } from "../ai/models.js";
import { copilotClient } from "../ai/client.js";
import { sessionManager } from "../ai/session.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginManager } from "../plugins/manager.js";
import { pluginSandbox } from "../plugins/sandbox.js";
import { credentialManager } from "../plugins/credentials.js";
import { createBot, type TelegramBot } from "../bot/bot.js";
import type { Context } from "telegraf";
import { createMessageHandler, splitMessage } from "../bot/handlers/message.js";
import { HeartbeatManager } from "./heartbeat.js";
import { GarbageCollector } from "./gc.js";
import type { PluginManager } from "../plugins/manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by {@link App.start}. */
export interface StartOptions {
  /** Enable debug-level logging. */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * Top-level application orchestrator.
 *
 * Coordinates the full startup and shutdown sequence for all subsystems:
 * database → repositories → plugins → AI client/session → Telegram bot.
 */
export class App {
  private logger: Logger;
  private bot?: TelegramBot;
  private pluginManager?: PluginManager;
  private heartbeatManager?: HeartbeatManager;
  private gc?: GarbageCollector;
  private isShuttingDown: boolean = false;
  private verbose: boolean = false;

  constructor() {
    this.logger = createChildLogger("app");
  }

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  /**
   * Boot the entire application.
   *
   * Initialisation order:
   * 1. Configuration & logging
   * 2. Database & repositories
   * 3. Model registry
   * 4. Plugin system (registry → manager)
   * 5. Copilot AI client & session
   * 6. Telegram bot (handlers → launch)
   * 7. OS signal handlers for graceful shutdown
   *
   * @param options - Optional start-up flags.
   */
  async start(options?: StartOptions): Promise<void> {
    // 1. Load configuration
    console.log("  ▸ Loading configuration…");
    const config = getConfig();
    this.logger.info("Configuration loaded");

    // 2. Verbose logging
    if (options?.verbose) {
      setLogLevel("debug");
      this.verbose = true;
      this.logger.debug("Verbose logging enabled");
    }

    // 3. Initialise database
    console.log("  ▸ Initializing database…");
    const db = getDatabase();
    this.logger.info("Database ready");

    // 4. Create repositories
    const conversationRepo = new ConversationRepository(db);
    const preferencesRepo = new PreferencesRepository(db);
    const pluginStateRepo = new PluginStateRepository(db);
    this.logger.info("Repositories created");

    // 4b. Start garbage collector for DB retention and memory monitoring
    const gc = new GarbageCollector({
      intervalMinutes: 30,
      conversationRetentionDays: 30,
      healthRetentionDays: 7,
    });
    gc.start(db);
    this.gc = gc;

    // 5. Model registry
    const modelRegistry = createModelRegistry(preferencesRepo);
    this.logger.info("Model registry initialised");

    // 6. Plugin system
    console.log("  ▸ Discovering plugins…");
    const pluginRegistry = createPluginRegistry();
    await pluginRegistry.discoverPlugins();

    const pluginManager = createPluginManager(
      pluginRegistry,
      pluginSandbox,
      credentialManager,
      pluginStateRepo,
    );
    await pluginManager.initialize();
    this.pluginManager = pluginManager;
    this.logger.info("Plugin system ready");

    // 7. Start Copilot client
    console.log("  ▸ Starting Copilot SDK client…");
    await copilotClient.start();

    // 8. Resolve model & aggregate tools from plugins
    const currentModel = modelRegistry.getCurrentModelId();
    const activePlugins = pluginManager.getActivePlugins();
    const pluginTools = pluginManager.getAllTools();
    const poolSize = Math.max(1, parseInt(config.env.AI_SESSION_POOL_SIZE || "3", 10));

    // 9. Create AI session pool with model and plugin tools
    console.log(`  ▸ Creating AI session pool (model: ${currentModel}, sessions: ${poolSize})…`);
    await sessionManager.createSession(currentModel, pluginTools, poolSize);

    // 10. Create and launch Telegram bot
    console.log("  ▸ Connecting to Telegram…");
    const bot = createBot(config.env.TELEGRAM_BOT_TOKEN);

    const rawMessageHandler = createMessageHandler({
      sessionManager,
      conversationRepo,
    });

    // Wrap the message handler with debug console logging
    const messageHandler = async (ctx: Context, text: string): Promise<void> => {
      const ts = () => new Date().toLocaleTimeString();
      const preview = text.length > 60 ? text.slice(0, 60) + "…" : text;

      if (this.verbose) {
        console.log(`  ⇣ [${ts()}] Message received: "${preview}"`);
      }

      const startTime = Date.now();
      await rawMessageHandler(ctx, text);

      if (this.verbose) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ⇡ [${ts()}] Message completed (${elapsed}s)`);
      }
    };

    // Heartbeat manager — created early so the command handler can reference it
    const heartbeatManager = new HeartbeatManager();
    this.heartbeatManager = heartbeatManager;

    /**
     * Runs one or all heartbeat events on demand and delivers results in-chat.
     * Replies are threaded to the user's original /heartbeat command message.
     */
    const runHeartbeatOnDemand = async (ctx: Context, eventName?: string) => {
      const replyToId = ctx.message?.message_id;
      const replyOpts = replyToId
        ? { reply_parameters: { message_id: replyToId } } as Record<string, unknown>
        : {};

      const allEvents = heartbeatManager.listEvents();

      if (allEvents.length === 0) {
        await ctx.reply("No heartbeat events configured.\nAdd one with: co-assistant heartbeat add", replyOpts);
        return;
      }

      let eventsToRun = allEvents;
      if (eventName) {
        const match = allEvents.find((e) => e.name === eventName);
        if (!match) {
          const names = allEvents.map((e) => e.name).join(", ");
          await ctx.reply(`❌ Heartbeat "${eventName}" not found.\nAvailable: ${names}`, replyOpts);
          return;
        }
        eventsToRun = [match];
      }

      await ctx.reply(`🚀 Running ${eventsToRun.length} heartbeat event(s)…`, replyOpts);

      // Keep typing indicator alive while processing
      const typingInterval = setInterval(() => {
        ctx.sendChatAction("typing").catch(() => {});
      }, 4000);

      try {
        for (const event of eventsToRun) {
          try {
            // Inject dedup state
            const useDedup = event.prompt.includes("{{DEDUP_STATE}}");
            const state = useDedup ? heartbeatManager.loadState(event.name) : null;
            let finalPrompt = event.prompt;
            if (state) {
              finalPrompt = event.prompt.replace(
                "{{DEDUP_STATE}}",
                state.processedIds.length > 0
                  ? `Previously processed IDs (${state.processedIds.length} total) — SKIP these:\n${state.processedIds.map((id) => `- ${id}`).join("\n")}`
                  : "No previously processed items — this is the first run.",
              );
            }

            const response = await sessionManager.sendMessage(finalPrompt);

            if (!response) {
              await ctx.reply(`⚠️ Heartbeat "${event.name}" returned no response.`, replyOpts);
              continue;
            }

            // Persist dedup IDs — use a Set to avoid duplicates
            const processedRe = /<!--\s*PROCESSED:\s*(.*?)\s*-->/gi;
            if (useDedup && state) {
              const existing = new Set(state.processedIds);
              let m: RegExpExecArray | null;
              while ((m = processedRe.exec(response)) !== null) {
                for (const id of (m[1] ?? "").split(",")) {
                  const t = id.trim();
                  if (t && !existing.has(t)) {
                    state.processedIds.push(t);
                    existing.add(t);
                  }
                }
              }
              processedRe.lastIndex = 0;
              state.lastRun = new Date().toISOString();
              heartbeatManager.saveState(event.name, state);
            }

            // Clean marker and deliver — threaded to original command
            const clean = response.replace(/<!--\s*PROCESSED:\s*.*?\s*-->/gi, "").trim();
            if (clean) {
              const header = `💓 *Heartbeat: ${event.name}*\n\n`;
              const chunks = splitMessage(header + clean);
              for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: "Markdown", ...replyOpts } as Record<string, unknown>);
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error({ err, event: event.name }, "On-demand heartbeat failed");
            await ctx.reply(`❌ Heartbeat "${event.name}" failed: ${msg}`, replyOpts);
          }
        }
      } finally {
        clearInterval(typingInterval);
      }
    };

    /** Handle bot commands: /heartbeat [name] */
    const commandHandler = async (ctx: Context, command: string, args: string) => {
      const ts = () => new Date().toLocaleTimeString();
      const replyToId = ctx.message?.message_id;
      const replyOpts = replyToId
        ? { reply_parameters: { message_id: replyToId } } as Record<string, unknown>
        : {};

      if (this.verbose) {
        console.log(`  ⇣ [${ts()}] Command received: /${command}${args ? " " + args : ""}`);
      }

      const startTime = Date.now();

      switch (command) {
        case "heartbeat":
        case "hb":
          await runHeartbeatOnDemand(ctx, args.trim() || undefined);
          break;

        case "help":
          await ctx.reply(
            "🤖 *Co-Assistant Commands*\n\n" +
            "/heartbeat \\[name\\] — Run heartbeat event\\(s\\)\n" +
            "/hb \\[name\\] — Shorthand for /heartbeat\n" +
            "/help — Show this message\n\n" +
            "Or just send a message to chat with the AI\\.",
            { parse_mode: "MarkdownV2", ...replyOpts } as Record<string, unknown>,
          );
          break;

        default:
          // Unknown command — fall through to message handler
          await messageHandler(ctx, `/${command} ${args}`.trim());
      }

      if (this.verbose) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  ⇡ [${ts()}] Command completed: /${command} (${elapsed}s)`);
      }
    };

    bot.initialize({
      allowedUserId: Number(config.env.TELEGRAM_USER_ID),
      onMessage: messageHandler,
      onCommand: commandHandler,
    });

    try {
      await bot.launch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err }, "Telegram bot failed to start");
      console.error(`\n✗ Telegram bot failed to start:\n  ${msg}\n`);
      await this.shutdown();
      return;
    }
    this.bot = bot;

    // 11. Startup banner — visible in the console
    const pluginCount = activePlugins.size;
    const botUsername = bot.getBot().botInfo?.username ?? "unknown";
    const pluginNames = [...activePlugins.keys()].join(", ") || "none";

    this.logger.info(
      { model: currentModel, plugins: pluginCount, version: "1.0.0" },
      `Co-Assistant is running! Model: ${currentModel}, Plugins: ${pluginCount}`,
    );

    console.log("");
    console.log("  ╔══════════════════════════════════════════════╗");
    console.log("  ║         🤖 Co-Assistant is running!          ║");
    console.log("  ╚══════════════════════════════════════════════╝");
    console.log("");
    console.log(`  Bot:     @${botUsername}`);
    console.log(`  Model:   ${currentModel}`);
    console.log(`  Sessions: ${poolSize} (parallel processing)`);
    console.log(`  Plugins: ${pluginNames} (${pluginCount} active)`);

    // 12. Start heartbeat scheduler
    const heartbeatInterval = parseInt(config.env.HEARTBEAT_INTERVAL_MINUTES || "0", 10);
    const heartbeatEvents = heartbeatManager.listEvents();

    if (heartbeatInterval > 0 && heartbeatEvents.length > 0) {
      heartbeatManager.start(
        heartbeatInterval,
        // Send heartbeat prompt to the AI session
        async (prompt) => sessionManager.sendMessage(prompt),
        // Forward the AI's response to the user via Telegram
        async (eventName, response) => {
          try {
            const chatId = config.env.TELEGRAM_USER_ID;
            const header = `💓 *Heartbeat: ${eventName}*\n\n`;
            const fullMessage = header + response;

            // Split long responses to respect Telegram's 4096-char limit
            const chunks = splitMessage(fullMessage);
            for (const chunk of chunks) {
              await bot.getBot().telegram.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
            }
          } catch (err) {
            this.logger.error({ err, eventName }, "Failed to send heartbeat response via Telegram");
          }
        },
      );
      console.log(`  Heartbeat: every ${heartbeatInterval} min (${heartbeatEvents.length} events)`);
    } else if (heartbeatInterval > 0) {
      console.log(`  Heartbeat: every ${heartbeatInterval} min (no events — add with: co-assistant heartbeat add)`);
    } else {
      console.log("  Heartbeat: disabled (set HEARTBEAT_INTERVAL_MINUTES in .env)");
    }

    console.log("");
    console.log("  Open Telegram and send a message to your bot to get started.");
    console.log("  Press Ctrl+C to stop.\n");

    // 12. Graceful shutdown on OS signals
    const shutdownHandler = async (signal: string) => {
      this.logger.info({ signal }, "Received shutdown signal");
      await this.shutdown();
    };
    process.once("SIGINT", () => shutdownHandler("SIGINT"));
    process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down all subsystems in reverse order.
   *
   * Each step is wrapped in its own try/catch so a failure in one subsystem
   * never prevents the others from cleaning up.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn("Shutdown already in progress — skipping");
      return;
    }
    this.isShuttingDown = true;
    this.logger.info("Initiating graceful shutdown…");

    // 1. Stop heartbeat scheduler
    if (this.heartbeatManager) {
      this.heartbeatManager.stop();
      this.logger.info("Heartbeat scheduler stopped");
    }

    // 1b. Stop garbage collector
    if (this.gc) {
      this.gc.stop();
    }

    // 2. Stop Telegram bot
    try {
      if (this.bot) {
        await this.bot.stop();
        this.logger.info("Telegram bot stopped");
      }
    } catch (err) {
      this.logger.error({ err }, "Error stopping Telegram bot");
    }

    // 3. Close AI session
    try {
      await sessionManager.closeSession();
      this.logger.info("AI session closed");
    } catch (err) {
      this.logger.error({ err }, "Error closing AI session");
    }

    // 4. Stop Copilot client
    try {
      await copilotClient.stop();
      this.logger.info("Copilot client stopped");
    } catch (err) {
      this.logger.error({ err }, "Error stopping Copilot client");
    }

    // 5. Shutdown plugins
    try {
      if (this.pluginManager) {
        await this.pluginManager.shutdown();
        this.logger.info("Plugins shut down");
      }
    } catch (err) {
      this.logger.error({ err }, "Error shutting down plugins");
    }

    // 6. Close database
    try {
      closeDatabase();
      this.logger.info("Database closed");
    } catch (err) {
      this.logger.error({ err }, "Error closing database");
    }

    this.logger.info("👋 Goodbye!");
    process.exit(0);
  }
}

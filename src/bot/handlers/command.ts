/**
 * @module bot/handlers/command
 * @description Telegram bot command handler — registers slash-command handlers
 * on a Telegraf instance for model management, plugin control, conversation
 * history, and status display.
 *
 * Each command is wrapped in error handling so that a failing command never
 * crashes the bot; the user always receives feedback.
 */

import type { Telegraf, Context } from "telegraf";
import type { SessionManager } from "../../ai/session.js";
import type { ModelRegistry } from "../../ai/models.js";
import type { PluginManager } from "../../plugins/manager.js";
import type { ConversationRepository } from "../../storage/repositories/conversation.js";
import type { HeartbeatManager } from "../../core/heartbeat.js";
import { createChildLogger } from "../../core/logger.js";

const logger = createChildLogger("bot:commands");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the command registration function. */
export interface CommandHandlerDeps {
  /** AI session manager for model switching and session state. */
  sessionManager: SessionManager;
  /** Registry of available AI models and current selection. */
  modelRegistry: ModelRegistry;
  /** Plugin lifecycle manager. */
  pluginManager: PluginManager;
  /** Conversation message persistence. */
  conversationRepo: ConversationRepository;
  /** Heartbeat manager for update checking. */
  heartbeatManager: HeartbeatManager;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text payload after the `/command` token.
 *
 * Telegraf's narrowed command context exposes `ctx.payload`, but the generic
 * `Context` type does not include it. This helper safely extracts the payload
 * from the raw message text as a portable fallback.
 */
function extractPayload(ctx: Context): string {
  const text =
    ctx.message && "text" in ctx.message ? ctx.message.text : "";
  const spaceIdx = text.indexOf(" ");
  return spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
}

/**
 * Wrap a command handler so that any error is caught, logged, and surfaced
 * as a friendly reply to the user.
 */
function safe(
  name: string,
  handler: (ctx: Context) => Promise<void>,
): (ctx: Context) => Promise<void> {
  return async (ctx: Context) => {
    try {
      await handler(ctx);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ err, command: name }, `Error handling /${name} command`);
      try {
        await ctx.reply(`⚠️ Error executing /${name}: ${reason}`);
      } catch {
        // If even the error reply fails there is nothing more we can do.
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Register all bot slash-commands on the given Telegraf instance.
 *
 * Commands registered:
 * - `/start`   — Welcome message
 * - `/help`    — List available commands
 * - `/model`   — View or change the AI model
 * - `/plugins` — List plugins and their status
 * - `/enable`  — Enable a plugin
 * - `/disable` — Disable a plugin
 * - `/clear`   — Clear conversation history and reset AI sessions (fresh context)
 * - `/update`  — Check for Co-Assistant updates on npm
 * - `/status`  — Show bot status overview
 *
 * @param bot  - The Telegraf bot instance to attach commands to.
 * @param deps - External services required by the command handlers.
 */
export function registerBotCommands(
  bot: Telegraf,
  deps: CommandHandlerDeps,
): void {
  const { sessionManager, modelRegistry, pluginManager, conversationRepo, heartbeatManager } =
    deps;

  // -- /start ---------------------------------------------------------------

  bot.command(
    "start",
    safe("start", async (ctx) => {
      logger.info("Handling /start command");

      const currentModel = modelRegistry.getCurrentModelId();
      const plugins = pluginManager.getPluginInfoList();
      const activePlugins = plugins
        .filter((p) => p.enabled && p.status === "active")
        .map((p) => p.id);

      const activeList =
        activePlugins.length > 0 ? activePlugins.join(", ") : "none";

      await ctx.reply(
        `👋 Welcome to Co-Assistant!\n\n` +
          `I'm your AI-powered personal assistant. Send me any message and I'll help you out.\n\n` +
          `Use /help to see available commands.\n` +
          `Current model: ${currentModel}\n` +
          `Active plugins: ${activeList}`,
      );
    }),
  );

  // -- /help ----------------------------------------------------------------

  bot.command(
    "help",
    safe("help", async (ctx) => {
      logger.info("Handling /help command");

      await ctx.reply(
        `📖 Available Commands:\n` +
          `/start - Welcome message\n` +
          `/help - Show this help\n` +
          `/model [name] - View or change AI model\n` +
          `/plugins - List plugins and their status\n` +
          `/enable <plugin> - Enable a plugin\n` +
          `/disable <plugin> - Disable a plugin\n` +
          `/clear - Clear conversation and reset AI context\n` +
          `/update - Check for Co-Assistant updates\n` +
          `/status - Show bot status`,
      );
    }),
  );

  // -- /model [name] --------------------------------------------------------

  bot.command(
    "model",
    safe("model", async (ctx) => {
      const payload = extractPayload(ctx);

      if (!payload) {
        // No argument — show current model and available models
        const currentId = modelRegistry.getCurrentModelId();
        const models = modelRegistry.getAvailableModels();

        const list = models
          .map((m) => `${m.id === currentId ? "▸ " : "  "}${m.id} — ${m.description}`)
          .join("\n");

        logger.info("Handling /model (list)");
        await ctx.reply(
          `🤖 Current model: ${currentId}\n\nAvailable models:\n${list}`,
        );
        return;
      }

      // Argument provided — switch model
      const newModelId = payload;
      logger.info({ from: modelRegistry.getCurrentModelId(), to: newModelId }, "Handling /model (switch)");

      modelRegistry.setCurrentModel(newModelId);

      try {
        await sessionManager.switchModel(newModelId);
        await ctx.reply(`✅ Model switched to ${newModelId}`);
      } catch (switchErr: unknown) {
        const reason =
          switchErr instanceof Error ? switchErr.message : String(switchErr);
        logger.error({ err: switchErr, modelId: newModelId }, "Failed to switch model session");
        // Model preference was set but session rebuild failed
        await ctx.reply(
          `⚠️ Model preference updated to ${newModelId}, but session rebuild failed: ${reason}`,
        );
      }
    }),
  );

  // -- /plugins -------------------------------------------------------------

  bot.command(
    "plugins",
    safe("plugins", async (ctx) => {
      logger.info("Handling /plugins command");

      const plugins = pluginManager.getPluginInfoList();

      if (plugins.length === 0) {
        await ctx.reply("🔌 No plugins discovered.");
        return;
      }

      const lines = plugins.map((p) => {
        const icon = p.enabled && p.status === "active" ? "✅" : "❌";
        const toolInfo =
          p.enabled && p.status === "active"
            ? `[${p.tools.length} tool${p.tools.length !== 1 ? "s" : ""}]`
            : "[disabled]";

        return `${icon} ${p.id} (v${p.version}) - ${p.name} ${toolInfo}`;
      });

      await ctx.reply(`🔌 Plugins:\n${lines.join("\n")}`);
    }),
  );

  // -- /enable <plugin> -----------------------------------------------------

  bot.command(
    "enable",
    safe("enable", async (ctx) => {
      const pluginId = extractPayload(ctx);

      if (!pluginId) {
        await ctx.reply("Usage: /enable <plugin>");
        return;
      }

      logger.info({ pluginId }, "Handling /enable command");

      await pluginManager.enablePlugin(pluginId);
      await ctx.reply(`✅ Plugin "${pluginId}" has been enabled.`);
    }),
  );

  // -- /disable <plugin> ----------------------------------------------------

  bot.command(
    "disable",
    safe("disable", async (ctx) => {
      const pluginId = extractPayload(ctx);

      if (!pluginId) {
        await ctx.reply("Usage: /disable <plugin>");
        return;
      }

      logger.info({ pluginId }, "Handling /disable command");

      await pluginManager.disablePlugin(pluginId);
      await ctx.reply(`✅ Plugin "${pluginId}" has been disabled.`);
    }),
  );

  // -- /clear ---------------------------------------------------------------

  bot.command(
    "clear",
    safe("clear", async (ctx) => {
      logger.info("Handling /clear command");

      // 1. Clear persisted conversation history
      const count = conversationRepo.count();
      conversationRepo.clear();

      // 2. Kick off pool rebuild in the background — don't make the user wait.
      //    Messages arriving during rebuild queue in acquire() and are served
      //    once the new pool is ready (waiter drain in createSession).
      sessionManager.resetSessions().catch((err: unknown) => {
        logger.error({ err }, "Background session rebuild failed after /clear");
      });

      await ctx.reply(
        `✅ Context cleared.\n` +
          `• ${count} message${count !== 1 ? "s" : ""} deleted from history\n` +
          `• AI sessions rebuilding in background`,
      );
    }),
  );

  // -- /update --------------------------------------------------------------

  bot.command(
    "update",
    safe("update", async (ctx) => {
      logger.info("Handling /update command");

      await ctx.reply("🔍 Checking for updates…");

      const result = await heartbeatManager.checkForUpdates();

      if (!result) {
        await ctx.reply("⚠️ Could not reach the npm registry. Try again later.");
        return;
      }

      if (result.updateAvailable) {
        await ctx.reply(
          `📦 Update available: v${result.latestVersion}\n` +
            `You're running v${result.currentVersion}.\n\n` +
            `To update:\n` +
            `npm install -g @hmawla/co-assistant@latest\n\n` +
            `Then restart with: co-assistant start`,
        );
      } else {
        await ctx.reply(
          `✅ You're up to date! (v${result.currentVersion})`,
        );
      }
    }),
  );

  // -- /status --------------------------------------------------------------

  bot.command(
    "status",
    safe("status", async (ctx) => {
      logger.info("Handling /status command");

      const currentModel = modelRegistry.getCurrentModelId();
      const sessionActive = sessionManager.isActive();
      const msgCount = conversationRepo.count();
      const plugins = pluginManager.getPluginInfoList();
      const activeCount = plugins.filter(
        (p) => p.enabled && p.status === "active",
      ).length;
      const disabledCount = plugins.length - activeCount;

      await ctx.reply(
        `📊 Co-Assistant Status\n` +
          `─────────────────────\n` +
          `Model: ${currentModel}\n` +
          `Session: ${sessionActive ? "active" : "inactive"}\n` +
          `Conversation: ${msgCount} message${msgCount !== 1 ? "s" : ""}\n` +
          `Plugins: ${activeCount} active, ${disabledCount} disabled`,
      );
    }),
  );

  logger.info("Bot commands registered");
}

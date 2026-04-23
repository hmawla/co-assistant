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
import { spawn } from "node:child_process";
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
import { Markup, type Context } from "telegraf";
import { createMessageHandler, splitMessage, safeSendMarkdown } from "../bot/handlers/message.js";
import { HeartbeatManager } from "./heartbeat.js";
import { GarbageCollector } from "./gc.js";
import type { PluginManager } from "../plugins/manager.js";
import { toSdkMcpServers } from "../mcp/index.js";

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

    // Resolve enabled MCP servers from config (strips metadata, expands ${VAR})
    const mcpServers = toSdkMcpServers(config.app.mcp);
    const mcpServerCount = mcpServers ? Object.keys(mcpServers).length : 0;
    if (mcpServerCount > 0) {
      console.log(`  ▸ MCP servers enabled: ${Object.keys(mcpServers!).join(", ")}`);
    }

    // 9. Create AI session pool with model, plugin tools, and MCP servers
    console.log(`  ▸ Creating AI session pool (model: ${currentModel}, sessions: ${poolSize})…`);
    await sessionManager.createSession(currentModel, pluginTools, poolSize, mcpServers);

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

    // Provide heartbeat hooks with access to plugin tools (e.g. gmail__search_threads)
    heartbeatManager.setContextProvider(async () => ({
      callTool: pluginManager.callTool.bind(pluginManager),
    }));

    /**
     * Runs one or all heartbeat events on demand and delivers results in-chat.
     * Replies are threaded to the user's original /heartbeat command message.
     */
    const runHeartbeatOnDemand = async (ctx: Context, eventName?: string) => {
      const replyToId = ctx.message?.message_id;
      const replyOpts = replyToId
        ? { reply_parameters: { message_id: replyToId } } as Record<string, unknown>
        : {};

      const allEvents = await heartbeatManager.listEvents();

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
            const notifyText = await heartbeatManager.runEvent(
              event,
              (prompt) => sessionManager.sendEphemeral(prompt),
            );

            if (!notifyText) {
              await ctx.reply(`⚠️ Heartbeat "${event.name}" returned no response.`, replyOpts);
              continue;
            }

            const header = `💓 *Heartbeat: ${event.name}*\n\n`;
            const chunks = splitMessage(header + notifyText);
            for (const chunk of chunks) {
              await safeSendMarkdown(
                (text, extra) => ctx.reply(text, extra as Parameters<typeof ctx.reply>[1]),
                chunk,
                replyOpts as Record<string, unknown>,
              );
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

        case "update": {
          await safeSendMarkdown(
            (text, extra) => ctx.reply(text, { ...extra, ...replyOpts }),
            "🔍 Checking for updates…",
          );
          const result = await heartbeatManager.checkForUpdates();
          if (!result) {
            await safeSendMarkdown(
              (text, extra) => ctx.reply(text, { ...extra, ...replyOpts }),
              "⚠️ Could not reach the npm registry. Try again later.",
            );
          } else if (result.updateAvailable) {
            await safeSendMarkdown(
              (text, extra) => ctx.reply(text, {
                ...extra,
                ...replyOpts,
                ...Markup.inlineKeyboard([
                  Markup.button.callback("📦 Update Now", `self_update:${result.latestVersion}`),
                ]),
              }),
              `📦 *Update available: v${result.latestVersion}*\n\n` +
                `You're running v${result.currentVersion}.`,
            );
          } else {
            await safeSendMarkdown(
              (text, extra) => ctx.reply(text, { ...extra, ...replyOpts }),
              `✅ You're up to date! (v${result.currentVersion})`,
            );
          }
          break;
        }

        case "help":
          await ctx.reply(
            "🤖 *Co\\-Assistant Commands*\n\n" +
            "/start — Welcome message\n" +
            "/model \\[name\\] — View or change AI model\n" +
            "/plugins — List plugins and their status\n" +
            "/enable \\<plugin\\> — Enable a plugin\n" +
            "/disable \\<plugin\\> — Disable a plugin\n" +
            "/clear — Clear conversation and reset AI context\n" +
            "/heartbeat \\[name\\] — Run heartbeat event\\(s\\)\n" +
            "/hb \\[name\\] — Shorthand for /heartbeat\n" +
            "/mcp — List configured MCP servers\n" +
            "/update — Check for updates \\(tap to self\\-update\\)\n" +
            "/help — Show this message\n\n" +
            "Or just send a message to chat with the AI\\.",
            { parse_mode: "MarkdownV2", ...replyOpts } as Record<string, unknown>,
          );
          break;

        case "mcp": {
          const mcpConfig = config.app.mcp;
          const servers = mcpConfig?.servers ?? {};
          const serverEntries = Object.entries(servers);

          if (serverEntries.length === 0) {
            await ctx.reply(
              "🔌 No MCP servers configured.\n\nAdd one with: co-assistant mcp add",
              replyOpts,
            );
            break;
          }

          const lines = serverEntries.map(([id, srv]) => {
            const statusIcon = srv.enabled ? "✅" : "❌";
            const typeLabel = srv.type === "local" || srv.type === "stdio"
              ? `stdio: ${srv.command}`
              : `${srv.type}: ${srv.url}`;
            return `${statusIcon} *${id}* — ${srv.name}\n   ${typeLabel}`;
          });

          await safeSendMarkdown(
            (text, extra) => ctx.reply(text, { ...extra, ...replyOpts }),
            `🔌 *MCP Servers* (${serverEntries.length} configured)\n\n${lines.join("\n\n")}`,
          );
          break;
        }

        case "clear": {
          const count = conversationRepo.count();
          conversationRepo.clear();
          sessionManager.resetSessions().catch((err: unknown) => {
            this.logger.error({ err }, "Background session rebuild failed after /clear");
          });
          await ctx.reply(
            `✅ Context cleared.\n` +
              `• ${count} message${count !== 1 ? "s" : ""} deleted from history\n` +
              `• AI sessions rebuilding in background`,
            replyOpts,
          );
          break;
        }

        case "start": {
          const currentModel = modelRegistry.getCurrentModelId();
          const pluginList = pluginManager.getPluginInfoList();
          const activePluginIds = pluginList
            .filter((p) => p.enabled && p.status === "active")
            .map((p) => p.id);
          const activeList = activePluginIds.length > 0 ? activePluginIds.join(", ") : "none";
          await ctx.reply(
            `👋 Welcome to Co-Assistant!\n\n` +
              `I'm your AI-powered personal assistant. Send me any message and I'll help you out.\n\n` +
              `Use /help to see available commands.\n` +
              `Current model: ${currentModel}\n` +
              `Active plugins: ${activeList}`,
            replyOpts,
          );
          break;
        }

        case "model": {
          const modelArg = args.trim();
          if (!modelArg) {
            const currentId = modelRegistry.getCurrentModelId();
            const models = modelRegistry.getAvailableModels();
            const list = models
              .map((m) => `${m.id === currentId ? "▸ " : "  "}${m.id} — ${m.description}`)
              .join("\n");
            await ctx.reply(`🤖 Current model: ${currentId}\n\nAvailable models:\n${list}`, replyOpts);
          } else {
            modelRegistry.setCurrentModel(modelArg);
            try {
              await sessionManager.switchModel(modelArg);
              await ctx.reply(`✅ Model switched to ${modelArg}`, replyOpts);
            } catch (switchErr: unknown) {
              const reason = switchErr instanceof Error ? switchErr.message : String(switchErr);
              this.logger.error({ err: switchErr, modelId: modelArg }, "Failed to switch model session");
              await ctx.reply(
                `⚠️ Model preference updated to ${modelArg}, but session rebuild failed: ${reason}`,
                replyOpts,
              );
            }
          }
          break;
        }

        case "plugins": {
          const pluginInfoList = pluginManager.getPluginInfoList();
          if (pluginInfoList.length === 0) {
            await ctx.reply("🔌 No plugins discovered.", replyOpts);
          } else {
            const lines = pluginInfoList.map((p) => {
              const icon = p.enabled && p.status === "active" ? "✅" : "❌";
              const toolInfo =
                p.enabled && p.status === "active"
                  ? `[${p.tools.length} tool${p.tools.length !== 1 ? "s" : ""}]`
                  : "[disabled]";
              return `${icon} ${p.id} (v${p.version}) - ${p.name} ${toolInfo}`;
            });
            await ctx.reply(`🔌 Plugins:\n${lines.join("\n")}`, replyOpts);
          }
          break;
        }

        case "enable": {
          const enableTarget = args.trim();
          if (!enableTarget) {
            await ctx.reply("Usage: /enable <plugin>", replyOpts);
          } else {
            await pluginManager.enablePlugin(enableTarget);
            await ctx.reply(`✅ Plugin "${enableTarget}" has been enabled.`, replyOpts);
          }
          break;
        }

        case "disable": {
          const disableTarget = args.trim();
          if (!disableTarget) {
            await ctx.reply("Usage: /disable <plugin>", replyOpts);
          } else {
            await pluginManager.disablePlugin(disableTarget);
            await ctx.reply(`✅ Plugin "${disableTarget}" has been disabled.`, replyOpts);
          }
          break;
        }

        default:
          await ctx.reply("❓ Unknown command. Use /help to see available commands.", replyOpts);
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

    // Register inline keyboard callback handler for self-update action
    bot.getBot().action(/^self_update:(.+)$/, async (ctx) => {
      const version = ctx.match[1];
      await ctx.answerCbQuery();

      try {
        await ctx.editMessageText(
          `⏳ Updating to v${version}…\n\nRunning: npm install -g @hmawla/co-assistant@latest`,
        );

        // Run npm install in a child process
        const npmResult = await new Promise<{ code: number; output: string }>((resolve) => {
          const chunks: string[] = [];
          const child = spawn("npm", ["install", "-g", "@hmawla/co-assistant@latest"], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          });

          child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
          child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
          child.on("close", (code) => resolve({ code: code ?? 1, output: chunks.join("") }));
          child.on("error", (err) => resolve({ code: 1, output: err.message }));
        });

        if (npmResult.code !== 0) {
          this.logger.error({ output: npmResult.output }, "npm install failed during self-update");
          await ctx.editMessageText(
            `❌ Update failed (exit code ${npmResult.code}).\n\n` +
              `Try manually:\nnpm install -g @hmawla/co-assistant@latest`,
          );
          return;
        }

        this.logger.info({ version }, "Self-update completed — restarting");
        await ctx.editMessageText(
          `✅ Updated to v${version}!\n\n🔄 Restarting Co-Assistant…`,
        );

        // Give Telegram time to deliver the message, then re-exec
        setTimeout(() => {
          const args = process.argv.slice(1);
          const child = spawn(process.argv[0]!, args, {
            detached: true,
            stdio: "inherit",
            env: process.env,
          });
          child.unref();
          process.exit(0);
        }, 1000);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error({ err }, "Self-update failed");
        try {
          await ctx.editMessageText(
            `❌ Update failed: ${reason}\n\nTry manually:\nnpm install -g @hmawla/co-assistant@latest`,
          );
        } catch { /* ignore edit failure */ }
      }
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
    if (mcpServerCount > 0) {
      console.log(`  MCP:     ${Object.keys(mcpServers!).join(", ")} (${mcpServerCount} server${mcpServerCount === 1 ? "" : "s"})`);
    }

    // 12. Start heartbeat scheduler
    const heartbeatInterval = parseInt(config.env.HEARTBEAT_INTERVAL_MINUTES || "0", 10);
    const heartbeatEvents = await heartbeatManager.listEvents();

    if (heartbeatInterval > 0 && heartbeatEvents.length > 0) {
      await heartbeatManager.start(
        heartbeatInterval,
        // Use an ephemeral (disposable) session per heartbeat run — zero
        // conversation history prevents the AI from hallucinating stale data.
        async (prompt) => sessionManager.sendEphemeral(prompt),
        // Forward the AI's response to the user via Telegram
        async (eventName, response, extraOpts) => {
          try {
            const chatId = config.env.TELEGRAM_USER_ID;
            const header = `💓 *Heartbeat: ${eventName}*\n\n`;
            const fullMessage = header + response;

            // Split long responses to respect Telegram's 4096-char limit
            const chunks = splitMessage(fullMessage);
            for (let i = 0; i < chunks.length; i++) {
              await safeSendMarkdown(
                (text, extra) => bot.getBot().telegram.sendMessage(chatId, text, {
                  ...extra,
                  // Attach extra opts (e.g. inline keyboard) to the last chunk only
                  ...(i === chunks.length - 1 ? extraOpts : {}),
                }),
                chunks[i]!,
              );
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

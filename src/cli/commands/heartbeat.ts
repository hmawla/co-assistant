/**
 * @module cli/commands/heartbeat
 * @description CLI commands for managing heartbeat events — scheduled prompts
 * that the AI agent processes at a configurable interval.
 *
 * Subcommands:
 * - `heartbeat list`            — List all heartbeat events
 * - `heartbeat add`             — Add a new heartbeat event (interactive)
 * - `heartbeat remove <name>`   — Remove a heartbeat event
 * - `heartbeat show <name>`     — Show a heartbeat event's prompt
 * - `heartbeat run [name]`      — Run a heartbeat on demand (boots AI, sends to Telegram)
 */

import { Command } from "commander";
import { HeartbeatManager } from "../../core/heartbeat.js";
import { promptText } from "../../utils/prompt.js";

/**
 * Registers the `heartbeat` subcommand group on the given Commander program.
 *
 * @param program - The root Commander {@link Command} instance.
 */
export function registerHeartbeatCommand(program: Command): void {
  const heartbeat = program
    .command("heartbeat")
    .description("Manage heartbeat events (scheduled AI prompts)");

  // ── heartbeat list ─────────────────────────────────────────────────────
  heartbeat
    .command("list")
    .description("List all heartbeat events")
    .action(() => {
      const manager = new HeartbeatManager();
      const events = manager.listEvents();

      if (events.length === 0) {
        console.log("\n  No heartbeat events found.");
        console.log("  Add one with: co-assistant heartbeat add\n");
        return;
      }

      console.log(`\n  📋 Heartbeat Events (${events.length}):`);
      console.log("  ─────────────────────────────");
      for (const event of events) {
        // Show first line of prompt as preview
        const preview = event.prompt.split("\n")[0]?.slice(0, 60) ?? "";
        const ellipsis = event.prompt.length > 60 ? "…" : "";
        console.log(`    • ${event.name}`);
        console.log(`      "${preview}${ellipsis}"`);
      }
      console.log("");
    });

  // ── heartbeat add ──────────────────────────────────────────────────────
  heartbeat
    .command("add")
    .description("Add a new heartbeat event")
    .action(async () => {
      const manager = new HeartbeatManager();

      console.log("\n  📝 Add Heartbeat Event");
      console.log("  ──────────────────────");
      console.log("  Heartbeat events are prompts sent to the AI agent on a schedule.\n");

      const name = await promptText("  Event name (e.g. morning-briefing)");
      if (!name) {
        console.log("  ⚠ Name cannot be empty.");
        return;
      }

      console.log("\n  Enter the prompt for this heartbeat event.");
      console.log("  This is what the AI will process on each interval.\n");

      const prompt = await promptText("  Prompt");
      if (!prompt) {
        console.log("  ⚠ Prompt cannot be empty.");
        return;
      }

      try {
        manager.addEvent(name, prompt);
        console.log(`\n  ✓ Heartbeat event "${name}" created.`);
        console.log(`  File: heartbeats/${name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}.heartbeat.md\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  ✗ ${msg}\n`);
      }
    });

  // ── heartbeat remove ───────────────────────────────────────────────────
  heartbeat
    .command("remove <name>")
    .description("Remove a heartbeat event by name")
    .action((name: string) => {
      const manager = new HeartbeatManager();

      try {
        manager.removeEvent(name);
        console.log(`\n  ✓ Heartbeat event "${name}" removed.\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n  ✗ ${msg}\n`);
      }
    });

  // ── heartbeat show ─────────────────────────────────────────────────────
  heartbeat
    .command("show <name>")
    .description("Show a heartbeat event's prompt")
    .action((name: string) => {
      const manager = new HeartbeatManager();
      const events = manager.listEvents();
      const event = events.find((e) => e.name === name);

      if (!event) {
        console.error(`\n  ✗ Heartbeat event "${name}" not found.`);
        const names = events.map((e) => e.name);
        if (names.length > 0) {
          console.error(`  Available: ${names.join(", ")}`);
        }
        console.error("");
        return;
      }

      console.log(`\n  📋 ${event.name}`);
      console.log("  ─────────────────────────────");
      console.log(`  File: ${event.filePath}`);
      console.log("");
      // Indent each line of the prompt
      for (const line of event.prompt.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");
    });

  // ── heartbeat run ──────────────────────────────────────────────────────
  heartbeat
    .command("run [name]")
    .description("Run heartbeat(s) on demand — boots AI, sends results to Telegram")
    .option("--no-telegram", "Print results to console only, don't send to Telegram")
    .action(async (name: string | undefined, opts: { telegram: boolean }) => {
      const manager = new HeartbeatManager();
      const allEvents = manager.listEvents();

      if (allEvents.length === 0) {
        console.log("\n  No heartbeat events found.");
        console.log("  Add one with: co-assistant heartbeat add\n");
        return;
      }

      // Resolve which events to run
      let eventsToRun = allEvents;
      if (name) {
        const event = allEvents.find((e) => e.name === name);
        if (!event) {
          console.error(`\n  ✗ Heartbeat event "${name}" not found.`);
          const names = allEvents.map((e) => e.name);
          if (names.length > 0) console.error(`  Available: ${names.join(", ")}`);
          console.error("");
          return;
        }
        eventsToRun = [event];
      }

      console.log(`\n  🚀 Running ${eventsToRun.length} heartbeat event(s) on demand…\n`);

      // Lazy-import heavy modules so list/add/remove/show stay fast
      const { getConfig } = await import("../../core/config.js");
      const { copilotClient } = await import("../../ai/client.js");
      const { sessionManager } = await import("../../ai/session.js");
      const { splitMessage } = await import("../../bot/handlers/message.js");

      let config;
      try {
        config = getConfig();
      } catch {
        console.error("  ✗ Configuration not found. Run `co-assistant setup` first.\n");
        return;
      }

      // Boot AI client + session
      console.log("  ▸ Starting Copilot SDK client…");
      try {
        await copilotClient.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ Failed to start Copilot client: ${msg}\n`);
        return;
      }

      const model = config.env.DEFAULT_MODEL || "gpt-4.1";
      console.log(`  ▸ Creating AI session (model: ${model})…`);
      try {
        await sessionManager.createSession(model, undefined, 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ Failed to create AI session: ${msg}\n`);
        await copilotClient.stop();
        return;
      }

      // Optionally set up Telegram for delivery
      let telegram: { sendMessage: (chatId: string | number, text: string, extra?: Record<string, unknown>) => Promise<unknown> } | null = null;
      if (opts.telegram && config.env.TELEGRAM_BOT_TOKEN) {
        try {
          const { Telegraf } = await import("telegraf");
          const tgBot = new Telegraf(config.env.TELEGRAM_BOT_TOKEN);
          telegram = tgBot.telegram;
        } catch {
          console.log("  ⚠ Could not initialize Telegram — results will print to console only.");
        }
      }

      // Run each event
      for (const event of eventsToRun) {
        console.log(`  ────────────────────────────────────`);
        console.log(`  💓 Running: ${event.name}`);

        // Inject dedup state
        const useDedup = event.prompt.includes("{{DEDUP_STATE}}");
        const state = useDedup ? manager.loadState(event.name) : null;
        const finalPrompt = state
          ? event.prompt.replace(
              "{{DEDUP_STATE}}",
              state.processedIds.length > 0
                ? `Previously processed IDs (${state.processedIds.length} total) — SKIP these:\n${state.processedIds.map((id) => `- ${id}`).join("\n")}`
                : "No previously processed items — this is the first run.",
            )
          : event.prompt;

        try {
          console.log("  ▸ Sending prompt to AI…");
          const response = await sessionManager.sendMessage(finalPrompt);

          if (!response) {
            console.log("  ⚠ No response from AI.\n");
            continue;
          }

          // Extract and persist dedup IDs
          const processedMarkerRe = /<!--\s*PROCESSED:\s*(.*?)\s*-->/gi;
          if (useDedup && state) {
            let match: RegExpExecArray | null;
            const newIds: string[] = [];
            while ((match = processedMarkerRe.exec(response)) !== null) {
              for (const id of (match[1] ?? "").split(",")) {
                const trimmed = id.trim();
                if (trimmed) newIds.push(trimmed);
              }
            }
            processedMarkerRe.lastIndex = 0;

            if (newIds.length > 0) {
              // Deduplicate against existing IDs before persisting
              const existing = new Set(state.processedIds);
              const uniqueNew = newIds.filter((id) => !existing.has(id));
              if (uniqueNew.length > 0) {
                state.processedIds.push(...uniqueNew);
                state.lastRun = new Date().toISOString();
                manager.saveState(event.name, state);
                console.log(`  ✓ Dedup: recorded ${uniqueNew.length} new IDs`);
              }
            }
          }

          // Clean the marker from display/delivery
          const cleanResponse = response.replace(/<!--\s*PROCESSED:\s*.*?\s*-->/gi, "").trim();

          // Print to console
          console.log("\n  ── AI Response ──────────────────────");
          for (const line of cleanResponse.split("\n")) {
            console.log(`  ${line}`);
          }
          console.log("  ─────────────────────────────────────\n");

          // Send to Telegram
          if (telegram) {
            try {
              const chatId = config.env.TELEGRAM_USER_ID;
              const header = `💓 *Heartbeat: ${event.name}*\n\n`;
              const chunks = splitMessage(header + cleanResponse);
              for (const chunk of chunks) {
                await telegram.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
              }
              console.log("  ✓ Sent to Telegram");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.log(`  ⚠ Failed to send to Telegram: ${msg}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ Failed: ${msg}\n`);
        }
      }

      // Cleanup
      console.log("\n  ▸ Shutting down…");
      try { await sessionManager.closeSession(); } catch { /* ignore */ }
      try { await copilotClient.stop(); } catch { /* ignore */ }
      console.log("  ✓ Done.\n");
    });
}

/**
 * @module core/heartbeat
 * @description Scheduled heartbeat prompt system with deduplication support.
 *
 * Reads `.heartbeat.md` files from the `heartbeats/` directory and sends each
 * prompt to the AI session at a configurable interval. Responses are forwarded
 * to the user via the Telegram bot.
 *
 * **Deduplication**: Heartbeat prompts can include a `{{DEDUP_STATE}}` placeholder.
 * When present, the manager injects previously-processed item IDs into the prompt
 * so the AI skips them. The AI must output a `<!-- PROCESSED: id1, id2 -->` marker
 * in its response; those IDs are persisted in a companion `.state.json` file and
 * injected on subsequent runs.
 *
 * Example file: `heartbeats/morning-briefing.heartbeat.md`
 * ```
 * Summarize my unread emails and today's calendar events.
 * ```
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Logger } from "pino";
import { createChildLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory containing heartbeat prompt files. */
const HEARTBEATS_DIR = "./heartbeats";

/** File extension for heartbeat prompt files. */
const HEARTBEAT_EXT = ".heartbeat.md";

/** Extension for per-event deduplication state files. */
const STATE_EXT = ".state.json";

/** Placeholder token in prompts that gets replaced with dedup context. */
const DEDUP_PLACEHOLDER = "{{DEDUP_STATE}}";

/** Maximum number of processed IDs to retain per event (prevents unbounded growth). */
const MAX_STATE_IDS = 200;

/** Regex to extract processed IDs from the AI response. */
const PROCESSED_MARKER_RE = /<!--\s*PROCESSED:\s*(.*?)\s*-->/gi;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single heartbeat event loaded from disk. */
export interface HeartbeatEvent {
  /** Event name derived from the filename (e.g. "morning-briefing"). */
  name: string;
  /** The prompt text sent to the AI agent. */
  prompt: string;
  /** Absolute path to the source file. */
  filePath: string;
}

/**
 * Callback invoked for each heartbeat prompt execution.
 *
 * @param prompt - The prompt text to send to the AI.
 * @returns The AI's response text, or null if the send failed.
 */
export type HeartbeatSendFn = (prompt: string) => Promise<string | null>;

/**
 * Callback invoked to deliver the AI's response to the user.
 *
 * @param eventName - The heartbeat event name (for context).
 * @param response  - The AI's response text.
 */
export type HeartbeatNotifyFn = (eventName: string, response: string) => Promise<void>;

/**
 * Persisted deduplication state for a single heartbeat event.
 * Stored as a companion `.state.json` file alongside the `.heartbeat.md`.
 */
export interface HeartbeatState {
  /** IDs of items already processed (capped at {@link MAX_STATE_IDS}). */
  processedIds: string[];
  /** ISO timestamp of the last successful run. */
  lastRun: string | null;
}

// ---------------------------------------------------------------------------
// HeartbeatManager
// ---------------------------------------------------------------------------

/**
 * Manages scheduled heartbeat events — periodic AI prompts that run
 * automatically at a configured interval.
 *
 * Usage:
 * ```ts
 * const hb = new HeartbeatManager();
 * hb.start(intervalMinutes, sendFn, notifyFn);
 * // later…
 * hb.stop();
 * ```
 */
export class HeartbeatManager {
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  /** Prevents overlapping cycles when a run takes longer than the interval. */
  private cycleInProgress = false;

  constructor() {
    this.logger = createChildLogger("heartbeat");
    ensureHeartbeatsDir();
  }

  // -----------------------------------------------------------------------
  // File operations
  // -----------------------------------------------------------------------

  /**
   * Discover all heartbeat event files in the heartbeats directory.
   *
   * @returns Array of {@link HeartbeatEvent} objects, one per file.
   */
  listEvents(): HeartbeatEvent[] {
    ensureHeartbeatsDir();

    const files = readdirSync(HEARTBEATS_DIR).filter((f) => f.endsWith(HEARTBEAT_EXT));

    return files.map((file) => {
      const filePath = join(HEARTBEATS_DIR, file);
      const name = basename(file, HEARTBEAT_EXT);
      const prompt = readFileSync(filePath, "utf-8").trim();
      return { name, prompt, filePath };
    });
  }

  /**
   * Add a new heartbeat event by creating a `.heartbeat.md` file.
   *
   * @param name   - Event name (used as the filename, kebab-cased).
   * @param prompt - The prompt text to send to the AI on each heartbeat.
   * @throws {Error} If an event with the same name already exists.
   */
  addEvent(name: string, prompt: string): void {
    ensureHeartbeatsDir();

    const safeName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const filePath = join(HEARTBEATS_DIR, `${safeName}${HEARTBEAT_EXT}`);

    if (existsSync(filePath)) {
      throw new Error(`Heartbeat event "${safeName}" already exists at ${filePath}`);
    }

    writeFileSync(filePath, prompt.trim() + "\n", "utf-8");
    this.logger.info({ name: safeName, filePath }, "Heartbeat event created");
  }

  /**
   * Remove a heartbeat event by name.
   *
   * @param name - The event name to remove.
   * @throws {Error} If the event does not exist.
   */
  removeEvent(name: string): void {
    const safeName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const filePath = join(HEARTBEATS_DIR, `${safeName}${HEARTBEAT_EXT}`);

    if (!existsSync(filePath)) {
      throw new Error(`Heartbeat event "${safeName}" not found`);
    }

    unlinkSync(filePath);

    // Also remove companion state file if it exists
    const statePath = join(HEARTBEATS_DIR, `${safeName}${STATE_EXT}`);
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }

    this.logger.info({ name: safeName }, "Heartbeat event removed");
  }

  // -----------------------------------------------------------------------
  // Deduplication state
  // -----------------------------------------------------------------------

  /**
   * Load the persisted deduplication state for an event.
   *
   * @param eventName - The event name (kebab-cased, no extension).
   * @returns The stored state, or a fresh empty state if none exists.
   */
  loadState(eventName: string): HeartbeatState {
    const statePath = join(HEARTBEATS_DIR, `${eventName}${STATE_EXT}`);

    if (!existsSync(statePath)) {
      return { processedIds: [], lastRun: null };
    }

    try {
      const raw = readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HeartbeatState>;
      return {
        processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds : [],
        lastRun: parsed.lastRun ?? null,
      };
    } catch (err) {
      this.logger.warn({ err, eventName }, "Failed to parse state file — resetting");
      return { processedIds: [], lastRun: null };
    }
  }

  /**
   * Persist deduplication state for an event. Caps stored IDs at
   * {@link MAX_STATE_IDS} to prevent the file from growing unboundedly.
   *
   * @param eventName - The event name (kebab-cased, no extension).
   * @param state     - The state to persist.
   */
  saveState(eventName: string, state: HeartbeatState): void {
    const statePath = join(HEARTBEATS_DIR, `${eventName}${STATE_EXT}`);

    // Keep only the most recent IDs
    const trimmed: HeartbeatState = {
      processedIds: state.processedIds.slice(-MAX_STATE_IDS),
      lastRun: state.lastRun,
    };

    writeFileSync(statePath, JSON.stringify(trimmed, null, 2) + "\n", "utf-8");
    this.logger.debug({ eventName, idCount: trimmed.processedIds.length }, "State saved");
  }

  /**
   * Inject deduplication context into a prompt. If the prompt contains the
   * `{{DEDUP_STATE}}` placeholder, it is replaced with a block listing the
   * previously-processed IDs. If no placeholder is present, the prompt is
   * returned unchanged.
   *
   * @param prompt - The raw prompt text from the `.heartbeat.md` file.
   * @param state  - The loaded deduplication state.
   * @returns The prompt with dedup context injected.
   */
  private injectDedupContext(prompt: string, state: HeartbeatState): string {
    if (!prompt.includes(DEDUP_PLACEHOLDER)) {
      return prompt;
    }

    if (state.processedIds.length === 0) {
      return prompt.replace(DEDUP_PLACEHOLDER, "No previously processed items — this is the first run.");
    }

    const idList = state.processedIds.map((id) => `- ${id}`).join("\n");
    const context = [
      `Previously processed IDs (${state.processedIds.length} total) — SKIP these:`,
      idList,
    ].join("\n");

    return prompt.replace(DEDUP_PLACEHOLDER, context);
  }

  /**
   * Extract newly-processed item IDs from the AI's response. Looks for
   * `<!-- PROCESSED: id1, id2, id3 -->` markers anywhere in the text.
   *
   * @param response - The full AI response text.
   * @returns Array of extracted IDs (may be empty if no marker found).
   */
  private extractProcessedIds(response: string): string[] {
    const ids: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = PROCESSED_MARKER_RE.exec(response)) !== null) {
      const raw = match[1] ?? "";
      for (const id of raw.split(",")) {
        const trimmed = id.trim();
        if (trimmed) ids.push(trimmed);
      }
    }

    // Reset regex lastIndex for next call
    PROCESSED_MARKER_RE.lastIndex = 0;

    return ids;
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  /**
   * Start the heartbeat scheduler.
   *
   * Runs all heartbeat events immediately on first tick, then repeats at the
   * configured interval.
   *
   * @param intervalMinutes - Minutes between each heartbeat cycle.
   * @param sendFn          - Function that sends a prompt to the AI and returns the response.
   * @param notifyFn        - Function that delivers the AI response to the user.
   */
  start(
    intervalMinutes: number,
    sendFn: HeartbeatSendFn,
    notifyFn: HeartbeatNotifyFn,
  ): void {
    if (this.isRunning) {
      this.logger.warn("Heartbeat scheduler already running");
      return;
    }

    if (intervalMinutes <= 0) {
      this.logger.info("Heartbeat disabled (interval is 0)");
      return;
    }

    const events = this.listEvents();
    if (events.length === 0) {
      this.logger.info("No heartbeat events found — scheduler idle");
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    this.isRunning = true;

    this.logger.info(
      { intervalMinutes, eventCount: events.length },
      `Heartbeat scheduler started (every ${intervalMinutes} min, ${events.length} events)`,
    );

    // Execute the heartbeat cycle with deduplication support
    const runCycle = async () => {
      // Guard: skip if a previous cycle is still running
      if (this.cycleInProgress) {
        this.logger.debug("Skipping heartbeat cycle — previous cycle still in progress");
        return;
      }
      this.cycleInProgress = true;

      try {
        const currentEvents = this.listEvents();
        if (currentEvents.length === 0) return;

        this.logger.debug({ count: currentEvents.length }, "Running heartbeat cycle");

        for (const event of currentEvents) {
          try {
            this.logger.debug({ event: event.name }, `Executing heartbeat: ${event.name}`);

            // Load dedup state and inject into prompt if placeholder present
            const useDedup = event.prompt.includes(DEDUP_PLACEHOLDER);
            const state = useDedup ? this.loadState(event.name) : null;
            const finalPrompt = state
              ? this.injectDedupContext(event.prompt, state)
              : event.prompt;

            const response = await sendFn(finalPrompt);

            if (response) {
              // Extract and persist newly processed IDs if dedup is active
              if (useDedup && state) {
                const newIds = this.extractProcessedIds(response);
                if (newIds.length > 0) {
                  // Deduplicate against existing IDs before persisting
                  const existing = new Set(state.processedIds);
                  const uniqueNew = newIds.filter((id) => !existing.has(id));
                  if (uniqueNew.length > 0) {
                    state.processedIds.push(...uniqueNew);
                    state.lastRun = new Date().toISOString();
                    this.saveState(event.name, state);
                    this.logger.info(
                      { event: event.name, newIds: uniqueNew.length, totalIds: state.processedIds.length },
                      `Dedup: recorded ${uniqueNew.length} new IDs for "${event.name}"`,
                    );
                  }
                }
              }

              // Strip the PROCESSED marker from the message sent to the user
              const cleanResponse = response.replace(PROCESSED_MARKER_RE, "").trim();
              PROCESSED_MARKER_RE.lastIndex = 0;

              if (cleanResponse) {
                await notifyFn(event.name, cleanResponse);
                this.logger.info({ event: event.name }, `Heartbeat "${event.name}" completed — notified user`);
              } else {
                this.logger.info({ event: event.name }, `Heartbeat "${event.name}" completed — nothing actionable, suppressed`);
              }
            } else {
              this.logger.warn({ event: event.name }, `Heartbeat "${event.name}" returned no response`);
            }
          } catch (err) {
            this.logger.error(
              { err, event: event.name },
              `Heartbeat "${event.name}" failed`,
            );
          }
        }
      } finally {
        this.cycleInProgress = false;
      }
    };

    // Schedule recurring execution (first run after one interval)
    this.timer = setInterval(() => {
      runCycle().catch((err) => {
        this.logger.error({ err }, "Heartbeat cycle failed");
      });
    }, intervalMs);
  }

  /**
   * Stop the heartbeat scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.cycleInProgress = false;
    this.logger.info("Heartbeat scheduler stopped");
  }

  /**
   * Check whether the scheduler is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ensure the heartbeats directory exists. */
function ensureHeartbeatsDir(): void {
  if (!existsSync(HEARTBEATS_DIR)) {
    mkdirSync(HEARTBEATS_DIR, { recursive: true });
  }
}

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
 * **Hooks**: Each heartbeat can optionally supply a `.heartbeat.hooks.mjs` module.
 * The engine always loads deduplication state before calling hooks:
 * - `preAgentCall(state)` — receives the engine-loaded {@link HeartbeatState}; returns
 *   data passed to later steps, or `null` to abort the pipeline.
 * - `postAgentCall(preData, agentResponse)` — returns `{ newState, response }`.
 *   The engine persists `newState` (when non-null) and sends `response` to the user
 *   (when non-null). Hook modules do not need to call `saveState` themselves.
 *
 * **Null-abort**: If a `preAgentCall` hook returns `null`, the pipeline is aborted
 * immediately — the AI agent is not called and no notification is sent.
 *
 * **Update checker**: A built-in check runs alongside heartbeat events. It queries
 * the npm registry for the latest published version and notifies the user once
 * when a newer version is available (no AI tokens consumed).
 *
 * Example file: `heartbeats/morning-briefing.heartbeat.md`
 * ```
 * Summarize my unread emails and today's calendar events.
 * ```
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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

/** File extension for per-event hook modules. */
const HOOKS_EXT = ".heartbeat.hooks.mjs";

/** Placeholder token in prompts that gets replaced with pre-agent data JSON. */
const PRE_AGENT_DATA_PLACEHOLDER = "{{PRE_AGENT_DATA}}";

/** Maximum number of processed IDs to retain per event (prevents unbounded growth). */
const MAX_STATE_IDS = 200;

/** Regex to extract processed IDs from the AI response. */
const PROCESSED_MARKER_RE = /<!--\s*PROCESSED:\s*(.*?)\s*-->/gi;

/** npm package name used to query the registry for updates. */
const NPM_PACKAGE_NAME = "@hmawla/co-assistant";

/** State file for the built-in update checker (tracks last notified version). */
const UPDATE_CHECK_STATE = join(HEARTBEATS_DIR, "update-check.state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Optional hook functions that customise heartbeat execution.
 * Loaded from a sibling `.heartbeat.hooks.mjs` file when present.
 */
export interface HeartbeatHooks {
  /**
   * Run before the AI call. Receives the loaded dedup state and an optional
   * context object provided by the engine (e.g. `{ callTool, logger }` for invoking
   * plugin tools directly or emitting structured log entries).
   * Return data passed to later steps, or null to abort.
   * Returning `null` aborts the pipeline — the AI agent is not called and no notification is sent.
   */
  preAgentCall?: (state: HeartbeatState, context: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  /** Build the final prompt from pre-call data and the base prompt. */
  buildPrompt?: (preData: Record<string, unknown>, basePrompt: string) => Promise<string>;
  /**
   * Post-process the AI response. Return `newState` (saved by the engine) and
   * `response` (sent to user). Return null for either to skip that action.
   */
  postAgentCall?: (
    preData: Record<string, unknown>,
    agentResponse: string,
  ) => Promise<{ newState: HeartbeatState | null; response: string | null }>;
}

/** A single heartbeat event loaded from disk. */
export interface HeartbeatEvent {
  /** Event name derived from the filename (e.g. "morning-briefing"). */
  name: string;
  /** The prompt text sent to the AI agent. */
  prompt: string;
  /** Absolute path to the source file. */
  filePath: string;
  /** Optional hooks loaded from a sibling `.heartbeat.hooks.mjs` file. */
  hooks?: HeartbeatHooks;
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
export type HeartbeatNotifyFn = (eventName: string, response: string, extraOpts?: Record<string, unknown>) => Promise<void>;

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
  /** Optional provider that supplies extra context (e.g. `callTool`) to hook functions. */
  private contextProvider: (() => Promise<Record<string, unknown>>) | undefined = undefined;

  constructor() {
    this.logger = createChildLogger("heartbeat");
    ensureHeartbeatsDir();
  }

  /**
   * Register a provider that returns extra context passed to `preAgentCall` hooks.
   *
   * Typically set at application startup so hooks can call plugin tools
   * (e.g. `context.callTool('gmail', 'search_threads', args)`).
   *
   * @param fn - Async factory that returns the context object for each run.
   */
  setContextProvider(fn: () => Promise<Record<string, unknown>>): void {
    this.contextProvider = fn;
  }

  // -----------------------------------------------------------------------
  // File operations
  // -----------------------------------------------------------------------

  /**
   * Discover all heartbeat event files in the heartbeats directory.
   * If a sibling `.heartbeat.hooks.mjs` file exists, it is dynamically
   * imported and its exports attached as hooks on the event.
   *
   * @returns Array of {@link HeartbeatEvent} objects, one per file.
   */
  async listEvents(): Promise<HeartbeatEvent[]> {
    ensureHeartbeatsDir();

    const files = readdirSync(HEARTBEATS_DIR).filter((f) => f.endsWith(HEARTBEAT_EXT));

    const events: HeartbeatEvent[] = [];
    for (const file of files) {
      const filePath = join(HEARTBEATS_DIR, file);
      const name = basename(file, HEARTBEAT_EXT);
      const prompt = readFileSync(filePath, "utf-8").trim();
      const event: HeartbeatEvent = { name, prompt, filePath };

      const hooksPath = filePath.replace(HEARTBEAT_EXT, HOOKS_EXT);
      if (existsSync(hooksPath)) {
        try {
          const hooksModule = await import(pathToFileURL(resolve(hooksPath)).href) as HeartbeatHooks;
          event.hooks = hooksModule;
        } catch (err) {
          this.logger.warn({ err, hooksPath }, "Failed to load hooks module — skipping hooks");
        }
      }

      events.push(event);
    }

    return events;
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
   * Execute a single heartbeat event through the full pipeline (pre → agent → post).
   *
   * Extracts the per-event pipeline logic shared between the scheduled cycle and
   * on-demand invocations so there is no duplicated pre/post/dedup logic.
   *
   * @param event  - The heartbeat event to run.
   * @param sendFn - Function that sends a prompt to the AI and returns the response.
   * @returns The notify text to deliver to the user, or null if suppressed.
   */
  async runEvent(event: HeartbeatEvent, sendFn: HeartbeatSendFn): Promise<string | null> {
    return this.runEventPipeline(event, sendFn);
  }

  /**
   * Internal pipeline for a single heartbeat event.
   * Called by both {@link runEvent} (on-demand) and the scheduled {@link start} cycle.
   */
  private async runEventPipeline(event: HeartbeatEvent, sendFn: HeartbeatSendFn): Promise<string | null> {
    this.logger.debug({ event: event.name }, `Executing heartbeat: ${event.name}`);

    // Load state for the event (always — needed to pass to preAgentCall)
    const state = this.loadState(event.name);

    // Build hook context once (shared across all hook steps in this run)
    const hookContext = this.contextProvider ? await this.contextProvider() : {};
    hookContext["logger"] = createChildLogger(this.logger, { component: `heartbeat:${event.name}` });

    // Step 1: Pre-agent call
    let preData: Record<string, unknown>;
    if (event.hooks?.preAgentCall) {
      const result = await event.hooks.preAgentCall(state, hookContext);
      if (result === null) {
        this.logger.debug({ event: event.name }, `Heartbeat "${event.name}" aborted by preAgentCall`);
        return null;
      }
      preData = result;
    } else {
      preData = {};
    }

    // Step 2: Build final prompt
    let finalPrompt: string;
    const useDedup = !event.hooks?.buildPrompt && event.prompt.includes(DEDUP_PLACEHOLDER);

    if (event.hooks?.buildPrompt) {
      finalPrompt = await event.hooks.buildPrompt(preData, event.prompt);
    } else if (event.prompt.includes(PRE_AGENT_DATA_PLACEHOLDER)) {
      finalPrompt = event.prompt.replace(PRE_AGENT_DATA_PLACEHOLDER, JSON.stringify(preData));
    } else {
      finalPrompt = useDedup
        ? this.injectDedupContext(event.prompt, state)
        : event.prompt;
    }

    // Step 3: Send prompt to AI
    const response = await sendFn(finalPrompt);

    // Step 4: Post-process response.
    // IMPORTANT: call postAgentCall even when response is empty so the hook can
    // still save state (e.g. mark threads as processed for deduplication).
    if (event.hooks?.postAgentCall) {
      const { newState, response: hookResponse } = await event.hooks.postAgentCall(preData, response ?? "");
      if (newState !== null) {
        this.saveState(event.name, newState);
      }
      if (!hookResponse) {
        this.logger.warn({ event: event.name }, `Heartbeat "${event.name}" returned no response`);
      }
      return hookResponse;
    }

    if (!response) {
      this.logger.warn({ event: event.name }, `Heartbeat "${event.name}" returned no response`);
      return null;
    }

    // Backward compat: extract/save processed IDs and strip PROCESSED marker
    if (useDedup) {
      const newIds = this.extractProcessedIds(response);
      if (newIds.length > 0) {
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

    const cleanResponse = response.replace(PROCESSED_MARKER_RE, "").trim();
    PROCESSED_MARKER_RE.lastIndex = 0;
    return cleanResponse || null;
  }

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
  async start(
    intervalMinutes: number,
    sendFn: HeartbeatSendFn,
    notifyFn: HeartbeatNotifyFn,
  ): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Heartbeat scheduler already running");
      return;
    }

    if (intervalMinutes <= 0) {
      this.logger.info("Heartbeat disabled (interval is 0)");
      return;
    }

    const events = await this.listEvents();
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
        const currentEvents = await this.listEvents();
        if (currentEvents.length === 0) return;

        this.logger.debug({ count: currentEvents.length }, "Running heartbeat cycle");

        for (const event of currentEvents) {
          try {
            const notifyText = await this.runEventPipeline(event, sendFn);

            // Notify user
            if (notifyText) {
              await notifyFn(event.name, notifyText);
              this.logger.info({ event: event.name }, `Heartbeat "${event.name}" completed — notified user`);
            } else {
              this.logger.info({ event: event.name }, `Heartbeat "${event.name}" completed — nothing actionable, suppressed`);
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

      // Run the update checker in parallel (non-blocking, never throws)
      this.checkForUpdates(notifyFn).catch((err) => {
        this.logger.debug({ err }, "Update check failed (non-critical)");
      });
    }, intervalMs);
  }

  // -----------------------------------------------------------------------
  // Built-in: update checker
  // -----------------------------------------------------------------------

  /**
   * Check the npm registry for a newer version of Co-Assistant. Notifies
   * the user exactly once per new version by persisting the last-notified
   * version to a state file. No AI tokens are consumed.
   *
   * @param notifyFn - Function that delivers a message to the user.
   */
  /**
   * Check the npm registry for a newer version of Co-Assistant. Notifies
   * the user exactly once per new version by persisting the last-checked
   * version to a state file. No AI tokens are consumed.
   *
   * The state file is always written after a successful registry check so
   * that subsequent cycles skip the notification even if the first notify
   * call fails.
   *
   * @param notifyFn - Function that delivers a message to the user, or null to skip notification (used by /update command).
   * @returns Object with check results, or null if the check could not run.
   */
  async checkForUpdates(notifyFn?: HeartbeatNotifyFn | null): Promise<{
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  } | null> {
    try {
      // Read our current version from package.json
      const currentVersion = this.getCurrentVersion();
      if (!currentVersion) return null;

      // Fetch latest version from npm (5s timeout to avoid blocking)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let res: Response;
      try {
        res = await fetch(
          `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
          { signal: controller.signal, headers: { Accept: "application/json" } },
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        this.logger.debug({ status: res.status }, "npm registry returned non-OK (skipping update check)");
        return null;
      }

      const data = (await res.json()) as { version?: string };
      const latestVersion = data.version;
      if (!latestVersion) return null;

      const updateAvailable = isNewerVersion(currentVersion, latestVersion);

      if (!updateAvailable) {
        // Up to date — persist current version so the state file always exists
        this.saveUpdateCheckState(currentVersion);
        this.logger.debug({ currentVersion, latestVersion }, "Co-Assistant is up to date");
        return { currentVersion, latestVersion, updateAvailable: false };
      }

      // Check if we already notified for this version (skip for manual /update checks)
      const lastNotified = this.loadUpdateCheckState();
      if (notifyFn && lastNotified === latestVersion) {
        this.logger.debug({ latestVersion }, "Already notified about this version — skipping");
        return { currentVersion, latestVersion, updateAvailable: true };
      }

      // Persist before notifying — ensures we don't spam on notify failure
      this.saveUpdateCheckState(latestVersion);

      // Notify the user (if notifyFn provided) with an inline "Update Now" button
      if (notifyFn) {
        const message =
          `📦 *Update available: v${latestVersion}*\n\n` +
          `You're running v${currentVersion}.`;

        await notifyFn("update-check", message, {
          reply_markup: {
            inline_keyboard: [[{ text: "📦 Update Now", callback_data: `self_update:${latestVersion}` }]],
          },
        });

        this.logger.info(
          { from: currentVersion, to: latestVersion },
          `Update notification sent (v${currentVersion} → v${latestVersion})`,
        );
      }

      return { currentVersion, latestVersion, updateAvailable: true };
    } catch (err) {
      // Non-critical — swallow and log at debug level
      this.logger.debug({ err }, "Update check failed");
      return null;
    }
  }

  /**
   * Read the current installed version from package.json.
   *
   * @returns The semver version string, or null if it cannot be determined.
   */
  private getCurrentVersion(): string | null {
    try {
      const require = createRequire(import.meta.url);
      const pkg = require("../../package.json") as { version?: string };
      return pkg.version ?? null;
    } catch {
      this.logger.debug("Could not read package.json for version check");
      return null;
    }
  }

  /**
   * Load the last version we notified the user about.
   *
   * @returns The semver string of the last notified version, or null.
   */
  private loadUpdateCheckState(): string | null {
    try {
      if (!existsSync(UPDATE_CHECK_STATE)) return null;
      const raw = JSON.parse(readFileSync(UPDATE_CHECK_STATE, "utf-8")) as {
        lastNotifiedVersion?: string;
      };
      return raw.lastNotifiedVersion ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist the version we just notified about so we don't repeat it.
   *
   * @param version - The semver string of the version that was notified.
   */
  private saveUpdateCheckState(version: string): void {
    ensureHeartbeatsDir();
    writeFileSync(
      UPDATE_CHECK_STATE,
      JSON.stringify({ lastNotifiedVersion: version, notifiedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf-8",
    );
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

/**
 * Compare two semver version strings. Returns true if `latest` is strictly
 * newer than `current`. Handles standard major.minor.patch format.
 *
 * @param current - The currently installed version (e.g. "1.0.11").
 * @param latest  - The latest published version (e.g. "1.1.0").
 * @returns True if `latest` > `current`.
 */
function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const c = parse(current);
  const l = parse(latest);

  for (let i = 0; i < Math.max(c.length, l.length); i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * @module core/gc
 * @description Periodic garbage collection and memory management.
 *
 * The {@link GarbageCollector} runs on a configurable interval and performs:
 * - **Conversation pruning** — deletes messages older than a retention window.
 * - **Plugin health pruning** — deletes health-check records past retention.
 * - **Memory stats logging** — logs heap and RSS usage for monitoring.
 *
 * Wired into the app lifecycle via {@link App.start} and {@link App.shutdown}.
 */

import type { Logger } from "pino";
import type Database from "better-sqlite3";
import { createChildLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default GC cycle interval in minutes. */
const DEFAULT_INTERVAL_MINUTES = 30;

/** Default conversation retention in days. */
const DEFAULT_CONVERSATION_RETENTION_DAYS = 30;

/** Default plugin health record retention in days. */
const DEFAULT_HEALTH_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// GarbageCollector
// ---------------------------------------------------------------------------

/** Configuration options for the garbage collector. */
export interface GCOptions {
  /** How often the GC runs, in minutes. 0 = disabled. */
  intervalMinutes?: number;
  /** How many days of conversation history to retain. */
  conversationRetentionDays?: number;
  /** How many days of plugin health records to retain. */
  healthRetentionDays?: number;
}

/**
 * Periodic garbage collector that prunes old database records and monitors
 * memory usage. Designed to prevent unbounded growth of SQLite tables and
 * surface memory pressure early.
 */
export class GarbageCollector {
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private db: Database.Database | null = null;

  private intervalMinutes: number;
  private conversationRetentionDays: number;
  private healthRetentionDays: number;

  constructor(options?: GCOptions) {
    this.logger = createChildLogger("gc");
    this.intervalMinutes = options?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    this.conversationRetentionDays = options?.conversationRetentionDays ?? DEFAULT_CONVERSATION_RETENTION_DAYS;
    this.healthRetentionDays = options?.healthRetentionDays ?? DEFAULT_HEALTH_RETENTION_DAYS;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the periodic GC timer.
   *
   * @param db - The SQLite database handle to prune.
   */
  start(db: Database.Database): void {
    this.db = db;

    if (this.intervalMinutes <= 0) {
      this.logger.info("Garbage collector disabled (interval = 0)");
      return;
    }

    // Run once immediately at startup to clean up any stale data
    this.runCycle();

    const intervalMs = this.intervalMinutes * 60_000;
    this.timer = setInterval(() => this.runCycle(), intervalMs);

    // Allow the process to exit even if the GC timer is still active
    if (this.timer.unref) this.timer.unref();

    this.logger.info(
      {
        intervalMinutes: this.intervalMinutes,
        conversationRetentionDays: this.conversationRetentionDays,
        healthRetentionDays: this.healthRetentionDays,
      },
      `GC started (every ${this.intervalMinutes} min)`,
    );
  }

  /**
   * Stop the periodic GC timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info("GC stopped");
    }
  }

  // -----------------------------------------------------------------------
  // GC cycle
  // -----------------------------------------------------------------------

  /**
   * Execute a single GC cycle: prune old records and log memory stats.
   */
  runCycle(): void {
    const start = Date.now();

    try {
      const conversationsPruned = this.pruneConversations();
      const healthPruned = this.prunePluginHealth();
      const memStats = this.getMemoryStats();

      const elapsed = Date.now() - start;

      this.logger.info(
        {
          conversationsPruned,
          healthPruned,
          heapUsedMB: memStats.heapUsedMB,
          rssMB: memStats.rssMB,
          elapsed,
        },
        `GC cycle complete — pruned ${conversationsPruned} conversations, ${healthPruned} health records (${elapsed}ms)`,
      );
    } catch (err) {
      this.logger.error({ err }, "GC cycle failed");
    }
  }

  // -----------------------------------------------------------------------
  // Pruning operations
  // -----------------------------------------------------------------------

  /**
   * Delete conversation messages older than the retention window.
   * @returns Number of rows deleted.
   */
  private pruneConversations(): number {
    if (!this.db) return 0;

    try {
      const result = this.db.prepare(
        `DELETE FROM conversations
         WHERE created_at < datetime('now', '-' || ? || ' days')`,
      ).run(this.conversationRetentionDays);

      return result.changes;
    } catch (err) {
      this.logger.error({ err }, "Failed to prune conversations");
      return 0;
    }
  }

  /**
   * Delete plugin health records older than the retention window.
   * @returns Number of rows deleted.
   */
  private prunePluginHealth(): number {
    if (!this.db) return 0;

    try {
      const result = this.db.prepare(
        `DELETE FROM plugin_health
         WHERE checked_at < datetime('now', '-' || ? || ' days')`,
      ).run(this.healthRetentionDays);

      return result.changes;
    } catch (err) {
      this.logger.error({ err }, "Failed to prune plugin health records");
      return 0;
    }
  }

  // -----------------------------------------------------------------------
  // Memory monitoring
  // -----------------------------------------------------------------------

  /**
   * Capture current process memory usage.
   * @returns Object with heap and RSS in megabytes.
   */
  getMemoryStats(): { heapUsedMB: number; heapTotalMB: number; rssMB: number; externalMB: number } {
    const mem = process.memoryUsage();
    return {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      externalMB: Math.round(mem.external / 1024 / 1024 * 10) / 10,
    };
  }
}

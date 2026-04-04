/**
 * @module storage/repositories/plugin-health
 * @description Repository for plugin health-check logging and querying.
 * Stores periodic health snapshots so the system can detect degraded plugins.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single plugin health-check record. */
export interface PluginHealthEntry {
  /** Auto-incremented primary key. */
  id: number;
  /** The unique plugin identifier. */
  plugin_id: string;
  /** Health status (`ok`, `error`, or `disabled`). */
  status: string;
  /** Optional error message when status is `error`. */
  error_message: string | null;
  /** ISO-8601 timestamp of the health check. */
  checked_at: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Repository for recording and querying plugin health status.
 */
export class PluginHealthRepository {
  private db: Database.Database;

  /** Create a new repository backed by the singleton database. */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Record a health-check result for a plugin.
   *
   * @param pluginId     - The unique plugin identifier.
   * @param status       - Health status (`ok`, `error`, or `disabled`).
   * @param errorMessage - Optional error details.
   */
  logHealth(pluginId: string, status: string, errorMessage?: string): void {
    this.db
      .prepare(
        "INSERT INTO plugin_health (plugin_id, status, error_message) VALUES (?, ?, ?)",
      )
      .run(pluginId, status, errorMessage ?? null);
  }

  /**
   * Retrieve the most recent health-check entries for a plugin.
   *
   * @param pluginId - The unique plugin identifier.
   * @param limit    - Maximum number of entries to return (default `10`).
   * @returns An array of {@link PluginHealthEntry} objects, newest first.
   */
  getRecentHealth(pluginId: string, limit: number = 10): PluginHealthEntry[] {
    return this.db
      .prepare(
        "SELECT id, plugin_id, status, error_message, checked_at FROM plugin_health WHERE plugin_id = ? ORDER BY checked_at DESC LIMIT ?",
      )
      .all(pluginId, limit) as PluginHealthEntry[];
  }

  /**
   * Count the number of `error` health entries for a plugin within a time window.
   *
   * @param pluginId     - The unique plugin identifier.
   * @param sinceMinutes - Look-back window in minutes (default `60`).
   * @returns The number of error entries in the window.
   */
  getFailureCount(pluginId: string, sinceMinutes: number = 60): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM plugin_health
         WHERE plugin_id = ? AND status = 'error'
           AND checked_at >= datetime('now', '-' || ? || ' minutes')`,
      )
      .get(pluginId, sinceMinutes) as { cnt: number };
    return row.cnt;
  }
}

/**
 * @module storage/repositories/plugin-state
 * @description Repository for plugin state persistence.
 * Allows plugins to store arbitrary key/value pairs scoped by plugin ID.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../database.js";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Repository for managing per-plugin key/value state in the database.
 */
export class PluginStateRepository {
  private db: Database.Database;

  /** Create a new repository backed by the singleton database. */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Retrieve a single value for a given plugin and key.
   *
   * @param pluginId - The unique plugin identifier.
   * @param key      - The state key.
   * @returns The stored value, or `null` if not found.
   */
  get(pluginId: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM plugin_state WHERE plugin_id = ? AND key = ?")
      .get(pluginId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Insert or update a state value for a plugin.
   *
   * @param pluginId - The unique plugin identifier.
   * @param key      - The state key.
   * @param value    - The value to store.
   */
  set(pluginId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_state (plugin_id, key, value, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(pluginId, key, value);
  }

  /**
   * Retrieve all key/value pairs for a plugin.
   *
   * @param pluginId - The unique plugin identifier.
   * @returns A plain object mapping keys to their string values.
   */
  getAll(pluginId: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM plugin_state WHERE plugin_id = ?")
      .all(pluginId) as { key: string; value: string }[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Delete a single state key for a plugin.
   *
   * @param pluginId - The unique plugin identifier.
   * @param key      - The state key to remove.
   */
  delete(pluginId: string, key: string): void {
    this.db
      .prepare("DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?")
      .run(pluginId, key);
  }

  /**
   * Remove all stored state for a specific plugin.
   *
   * @param pluginId - The unique plugin identifier.
   */
  clearPlugin(pluginId: string): void {
    this.db
      .prepare("DELETE FROM plugin_state WHERE plugin_id = ?")
      .run(pluginId);
  }
}

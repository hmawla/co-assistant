/**
 * @module storage/repositories/preferences
 * @description Repository for user preferences and settings persistence.
 * Provides a simple key/value store for application-wide settings.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../database.js";

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Repository for managing user preferences in the database.
 */
export class PreferencesRepository {
  private db: Database.Database;

  /** Create a new repository backed by the singleton database. */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Retrieve a preference value by key.
   *
   * @param key - The preference key.
   * @returns The stored value, or `null` if not found.
   */
  get(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Insert or update a preference value.
   *
   * @param key   - The preference key.
   * @param value - The value to store.
   */
  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      )
      .run(key, value);
  }

  /**
   * Retrieve all preferences as a plain object.
   *
   * @returns A record mapping each preference key to its value.
   */
  getAll(): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM preferences")
      .all() as { key: string; value: string }[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Delete a single preference by key.
   *
   * @param key - The preference key to remove.
   */
  delete(key: string): void {
    this.db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
  }
}

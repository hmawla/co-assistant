/**
 * @module storage/migrations/001-initial
 * @description Initial database migration: creates conversations, plugin_state, preferences,
 * and plugin_health tables with supporting indexes.
 */

import type { Migration } from "../database.js";

/** Initial schema migration for the co-assistant database. */
const migration: Migration = {
  id: "001-initial",
  up: `
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plugin_state (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plugin_id, key)
    );

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plugin_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'disabled')),
      error_message TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_plugin_health_plugin_id ON plugin_health(plugin_id);
  `,
};

export default migration;

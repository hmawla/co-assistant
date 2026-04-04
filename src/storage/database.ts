/**
 * @module storage/database
 * @description SQLite database initialization and connection management using better-sqlite3.
 * Provides a singleton database instance with WAL mode, automatic directory creation,
 * and a migration runner that tracks applied migrations in a `_migrations` table.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import initialMigration from "./migrations/001-initial.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A database migration descriptor. */
export interface Migration {
  /** Unique identifier for this migration (e.g. "001-initial"). */
  id: string;
  /** SQL statements to execute when applying the migration. */
  up: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default path for the SQLite database file. */
const DEFAULT_DB_PATH = "./data/co-assistant.db";

/** Ordered list of all migrations to apply. */
const MIGRATIONS: Migration[] = [initialMigration];

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Ensure the `_migrations` tracking table exists.
 *
 * @param db - The open database connection.
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Run all pending migrations inside individual transactions.
 *
 * Each migration is wrapped in its own transaction so that a failure in one
 * migration does not leave the database in a partially-migrated state for
 * previously-successful migrations.
 *
 * @param db - The open database connection.
 */
function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db);

  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map(
      (row) => row.id,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    const applyMigration = db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    });

    try {
      applyMigration();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Migration "${migration.id}" failed: ${message}`,
      );
    }
  }
}

/**
 * Returns the singleton `better-sqlite3` database instance.
 *
 * On first call the function:
 * 1. Creates the parent directory for the database file if it doesn't exist.
 * 2. Opens (or creates) the SQLite database.
 * 3. Enables WAL journal mode for better concurrent read performance.
 * 4. Runs any pending migrations.
 *
 * @param dbPath - Optional path override; defaults to `./data/co-assistant.db`.
 * @returns The open `Database` instance.
 */
export function getDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (instance) return instance;

  // Ensure the data directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  instance = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  instance.pragma("journal_mode = WAL");

  // Run pending migrations
  runMigrations(instance);

  return instance;
}

/**
 * Closes the singleton database connection for graceful shutdown.
 *
 * After calling this function, {@link getDatabase} will open a fresh
 * connection on its next invocation.
 */
export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

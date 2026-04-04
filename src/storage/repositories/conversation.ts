/**
 * @module storage/repositories/conversation
 * @description Repository for conversation message persistence operations.
 * Provides methods to add, retrieve, count, and clear conversation messages.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single conversation message row returned from the database. */
export interface ConversationMessage {
  /** Auto-incremented primary key. */
  id: number;
  /** The role of the message author (`user`, `assistant`, or `system`). */
  role: string;
  /** The text content of the message. */
  content: string;
  /** The AI model used to generate the message (if applicable). */
  model: string | null;
  /** ISO-8601 timestamp of when the message was created. */
  created_at: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Repository for managing conversation messages in the database.
 */
export class ConversationRepository {
  private db: Database.Database;

  /** Create a new repository backed by the singleton database. */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Insert a new message into the conversations table.
   *
   * @param role    - The message role (`user`, `assistant`, or `system`).
   * @param content - The text content of the message.
   * @param model   - Optional AI model identifier.
   */
  addMessage(role: string, content: string, model?: string): void {
    this.db
      .prepare(
        "INSERT INTO conversations (role, content, model) VALUES (?, ?, ?)",
      )
      .run(role, content, model ?? null);
  }

  /**
   * Retrieve conversation history ordered newest-first.
   *
   * @param limit - Maximum number of messages to return (default `50`).
   * @returns An array of {@link ConversationMessage} objects.
   */
  getHistory(limit: number = 50): ConversationMessage[] {
    return this.db
      .prepare(
        "SELECT id, role, content, model, created_at FROM conversations ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as ConversationMessage[];
  }

  /**
   * Retrieve the most recent messages ordered oldest-first, suitable for
   * building an AI context window.
   *
   * @param limit - Maximum number of messages to return (default `20`).
   * @returns An array of {@link ConversationMessage} objects in chronological order.
   */
  getRecentContext(limit: number = 20): ConversationMessage[] {
    return this.db
      .prepare(
        `SELECT id, role, content, model, created_at
         FROM (
           SELECT id, role, content, model, created_at
           FROM conversations
           ORDER BY created_at DESC
           LIMIT ?
         ) sub
         ORDER BY created_at ASC`,
      )
      .all(limit) as ConversationMessage[];
  }

  /**
   * Delete all conversation messages.
   */
  clear(): void {
    this.db.prepare("DELETE FROM conversations").run();
  }

  /**
   * Return the total number of stored conversation messages.
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM conversations")
      .get() as { cnt: number };
    return row.cnt;
  }
}

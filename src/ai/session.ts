/**
 * @module ai/session
 * @description AI session **pool** management — creates and maintains multiple
 * parallel Copilot SDK sessions so that user messages, heartbeats, and commands
 * can be processed concurrently without blocking each other.
 *
 * The Copilot SDK only supports one `sendAndWait` call per session at a time.
 * Instead of serializing all messages through a single session (which causes
 * queueing), we maintain a configurable pool of sessions. Each incoming
 * `sendMessage` call acquires a free session, sends its prompt, and releases
 * the session when done. If all sessions are busy, callers wait until one
 * frees up.
 *
 * All other modules that need to interact with the AI should go through the
 * singleton {@link sessionManager}.
 */

import { approveAll, defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { Logger } from "pino";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createChildLogger } from "../core/logger.js";
import { AIError } from "../core/errors.js";
import { CopilotClientWrapper, copilotClient } from "./client.js";
import type { ToolDefinition } from "../plugins/types.js";
import type { SdkMcpServers } from "../mcp/types.js";

const logger = createChildLogger("ai:session");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Opaque handle returned by `client.createSession()`.
 *
 * The Copilot SDK does not export a named session type, so we use a
 * structural type that covers the API surface we depend on.
 */
interface CopilotSession {
  send(options: { prompt: string }): Promise<void>;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data: { content: string } } | null>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  disconnect(): Promise<void>;
}

/**
 * A session within the pool, tracked alongside its busy state and index.
 * Index 0 is the "primary" session — preferred for sequential use so that
 * back-to-back user messages naturally share the same conversation context.
 */
interface PooledSession {
  session: CopilotSession;
  busy: boolean;
  index: number;
}

/** Pending caller waiting for a free session. */
interface SessionWaiter {
  resolve: (ps: PooledSession) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an array of {@link ToolDefinition} objects into the format
 * expected by the Copilot SDK's `createSession({ tools })` option.
 */
function convertTools(tools: ToolDefinition[]): Tool<unknown>[] {
  return tools.map((t) =>
    defineTool(t.name, {
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      handler: t.handler as (args: unknown) => Promise<unknown>,
    }),
  );
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Manages a **pool** of Copilot SDK sessions for parallel message processing.
 *
 * Responsibilities:
 * - Creating a pool of sessions with a given model and set of tools.
 * - Acquiring / releasing sessions for each `sendMessage` call.
 * - Sending messages (blocking and streaming).
 * - Rebuilding the pool when the model or tool set changes.
 * - Graceful cleanup on close.
 */
export class SessionManager {
  /** Pool of parallel Copilot sessions. */
  private pool: PooledSession[] = [];

  /** Configured pool size — how many parallel sessions to maintain. */
  private poolSize: number = 3;

  private currentModel: string = "";
  private tools: ToolDefinition[] = [];
  /** MCP servers passed to every `createSession()` call. */
  private mcpServers: SdkMcpServers | undefined = undefined;
  private logger: Logger;

  /**
   * Cached personality prompt loaded from `personality.md`.
   * Reloaded from disk on each message so edits take effect immediately.
   */
  private personalityPath: string;

  /** Path to the user profile loaded from `user.md`. */
  private userProfilePath: string;

  /**
   * Callers blocked waiting for a free session.
   * Drained FIFO when a session is released.
   */
  private waiters: SessionWaiter[] = [];

  /** Maximum time (ms) a caller will wait in the queue before giving up. */
  private static readonly ACQUIRE_TIMEOUT_MS = 300_000; // 5 minutes

  constructor(private clientWrapper: CopilotClientWrapper) {
    this.logger = logger;
    this.personalityPath = path.join(process.cwd(), "personality.md");
    this.userProfilePath = path.join(process.cwd(), "user.md");
  }

  /**
   * Read a markdown context file from disk.
   *
   * Reads fresh on each call so edits take effect without restart.
   * Returns an empty string if the file is missing or unreadable.
   */
  private loadContextFile(filePath: string, label: string): string {
    try {
      if (!existsSync(filePath)) return "";
      return readFileSync(filePath, "utf-8").trim();
    } catch {
      this.logger.warn(`Could not read ${label} — skipping`);
      return "";
    }
  }

  /**
   * Wrap a user prompt with system-level context (personality + user profile).
   *
   * Both files are read fresh from disk so edits take effect immediately.
   * The personality defines *how* the assistant behaves; the user profile
   * tells it *who* it's talking to.
   */
  private applySystemContext(prompt: string): string {
    const personality = this.loadContextFile(this.personalityPath, "personality.md");
    const userProfile = this.loadContextFile(this.userProfilePath, "user.md");

    const parts: string[] = [];
    if (personality) parts.push(personality);
    if (userProfile) parts.push(userProfile);

    // Tell the model what MCP integrations are active so it doesn't ask.
    if (this.mcpServers && Object.keys(this.mcpServers).length > 0) {
      const ids = Object.keys(this.mcpServers).join(", ");
      parts.push(
        `## Active MCP Integrations\n` +
        `The following MCP server integrations are connected and available as tools: **${ids}**.\n` +
        `You can invoke these integrations directly — no configuration or setup is needed.`,
      );
    }

    if (parts.length === 0) return prompt;
    return `<system>\n${parts.join("\n\n---\n\n")}\n</system>\n\n${prompt}`;
  }

  // -----------------------------------------------------------------------
  // Pool management (private)
  // -----------------------------------------------------------------------

  /**
   * Acquire a free session from the pool.
   *
   * Prefers the lowest-index free session so that sequential interactions
   * (e.g. back-to-back user messages) naturally reuse the same session and
   * keep their conversation context. If all sessions are busy, the caller
   * blocks until one is released or the acquire timeout fires.
   */
  private acquire(): Promise<PooledSession> {
    const free = this.pool.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }

    // All sessions occupied — queue the caller with a timeout guard
    return new Promise<PooledSession>((resolve, reject) => {
      const waiter: SessionWaiter = { resolve, reject };

      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(AIError.sendFailed("Timed out waiting for a free AI session"));
      }, SessionManager.ACQUIRE_TIMEOUT_MS);

      // Wrap resolve to clear the timeout when the waiter is fulfilled
      waiter.resolve = (ps: PooledSession) => {
        clearTimeout(timer);
        resolve(ps);
      };

      this.waiters.push(waiter);
    });
  }

  /**
   * Release a session back to the pool.
   *
   * If callers are queued waiting for a session, the session is handed
   * directly to the next waiter (stays marked as busy) instead of being
   * returned to the idle pool — this avoids an unnecessary acquire cycle.
   */
  private release(ps: PooledSession): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      // Session stays busy — hand it directly to the waiter
      waiter.resolve(ps);
    } else {
      ps.busy = false;
    }
  }

  /**
   * Replace a broken/stuck session with a fresh one.
   *
   * Called when `sendAndWait` times out (session stuck) or the server evicts
   * the session after a long idle period ("Session not found"). Disconnects
   * the old session (best-effort) and creates a replacement in-place so the
   * pool stays at full capacity.
   */
  private async recreatePoolSession(ps: PooledSession): Promise<void> {
    const idx = ps.index;
    this.logger.warn({ session: idx }, "Recreating stuck session");

    // Best-effort disconnect of the broken session
    try { await ps.session.disconnect(); } catch { /* ignore */ }

    try {
      const client = this.clientWrapper.getClient();
      const sdkTools = convertTools(this.tools);

      const newSession = await (client as unknown as {
        createSession(opts: Record<string, unknown>): Promise<CopilotSession>;
      }).createSession({
        model: this.currentModel,
        tools: sdkTools.length > 0 ? sdkTools : undefined,
        mcpServers: this.mcpServers,
        onPermissionRequest: approveAll,
      });

      // Replace in-place
      ps.session = newSession;
      ps.busy = false;
      this.logger.info({ session: idx }, "Session recreated successfully");
    } catch (err) {
      // If recreation fails, remove from pool entirely
      this.logger.error({ err, session: idx }, "Failed to recreate session — removing from pool");
      const poolIdx = this.pool.indexOf(ps);
      if (poolIdx >= 0) this.pool.splice(poolIdx, 1);
    }
  }

  // -----------------------------------------------------------------------
  // Session creation
  // -----------------------------------------------------------------------

  /**
   * Create a pool of Copilot sessions with the specified model and tools.
   *
   * Sessions are created in parallel for faster startup. If any session
   * fails to create, all successful ones are cleaned up and the error
   * propagates.
   *
   * @param model      - Model identifier (e.g. `"gpt-5"`, `"claude-sonnet-4.5"`).
   * @param tools      - Optional array of tool definitions to register.
   * @param poolSize   - Number of parallel sessions (default: 3).
   * @param mcpServers - Optional MCP server map passed directly to the SDK.
   * @throws {AIError} If session creation fails.
   */
  async createSession(
    model: string,
    tools?: ToolDefinition[],
    poolSize?: number,
    mcpServers?: SdkMcpServers,
  ): Promise<void> {
    if (this.pool.length > 0) {
      this.logger.warn("Session pool already exists — closing before re-creating");
      await this.closeSession();
    }

    if (tools) this.tools = tools;
    if (poolSize !== undefined && poolSize > 0) this.poolSize = poolSize;
    if (mcpServers !== undefined) this.mcpServers = mcpServers;

    try {
      const client = this.clientWrapper.getClient();
      const sdkTools = convertTools(this.tools);

      this.logger.info(
        { model, toolCount: sdkTools.length, mcpServerCount: Object.keys(this.mcpServers ?? {}).length, poolSize: this.poolSize },
        "Creating session pool",
      );

      // Create all sessions in parallel for faster startup
      const results = await Promise.allSettled(
        Array.from({ length: this.poolSize }, async (_, i) => {
          const session = await (client as unknown as {
            createSession(opts: Record<string, unknown>): Promise<CopilotSession>;
          }).createSession({
            model,
            tools: sdkTools.length > 0 ? sdkTools : undefined,
            mcpServers: this.mcpServers,
            onPermissionRequest: approveAll,
          });
          this.logger.debug({ index: i }, "Pool session created");
          return { session, busy: false, index: i } as PooledSession;
        }),
      );

      // Separate successes from failures
      const created: PooledSession[] = [];
      const errors: unknown[] = [];

      for (const r of results) {
        if (r.status === "fulfilled") {
          created.push(r.value);
        } else {
          errors.push(r.reason);
        }
      }

      // If any session failed, clean up the ones that succeeded and bail
      if (errors.length > 0) {
        for (const ps of created) {
          try { await ps.session.disconnect(); } catch { /* best-effort cleanup */ }
        }
        const first = errors[0] instanceof Error ? (errors[0] as Error).message : String(errors[0]);
        throw new Error(`${errors.length}/${this.poolSize} sessions failed: ${first}`);
      }

      this.pool = created;
      this.currentModel = model;

      this.logger.info({ model, poolSize: this.poolSize }, "Session pool ready");
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, model }, "Failed to create session pool");
      throw AIError.sessionCreateFailed(reason);
    }
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /**
   * Send a prompt and wait for the complete assistant response.
   *
   * Acquires a free session from the pool, sends the prompt via
   * `sendAndWait`, and releases the session when done. Multiple callers
   * can run in parallel (up to `poolSize`). If all sessions are busy,
   * the caller blocks until one frees up.
   *
   * @param prompt  - The user message to send.
   * @param timeout - Timeout in ms (default: 300 000 = 5 min). Complex prompts
   *                  involving multiple tool calls (e.g. heartbeats) can take
   *                  longer than the SDK's default 60 s.
   * @returns The assistant's full response content.
   * @throws {AIError} If no session pool is active or the send fails.
   */
  /**
   * Check whether an error indicates the session is dead and should be recreated.
   * Covers both SDK-side timeout ("session.idle" never fires) and server-side
   * eviction ("Session not found" — happens after long idle periods).
   */
  private isSessionDead(reason: string): boolean {
    return (
      (reason.includes("Timeout") && reason.includes("session.idle")) ||
      reason.includes("Session not found")
    );
  }

  /**
   * Send a prompt and wait for the complete assistant response.
   *
   * Acquires a free session from the pool, sends the prompt via
   * `sendAndWait`, and releases the session when done. Multiple callers
   * can run in parallel (up to `poolSize`). If all sessions are busy,
   * the caller blocks until one frees up.
   *
   * If the session has been evicted server-side ("Session not found") or
   * timed out, it is recreated and the message is retried once.
   *
   * @param prompt  - The user message to send.
   * @param timeout - Timeout in ms (default: 300 000 = 5 min). Complex prompts
   *                  involving multiple tool calls (e.g. heartbeats) can take
   *                  longer than the SDK's default 60 s.
   * @returns The assistant's full response content.
   * @throws {AIError} If no session pool is active or the send fails.
   */
  async sendMessage(prompt: string, timeout: number = 300_000): Promise<string> {
    this.ensureSession();

    // Inject personality + user profile so the model has full context
    const fullPrompt = this.applySystemContext(prompt);

    const ps = await this.acquire();
    let sessionRecreating = false;
    try {
      return await this.trySendAndWait(ps, fullPrompt, timeout);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, session: ps.index }, "sendMessage failed");

      // If the session is dead (evicted or timed out), recreate and retry once
      if (this.isSessionDead(reason)) {
        sessionRecreating = true;
        this.logger.warn({ session: ps.index, reason }, "Session dead — recreating and retrying");

        try {
          await this.recreatePoolSession(ps);
          return await this.trySendAndWait(ps, fullPrompt, timeout);
        } catch (retryError: unknown) {
          const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
          this.logger.error({ err: retryError, session: ps.index }, "Retry after session recreation also failed");
          throw AIError.sendFailed(retryReason);
        } finally {
          // After retry (success or failure), release the session
          this.release(ps);
        }
      }

      throw AIError.sendFailed(reason);
    } finally {
      if (!sessionRecreating) {
        this.release(ps);
      }
    }
  }

  /**
   * Low-level send-and-wait on a specific pooled session.
   * Separated from `sendMessage` so retry logic can reuse it cleanly.
   */
  private async trySendAndWait(
    ps: PooledSession,
    prompt: string,
    timeout: number,
  ): Promise<string> {
    this.logger.debug(
      { promptLength: prompt.length, timeout, session: ps.index },
      "Sending message (blocking)",
    );

    const response = await ps.session.sendAndWait({ prompt }, timeout);

    const content = response?.data?.content ?? "";
    this.logger.debug(
      { responseLength: content.length, session: ps.index },
      "Received response",
    );
    return content;
  }

  /**
   * Send a prompt with streaming — invokes `onChunk` for each incremental
   * delta and returns the full accumulated response when the session goes idle.
   *
   * Acquires a pooled session for the duration of the streaming call.
   *
   * @param prompt  - The user message to send.
   * @param onChunk - Callback invoked with each streaming text delta.
   * @returns The full accumulated response string.
   * @throws {AIError} If no session pool is active or the send fails.
   */
  async sendMessageStreaming(
    prompt: string,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    this.ensureSession();

    // Inject personality + user profile for streaming too
    const fullPrompt = this.applySystemContext(prompt);

    const ps = await this.acquire();
    let sessionRecreating = false;
    try {
      this.logger.debug(
        { promptLength: fullPrompt.length, session: ps.index },
        "Sending message (streaming)",
      );

      let accumulated = "";

      const done = new Promise<string>((resolve, reject) => {
        ps.session.on("assistant.message_delta", (event: unknown) => {
          const delta = (event as { data: { deltaContent: string } }).data.deltaContent ?? "";
          if (delta) {
            accumulated += delta;
            onChunk(delta);
          }
        });

        ps.session.on("assistant.message", (event: unknown) => {
          const content = (event as { data: { content: string } }).data.content ?? "";
          if (content) {
            accumulated = content;
          }
        });

        ps.session.on("session.idle", () => {
          resolve(accumulated);
        });

        ps.session.on("error", (err: unknown) => {
          reject(err);
        });
      });

      await ps.session.send({ prompt: fullPrompt });
      const result = await done;

      this.logger.debug(
        { responseLength: result.length, session: ps.index },
        "Streaming response complete",
      );
      return result;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, session: ps.index }, "sendMessageStreaming failed");

      if (this.isSessionDead(reason)) {
        sessionRecreating = true;
        this.logger.warn({ session: ps.index, reason }, "Session dead (streaming) — recreating");
        this.recreatePoolSession(ps).catch((err) => {
          this.logger.error({ err, session: ps.index }, "Background session recreation failed");
        });
      }

      throw AIError.sendFailed(reason);
    } finally {
      if (!sessionRecreating) {
        this.release(ps);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Ephemeral sessions (heartbeats)
  // -----------------------------------------------------------------------

  /**
   * Send a prompt on a **disposable, single-use session** that is created
   * fresh and destroyed immediately after the response is received.
   *
   * This is designed for heartbeat events that must run with zero
   * conversation history — preventing the AI from "remembering" results
   * from prior runs and hallucinating stale data.
   *
   * The ephemeral session uses the same model and tools as the main pool
   * but shares no context with it. User chat sessions are unaffected.
   *
   * @param prompt  - The full prompt (personality + user context applied here).
   * @param timeout - Timeout in ms (default: 300 000 = 5 min).
   * @returns The assistant's response content.
   * @throws {AIError} If the session cannot be created or the send fails.
   */
  async sendEphemeral(prompt: string, timeout: number = 300_000): Promise<string> {
    const fullPrompt = this.applySystemContext(prompt);

    let session: CopilotSession | null = null;
    try {
      const client = this.clientWrapper.getClient();
      const sdkTools = convertTools(this.tools);

      this.logger.debug("Creating ephemeral session for heartbeat");
      session = await (client as unknown as {
        createSession(opts: Record<string, unknown>): Promise<CopilotSession>;
      }).createSession({
        model: this.currentModel,
        tools: sdkTools.length > 0 ? sdkTools : undefined,
        mcpServers: this.mcpServers,
        onPermissionRequest: approveAll,
      });

      this.logger.debug(
        { promptLength: fullPrompt.length, timeout },
        "Sending message on ephemeral session",
      );

      const response = await session.sendAndWait({ prompt: fullPrompt }, timeout);

      const content = response?.data?.content ?? "";
      this.logger.debug(
        { responseLength: content.length },
        "Ephemeral session response received",
      );
      return content;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error }, "sendEphemeral failed");
      throw AIError.sendFailed(reason);
    } finally {
      // Always destroy the ephemeral session — it must not persist
      if (session) {
        try { await session.disconnect(); } catch { /* best-effort */ }
        this.logger.debug("Ephemeral session destroyed");
      }
    }
  }

  // -----------------------------------------------------------------------
  // Model / tool management
  // -----------------------------------------------------------------------

  /**
   * Switch to a different model. Closes the entire pool and creates a new
   * one with the same tool set and pool size.
   *
   * @param model - The new model identifier.
   * @throws {AIError} If pool recreation fails.
   */
  async switchModel(model: string): Promise<void> {
    this.logger.info({ from: this.currentModel, to: model }, "Switching model");
    await this.closeSession();
    await this.createSession(model, this.tools);
  }

  /**
   * Reset all sessions — closes the pool and rebuilds it with the same
   * model and tools. This gives the AI a completely fresh context with no
   * memory of prior conversation turns.
   *
   * @throws {AIError} If pool recreation fails.
   */
  async resetSessions(): Promise<void> {
    this.logger.info({ model: this.currentModel }, "Resetting sessions (fresh context)");
    await this.closeSession();
    await this.createSession(this.currentModel, this.tools);
  }

  /**
   * Replace the registered tool set. The pool must be rebuilt because the
   * Copilot SDK binds tools at session creation time.
   *
   * @param tools - New array of tool definitions.
   * @throws {AIError} If pool recreation fails.
   */
  async updateTools(tools: ToolDefinition[]): Promise<void> {
    this.logger.info({ toolCount: tools.length }, "Updating tools (pool rebuild required)");
    this.tools = tools;

    if (this.pool.length > 0) {
      await this.closeSession();
      await this.createSession(this.currentModel, this.tools);
    }
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  /**
   * Close all sessions in the pool and release resources.
   *
   * Any callers blocked in {@link acquire} are rejected with an error.
   * Safe to call even when the pool is empty (no-op).
   */
  async closeSession(): Promise<void> {
    if (this.pool.length === 0) {
      this.logger.debug("No active sessions to close");
      return;
    }

    // Reject any callers waiting for a session
    for (const waiter of this.waiters) {
      waiter.reject(AIError.sessionCreateFailed("Session pool is closing"));
    }
    this.waiters = [];

    this.logger.info({ poolSize: this.pool.length }, "Closing session pool");

    // Disconnect all sessions in parallel (best-effort per session)
    await Promise.allSettled(
      this.pool.map(async (ps) => {
        try {
          await ps.session.disconnect();
        } catch (err) {
          this.logger.error({ err, index: ps.index }, "Error closing pool session (ignored)");
        }
      }),
    );

    this.pool = [];
    this.logger.info("Session pool closed");
  }

  /**
   * Get the identifier of the model used by the current (or most recent) pool.
   */
  getCurrentModel(): string {
    return this.currentModel;
  }

  /**
   * Check whether the session pool has at least one session.
   */
  isActive(): boolean {
    return this.pool.length > 0;
  }

  /**
   * Number of sessions not currently processing a message.
   * Useful for the Telegram handler to decide whether to show a "queued" notice.
   */
  getAvailableCount(): number {
    return this.pool.filter((s) => !s.busy).length;
  }

  /**
   * Total number of sessions in the pool.
   */
  getPoolSize(): number {
    return this.poolSize;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Guard that throws if the pool is empty.
   * @throws {AIError} When called without an active pool.
   */
  private ensureSession(): void {
    if (this.pool.length === 0) {
      throw AIError.sessionCreateFailed("No active sessions — call createSession() first");
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Singleton session manager wired to the default Copilot client. */
export const sessionManager = new SessionManager(copilotClient);

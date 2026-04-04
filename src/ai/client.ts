/**
 * @module ai/client
 * @description AI engine interface — wraps the GitHub Copilot SDK
 * {@link CopilotClient} with lifecycle management, structured error handling,
 * and reconnection support. All other AI modules obtain the underlying client
 * through the singleton {@link copilotClient} exported from this module.
 */

import { CopilotClient } from "@github/copilot-sdk";
import { createChildLogger } from "../core/logger.js";
import { AIError } from "../core/errors.js";

const logger = createChildLogger("ai:client");

// ---------------------------------------------------------------------------
// CopilotClientWrapper
// ---------------------------------------------------------------------------

/**
 * Manages the full lifecycle of a {@link CopilotClient} instance.
 *
 * Consumers should call {@link start} before requesting the underlying client
 * via {@link getClient}, and {@link stop} during graceful shutdown.
 */
export class CopilotClientWrapper {
  private client: CopilotClient | null = null;
  private isStarted: boolean = false;

  /** Start the Copilot client. Must be called before creating sessions. */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn("Client already started — skipping");
      return;
    }

    try {
      logger.info("Starting Copilot client…");
      this.client = new CopilotClient();
      await this.client.start();
      this.isStarted = true;
      logger.info("Copilot client started successfully");
    } catch (error: unknown) {
      this.client = null;
      this.isStarted = false;
      const reason = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Failed to start Copilot client");
      throw AIError.clientStartFailed(reason);
    }
  }

  /** Stop the Copilot client gracefully. */
  async stop(): Promise<void> {
    if (!this.isStarted || !this.client) {
      logger.debug("Client not running — nothing to stop");
      return;
    }

    try {
      logger.info("Stopping Copilot client…");
      await this.client.stop();
      logger.info("Copilot client stopped");
    } catch (error: unknown) {
      logger.error({ err: error }, "Error while stopping Copilot client (ignored)");
    } finally {
      this.client = null;
      this.isStarted = false;
    }
  }

  /**
   * Get the underlying {@link CopilotClient}.
   * @throws {AIError} If the client has not been started.
   */
  getClient(): CopilotClient {
    if (!this.isStarted || !this.client) {
      throw AIError.clientStartFailed("Client not started");
    }
    return this.client;
  }

  /** Check if the client is running. */
  isRunning(): boolean {
    return this.isStarted;
  }

  /** Restart the client (stop then start). */
  async restart(): Promise<void> {
    logger.info("Restarting Copilot client…");
    await this.stop();
    await this.start();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Singleton Copilot client wrapper */
export const copilotClient = new CopilotClientWrapper();

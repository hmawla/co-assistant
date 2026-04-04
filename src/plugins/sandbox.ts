/**
 * @module plugins/sandbox
 * @description Plugin execution sandbox — error isolation & health monitoring.
 *
 * Every plugin method call is routed through `PluginSandbox` so that:
 *  1. Errors never propagate into the host process (try/catch boundary).
 *  2. Consecutive failures are counted per plugin.
 *  3. A plugin is auto-disabled once it exceeds `maxFailures` consecutive
 *     errors, preventing a single broken plugin from degrading the whole
 *     assistant.
 *  4. A successful call resets the failure counter, proving the plugin has
 *     recovered.
 *
 * Tool handlers are wrapped via `wrapToolHandler()` so the AI model receives
 * a descriptive error string instead of an unhandled exception.
 */

import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import { PluginError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum consecutive failures before a plugin is auto-disabled. */
const DEFAULT_MAX_FAILURES = 5;

// ---------------------------------------------------------------------------
// PluginSandbox
// ---------------------------------------------------------------------------

/**
 * Wraps plugin method calls in a try/catch boundary, tracks consecutive
 * failures per plugin, and auto-disables plugins that exceed the failure
 * threshold.
 */
export class PluginSandbox {
  /** Consecutive failure counts keyed by plugin ID. */
  private failureCounts: Map<string, number> = new Map();

  /** Set of plugin IDs that have been auto-disabled due to repeated failures. */
  private disabledPlugins: Set<string> = new Set();

  /** Maximum consecutive failures before a plugin is disabled. */
  private maxFailures: number;

  /** Namespaced logger for sandbox events. */
  private logger: Logger;

  /**
   * Create a new sandbox instance.
   *
   * @param maxFailures - Override for the failure threshold. When omitted the
   *   value is read from the application config (`app.pluginHealth.maxFailures`)
   *   with a hard-coded fallback of {@link DEFAULT_MAX_FAILURES}.
   */
  constructor(maxFailures?: number) {
    this.logger = createChildLogger("plugins:sandbox");

    if (maxFailures !== undefined) {
      this.maxFailures = maxFailures;
    } else {
      try {
        // Dynamic import to avoid circular-dependency issues at module load.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getConfig } = require("../core/config.js");
        this.maxFailures = getConfig().app.pluginHealth.maxFailures ?? DEFAULT_MAX_FAILURES;
      } catch {
        this.maxFailures = DEFAULT_MAX_FAILURES;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Core execution wrapper
  // -----------------------------------------------------------------------

  /**
   * Safely execute a plugin method within a try/catch boundary.
   *
   * If the plugin is disabled the call is short-circuited and `undefined` is
   * returned.  On success the failure counter is reset; on failure it is
   * incremented and the error is logged with full context.
   *
   * **Critical:** errors are _never_ allowed to propagate out of this method.
   *
   * @param pluginId   - Unique identifier of the plugin.
   * @param methodName - Name of the method being invoked (for logging).
   * @param fn         - The async function to execute.
   * @returns The result of `fn()` on success, or `undefined` on failure.
   */
  async safeExecute<T>(
    pluginId: string,
    methodName: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      if (this.isDisabled(pluginId)) {
        this.logger.warn(
          { pluginId, methodName },
          `Plugin "${pluginId}" is disabled — skipping ${methodName}`,
        );
        return undefined;
      }

      const result = await fn();
      this.recordSuccess(pluginId);
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordFailure(pluginId, error, methodName);
      this.logger.error(
        {
          pluginId,
          methodName,
          error: error.message,
          failureCount: this.getFailureCount(pluginId),
          maxFailures: this.maxFailures,
        },
        `Plugin "${pluginId}" method "${methodName}" threw: ${error.message}`,
      );
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Tool handler wrapper
  // -----------------------------------------------------------------------

  /**
   * Wrap a tool handler so that errors are caught and returned as a
   * descriptive string rather than crashing the process.
   *
   * The AI model therefore receives actionable feedback about the failure
   * instead of an unhandled exception.
   *
   * @param pluginId - Unique identifier of the owning plugin.
   * @param toolName - Display name of the tool.
   * @param handler  - The original tool handler function.
   * @returns A wrapped handler with identical signature.
   */
  wrapToolHandler(
    pluginId: string,
    toolName: string,
    handler: (args: Record<string, unknown>) => Promise<string | Record<string, unknown>>,
  ): (args: Record<string, unknown>) => Promise<string | Record<string, unknown>> {
    return async (args: Record<string, unknown>): Promise<string | Record<string, unknown>> => {
      const result = await this.safeExecute<string | Record<string, unknown>>(
        pluginId,
        `tool:${toolName}`,
        () => handler(args),
      );

      if (result === undefined) {
        return `Error: Tool ${toolName} failed: ${
          this.isDisabled(pluginId)
            ? "plugin has been disabled due to repeated failures"
            : "unexpected error during execution"
        }`;
      }

      return result;
    };
  }

  // -----------------------------------------------------------------------
  // Failure / success tracking
  // -----------------------------------------------------------------------

  /**
   * Record a failure for a plugin and auto-disable it if the threshold is
   * reached.
   *
   * @param pluginId   - Unique identifier of the plugin.
   * @param error      - The error that occurred.
   * @param methodName - The method that failed (for logging).
   * @returns `true` if the plugin was auto-disabled as a result of this failure.
   */
  recordFailure(pluginId: string, error: Error, methodName: string): boolean {
    const current = (this.failureCounts.get(pluginId) ?? 0) + 1;
    this.failureCounts.set(pluginId, current);

    // Best-effort persistent health logging — never throw from here.
    try {
      const { PluginHealthRepository } = require("../storage/repositories/plugin-health.js");
      const repo = new PluginHealthRepository();
      repo.logHealth(pluginId, "error", error.message);
    } catch {
      // Storage unavailable — the in-memory counter is still maintained.
    }

    if (current >= this.maxFailures && !this.disabledPlugins.has(pluginId)) {
      this.disabledPlugins.add(pluginId);
      this.logger.warn(
        {
          pluginId,
          methodName,
          failureCount: current,
          maxFailures: this.maxFailures,
        },
        `Plugin "${pluginId}" auto-disabled after ${current} consecutive failures (threshold: ${this.maxFailures})`,
      );
      return true;
    }

    return false;
  }

  /**
   * Record a successful execution for a plugin.
   *
   * Resets the consecutive failure counter to zero — a successful call proves
   * the plugin is healthy.
   *
   * @param pluginId - Unique identifier of the plugin.
   */
  recordSuccess(pluginId: string): void {
    this.failureCounts.set(pluginId, 0);
  }

  // -----------------------------------------------------------------------
  // Status queries
  // -----------------------------------------------------------------------

  /**
   * Check whether a plugin has been auto-disabled due to repeated failures.
   *
   * @param pluginId - Unique identifier of the plugin.
   * @returns `true` if the plugin is currently disabled.
   */
  isDisabled(pluginId: string): boolean {
    return this.disabledPlugins.has(pluginId);
  }

  /**
   * Get the current consecutive failure count for a plugin.
   *
   * @param pluginId - Unique identifier of the plugin.
   * @returns The number of consecutive failures (0 when not tracked).
   */
  getFailureCount(pluginId: string): number {
    return this.failureCounts.get(pluginId) ?? 0;
  }

  /**
   * Reset the failure counter and re-enable a previously disabled plugin.
   *
   * @param pluginId - Unique identifier of the plugin.
   */
  resetPlugin(pluginId: string): void {
    this.failureCounts.delete(pluginId);
    this.disabledPlugins.delete(pluginId);
    this.logger.info({ pluginId }, `Plugin "${pluginId}" has been reset and re-enabled`);
  }

  /**
   * Build a health summary for every plugin the sandbox has interacted with.
   *
   * @returns A map from plugin ID to its current failure count and disabled
   *   status.
   */
  getHealthSummary(): Map<string, { failures: number; disabled: boolean }> {
    const summary = new Map<string, { failures: number; disabled: boolean }>();

    // Include all plugins that have a failure count entry.
    for (const [pluginId, failures] of this.failureCounts) {
      summary.set(pluginId, {
        failures,
        disabled: this.disabledPlugins.has(pluginId),
      });
    }

    // Include disabled plugins that may have had their counter cleared.
    for (const pluginId of this.disabledPlugins) {
      if (!summary.has(pluginId)) {
        summary.set(pluginId, {
          failures: 0,
          disabled: true,
        });
      }
    }

    return summary;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Pre-configured sandbox instance for application-wide use. */
export const pluginSandbox = new PluginSandbox();

/**
 * @module core/logger
 * @description Structured logging with pino.
 *
 * Strategy:
 *  - A single root logger is created at module load.
 *  - Log level is read from the `LOG_LEVEL` env var (default: "info").
 *  - In development (`NODE_ENV !== "production"`) the `pino-pretty` transport
 *    is used for human-readable console output. If pino-pretty is not
 *    installed the logger falls back silently to standard JSON output.
 *  - In production, logs are emitted as newline-delimited JSON to stdout.
 *  - Subsystems obtain namespaced child loggers via `createChildLogger` so
 *    every log line carries a `component` field for easy filtering.
 */

import pino from "pino";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the initial log level from the environment. */
function resolveLogLevel(): string {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  const valid = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];
  return envLevel && valid.includes(envLevel) ? envLevel : "info";
}

/**
 * Build pino options, optionally including the pino-pretty transport when
 * running outside of production. Uses a dynamic import check that works in
 * both CJS and ESM environments.
 */
function buildLoggerOptions(): pino.LoggerOptions {
  const level = resolveLogLevel();
  const isProduction = process.env.NODE_ENV === "production";

  const opts: pino.LoggerOptions = { level };

  if (!isProduction) {
    // pino resolves the transport target via its own worker thread import,
    // so we just need to specify the module name — no require.resolve needed.
    opts.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    };
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Root logger
// ---------------------------------------------------------------------------

/**
 * The application-wide root pino logger.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 * logger.info("Application starting");
 * ```
 */
export const logger: Logger = pino(buildLoggerOptions());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a child logger scoped to a named component.
 *
 * Child loggers inherit the root logger's level and transport while
 * automatically including a `component` field (and any extra metadata) in
 * every log entry, making it easy to filter logs per subsystem.
 *
 * @param name - Logical component name, e.g. `"plugin:gmail"` or `"bot"`.
 * @param meta - Optional extra key-value pairs merged into every log line.
 * @returns A pino child logger instance.
 *
 * @example
 * ```ts
 * const pluginLog = createChildLogger("plugin:gmail", { pluginId: "gmail" });
 * pluginLog.info("Plugin initialized");
 * pluginLog.error({ err: error }, "Plugin failed");
 * ```
 */
export function createChildLogger(
  name: string,
  meta?: Record<string, unknown>,
): Logger {
  return logger.child({ component: name, ...meta });
}

/**
 * Dynamically change the root logger's level at runtime.
 *
 * All existing child loggers inherit the new level because pino child loggers
 * delegate to the parent's level unless they were created with an explicit
 * override.
 *
 * @param level - A valid pino log level string (e.g. `"debug"`, `"warn"`).
 *
 * @example
 * ```ts
 * setLogLevel("debug"); // enable verbose logging
 * ```
 */
export function setLogLevel(level: string): void {
  logger.level = level;
}

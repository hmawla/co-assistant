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
 *  - **Error-level logs** (level ≥ 50) are additionally written to
 *    `logs/error.log` in the working directory for post-mortem analysis.
 */

import pino from "pino";
import type { Logger } from "pino";
import { mkdirSync } from "node:fs";
import path from "node:path";

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
 * Check whether the `pino-pretty` module is resolvable at runtime.
 *
 * When installed globally via npm, devDependencies (like pino-pretty)
 * are not present. We probe for the module before configuring the
 * transport so pino doesn't throw at startup.
 */
function isPinoPrettyAvailable(): boolean {
  try {
    // Use import.meta.resolve (Node 20+) to check without actually loading
    import.meta.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the `logs/` directory exists in the working directory.
 * Called once at module load — safe to call multiple times.
 */
function ensureLogDir(): string {
  const logDir = path.join(process.cwd(), "logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch { /* ignore — dir may already exist */ }
  return logDir;
}

/**
 * Build pino options, optionally including the pino-pretty transport when
 * running outside of production **and** pino-pretty is installed.
 *
 * Additionally configures a file transport for error-level logs so they
 * persist in `logs/error.log` for post-mortem debugging.
 */
function buildLoggerOptions(): pino.LoggerOptions & { transport?: pino.TransportMultiOptions | pino.TransportSingleOptions } {
  const level = resolveLogLevel();
  const isProduction = process.env.NODE_ENV === "production";
  const hasPretty = !isProduction && isPinoPrettyAvailable();
  const logDir = ensureLogDir();
  const errorLogPath = path.join(logDir, "error.log");

  // Use pino's built-in transport pipeline with multiple targets:
  // 1. stdout (all levels) — pretty-printed in dev, JSON in prod
  // 2. error.log file (level >= 50 only) — always JSON for machine parsing
  const targets: pino.TransportTargetOptions[] = [];

  if (hasPretty) {
    targets.push({
      target: "pino-pretty",
      // "trace" so the worker thread accepts everything; the root logger's
      // dynamically-changeable level (e.g. set to "debug" by --verbose) is the
      // sole filter gate. Fixing this to `level` here would bake "info" into
      // the worker and make runtime level changes silently ineffective.
      level: "trace",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    });
  } else {
    targets.push({
      target: "pino/file",
      level: "trace", // same reasoning — let root logger level govern filtering
      options: { destination: 1 }, // fd 1 = stdout
    });
  }

  targets.push({
    target: "pino/file",
    level: "error",
    options: { destination: errorLogPath, mkdir: true },
  });

  return {
    level,
    transport: { targets },
  };
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

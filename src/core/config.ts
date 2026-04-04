/**
 * @module core/config
 * @description Configuration loading and validation using Zod schemas.
 *
 * Responsible for:
 * - Loading environment variables from `.env` via dotenv
 * - Loading and validating `config.json` application settings
 * - Defining Zod schemas for all configuration sections
 * - Providing a singleton accessor (`getConfig()`) with caching
 * - Creating a default config.json when none exists
 */

import { z } from "zod";
import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Error class — fallback until core/errors is fully implemented
// ---------------------------------------------------------------------------

/** Fallback error class used when `core/errors` is not yet implemented. */
class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export { ConfigError };

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for environment-variable based configuration.
 *
 * Validated against `process.env` — values originate from `.env` or the
 * hosting environment.
 */
export const EnvConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_USER_ID: z.string().min(1, "TELEGRAM_USER_ID is required"),
  GITHUB_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEFAULT_MODEL: z.string().default("gpt-4.1"),
  HEARTBEAT_INTERVAL_MINUTES: z.string().default("0"),
  AI_SESSION_POOL_SIZE: z.string().default("3"),
});

/** Inferred type for environment configuration. */
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/**
 * Schema for a single credential entry in a plugin manifest.
 */
export const PluginCredentialEntrySchema = z.object({
  key: z.string(),
  description: z.string(),
  type: z.string().optional(),
});

/** Inferred type for a plugin credential entry. */
export type PluginCredentialEntry = z.infer<typeof PluginCredentialEntrySchema>;

/**
 * Schema for an individual plugin's runtime configuration.
 */
export const PluginConfigSchema = z.object({
  enabled: z.boolean(),
  credentials: z.record(z.string(), z.string()),
});

/** Inferred type for a single plugin's configuration. */
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

/**
 * Schema for Telegram bot behaviour settings.
 */
export const BotConfigSchema = z.object({
  maxMessageLength: z.number().default(4096),
  typingIndicator: z.boolean().default(true),
});

/** Inferred type for bot configuration. */
export type BotConfig = z.infer<typeof BotConfigSchema>;

/**
 * Schema for AI / LLM interaction settings.
 */
export const AIConfigSchema = z.object({
  maxRetries: z.number().default(3),
  sessionTimeout: z.number().default(3600000),
});

/** Inferred type for AI configuration. */
export type AIConfig = z.infer<typeof AIConfigSchema>;

/**
 * Schema for plugin health-check settings.
 */
export const PluginHealthConfigSchema = z.object({
  maxFailures: z.number().default(5),
  checkInterval: z.number().default(60000),
});

/** Inferred type for plugin health configuration. */
export type PluginHealthConfig = z.infer<typeof PluginHealthConfigSchema>;

/**
 * Top-level application configuration schema (loaded from `config.json`).
 */
export const AppConfigSchema = z.object({
  plugins: z.record(z.string(), PluginConfigSchema).default({}),
  bot: BotConfigSchema.default({ maxMessageLength: 4096, typingIndicator: true }),
  ai: AIConfigSchema.default({ maxRetries: 3, sessionTimeout: 3600000 }),
  pluginHealth: PluginHealthConfigSchema.default({ maxFailures: 5, checkInterval: 60000 }),
});

/** Inferred type for the full application configuration. */
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats Zod validation issues into a human-readable multi-line string that
 * lists **every** failing field, not just the first.
 */
function formatZodErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate environment variables.
 *
 * Calls `dotenv.config()` first so that `.env` values are merged into
 * `process.env`.  If the `.env` file is missing a warning is logged but
 * execution continues (variables may be set by the host environment).
 *
 * @returns Validated {@link EnvConfig} object.
 * @throws {ConfigError} When one or more required env vars are missing or
 *   fail validation.  The error message lists **all** failing fields.
 */
export function loadEnvConfig(): EnvConfig {
  const result = dotenv.config();
  if (result.error) {
    // .env file missing — not fatal; env vars may come from the host
    console.warn(
      "[config] .env file not found or unreadable — continuing with existing environment variables",
    );
  }

  const parsed = EnvConfigSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = formatZodErrors(parsed.error);
    throw new ConfigError(
      `Environment variable validation failed:\n${details}`,
    );
  }

  return parsed.data;
}

/**
 * Load and validate the application configuration from a JSON file.
 *
 * If the file does not exist a default `config.json` is created from the
 * schema defaults so the application can start with sensible values.
 *
 * @param configPath - Path to the JSON config file. Defaults to
 *   `./config.json`.
 * @returns Validated {@link AppConfig} object.
 * @throws {ConfigError} When the file exists but contains invalid JSON or
 *   fails schema validation.
 */
export function loadAppConfig(configPath: string = "./config.json"): AppConfig {
  let raw: unknown = {};

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      raw = JSON.parse(content);
    } catch (err) {
      throw new ConfigError(
        `Failed to read or parse config file at "${configPath}": ${(err as Error).message}`,
      );
    }
  } else {
    // Create a default config.json from schema defaults
    const defaults = AppConfigSchema.parse({});
    try {
      writeFileSync(configPath, JSON.stringify(defaults, null, 2) + "\n", "utf-8");
    } catch {
      console.warn(
        `[config] Could not write default config to "${configPath}" — using in-memory defaults`,
      );
    }
    raw = defaults;
  }

  const parsed = AppConfigSchema.safeParse(raw);

  if (!parsed.success) {
    const details = formatZodErrors(parsed.error);
    throw new ConfigError(
      `Application config validation failed (${configPath}):\n${details}`,
    );
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

let cachedConfig: { env: EnvConfig; app: AppConfig } | null = null;

/**
 * Return the combined configuration singleton.
 *
 * On first call, loads both the environment and application configs,
 * validates them, and caches the result.  Subsequent calls return the
 * cached value.
 *
 * @returns An object containing both `env` and `app` configurations.
 * @throws {ConfigError} If either configuration source fails validation.
 */
export function getConfig(): { env: EnvConfig; app: AppConfig } {
  if (!cachedConfig) {
    cachedConfig = {
      env: loadEnvConfig(),
      app: loadAppConfig(),
    };
  }
  return cachedConfig;
}

/**
 * Clear the cached configuration singleton.
 *
 * Useful in tests to force a fresh reload of configuration on the next
 * `getConfig()` call.
 */
export function resetConfig(): void {
  cachedConfig = null;
}

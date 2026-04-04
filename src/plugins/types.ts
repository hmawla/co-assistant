/**
 * @module plugins/types
 * @description Central type definitions for the Co-Assistant plugin system.
 *
 * This file defines every interface, type, and Zod schema that plugin authors
 * and internal subsystems rely on:
 *
 * - **PluginManifestSchema / PluginManifest** — validated shape of a plugin's
 *   `manifest.json` (or inline manifest object).
 * - **PluginContext** — runtime context injected into each plugin on init,
 *   providing credentials, namespaced state storage, and a child logger.
 * - **ToolDefinition** — descriptor for a single tool a plugin exposes to the
 *   AI model (mirrors the shape accepted by `@github/copilot-sdk` `defineTool`).
 * - **CoAssistantPlugin** — the interface every plugin must implement.
 * - **PluginStatus / PluginInfo** — lifecycle status tracking for the registry.
 * - **PluginFactory** — the default export shape expected from plugin modules.
 *
 * All exports are public API — plugin developers should be able to build a
 * fully functional plugin by importing only from this module.
 */

import { z } from "zod";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Plugin Manifest — Zod Schema & Inferred Type
// ---------------------------------------------------------------------------

/**
 * Schema describing a plugin credential requirement.
 *
 * Each entry declares a key the plugin needs at runtime (e.g. an API token)
 * along with a human-readable description and a credential type hint.
 */
export const CredentialRequirementSchema = z.object({
  /** Credential key used to look up the value at runtime. */
  key: z.string(),
  /** Human-readable explanation of what this credential is for. */
  description: z.string(),
  /**
   * Type hint for the credential.
   * - `"text"` — plain text secret (default)
   * - `"oauth"` — OAuth token / flow
   * - `"apikey"` — API key
   */
  type: z.enum(["text", "oauth", "apikey"]).default("text"),
});

/**
 * Zod schema for the plugin manifest — the declarative metadata that
 * describes a plugin's identity, version, credential needs, and
 * inter-plugin dependencies.
 *
 * Validated at load time by the plugin registry before a plugin is
 * initialised.
 */
export const PluginManifestSchema = z.object({
  /**
   * Unique plugin identifier.
   * Must be kebab-case (`a-z`, `0-9`, and `-` only).
   */
  id: z.string().regex(/^[a-z0-9-]+$/, "Plugin ID must be kebab-case"),

  /** Human-readable display name. */
  name: z.string().min(1),

  /**
   * Semantic version string (e.g. `"1.2.3"`).
   * Must follow strict `MAJOR.MINOR.PATCH` format.
   */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver"),

  /** Short description of what this plugin does. */
  description: z.string(),

  /** Optional author or organisation name. */
  author: z.string().optional(),

  /**
   * Credentials the plugin requires to operate.
   * The loader will verify all required credentials are present before
   * calling `initialize()`.
   */
  requiredCredentials: z.array(CredentialRequirementSchema).default([]),

  /**
   * IDs of other plugins this plugin depends on.
   * Dependencies are loaded and initialised first.
   */
  dependencies: z.array(z.string()).default([]),
});

/** Validated plugin manifest — inferred from {@link PluginManifestSchema}. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ---------------------------------------------------------------------------
// Plugin Context
// ---------------------------------------------------------------------------

/**
 * Namespaced state storage interface.
 *
 * Each plugin receives its own isolated key-value store backed by the
 * application's persistent storage layer. Keys are automatically namespaced
 * to the owning plugin to prevent collisions.
 */
export interface PluginStateStore {
  /** Retrieve a value by key. Returns `null` when the key does not exist. */
  get(key: string): string | null;
  /** Set (or overwrite) a value for the given key. */
  set(key: string, value: string): void;
  /** Delete a key and its associated value. */
  delete(key: string): void;
  /** Return a snapshot of all key-value pairs owned by this plugin. */
  getAll(): Record<string, string>;
}

/**
 * Runtime context injected into a plugin's `initialize()` method.
 *
 * The context provides everything a plugin needs to operate:
 * credentials, persistent state, and a namespaced logger.
 */
export interface PluginContext {
  /** The plugin's unique identifier. */
  pluginId: string;

  /**
   * Pre-validated credentials for this plugin.
   * All keys declared in `requiredCredentials` are guaranteed to be present.
   */
  credentials: Record<string, string>;

  /**
   * Namespaced state storage.
   * Get, set, and delete plugin-specific persistent data.
   */
  state: PluginStateStore;

  /**
   * Child logger namespaced to this plugin.
   * All log entries are automatically tagged with the plugin ID.
   */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

/**
 * Describes a single tool that a plugin exposes to the AI model.
 *
 * This shape closely mirrors the `defineTool` options accepted by the
 * `@github/copilot-sdk`. The plugin manager will automatically prefix
 * the tool name with the plugin ID (e.g. `weather__get-forecast`) to
 * guarantee uniqueness across all loaded plugins.
 */
export interface ToolDefinition {
  /**
   * Tool name (without plugin prefix).
   * The final registered name will be `<pluginId>__<name>`.
   */
  name: string;

  /** Description shown to the AI model so it knows when to invoke this tool. */
  description: string;

  /**
   * Parameter schema for the tool.
   *
   * Accepts either a plain JSON Schema object (as used by
   * `@github/copilot-sdk` `defineTool`) or a Zod schema that can be
   * converted to JSON Schema at registration time.
   */
  parameters: Record<string, unknown> | z.ZodType;

  /**
   * Handler invoked when the AI model calls this tool.
   *
   * @param args - Parsed arguments matching the declared parameters schema.
   * @returns A string or structured object that is relayed back to the model.
   */
  handler: (
    args: Record<string, unknown>,
  ) => Promise<string | Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Plugin Interface
// ---------------------------------------------------------------------------

/**
 * The main interface every Co-Assistant plugin must implement.
 *
 * A plugin is the unit of extensibility: it declares metadata, exposes one
 * or more {@link ToolDefinition | tools} to the AI session, and manages its
 * own lifecycle through `initialize` → `getTools` → `destroy`.
 *
 * @example
 * ```ts
 * import type { CoAssistantPlugin, PluginContext, ToolDefinition } from "./types.js";
 *
 * export default function createPlugin(): CoAssistantPlugin {
 *   let ctx: PluginContext;
 *   return {
 *     id: "hello-world",
 *     name: "Hello World",
 *     version: "1.0.0",
 *     description: "A minimal example plugin",
 *     requiredCredentials: [],
 *     async initialize(context) { ctx = context; },
 *     getTools() {
 *       return [{
 *         name: "greet",
 *         description: "Say hello",
 *         parameters: { type: "object", properties: {} },
 *         handler: async () => "Hello from a plugin!",
 *       }];
 *     },
 *     async destroy() {},
 *     async healthCheck() { return true; },
 *   };
 * }
 * ```
 */
export interface CoAssistantPlugin {
  /** Unique plugin identifier (kebab-case). Must match the manifest `id`. */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Semantic version string (`MAJOR.MINOR.PATCH`). */
  version: string;

  /** Brief description of what this plugin does. */
  description: string;

  /**
   * List of credential keys this plugin requires.
   * These must all be present in `PluginContext.credentials` before
   * `initialize()` is called.
   */
  requiredCredentials: string[];

  /**
   * Initialise the plugin with its runtime context.
   * Called exactly once after the plugin is loaded and credentials are
   * verified. Use this to set up API clients, open connections, etc.
   */
  initialize(context: PluginContext): Promise<void>;

  /**
   * Return the tool definitions this plugin provides.
   * Called after `initialize()`. The returned tools are registered with
   * the AI session via the Copilot SDK.
   */
  getTools(): ToolDefinition[];

  /**
   * Graceful shutdown hook.
   * Clean up resources, close connections, flush buffers, etc.
   */
  destroy(): Promise<void>;

  /**
   * Health check probe.
   * @returns `true` if the plugin is fully operational, `false` otherwise.
   */
  healthCheck(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Plugin Lifecycle & Status
// ---------------------------------------------------------------------------

/**
 * Represents the current lifecycle state of a loaded plugin.
 *
 * - `"loaded"` — module evaluated, not yet initialised.
 * - `"active"` — `initialize()` succeeded; plugin is operational.
 * - `"error"` — an unrecoverable error occurred during init or runtime.
 * - `"disabled"` — manually disabled by the user / admin.
 * - `"unloaded"` — `destroy()` was called and the plugin is no longer active.
 */
export type PluginStatus = "loaded" | "active" | "error" | "disabled" | "unloaded";

/**
 * Read-only snapshot of a plugin's current state.
 * Used by the CLI, admin API, and health endpoints.
 */
export interface PluginInfo {
  /** Plugin identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semantic version. */
  version: string;
  /** Short description. */
  description: string;
  /** Current lifecycle status. */
  status: PluginStatus;
  /** Whether the plugin is enabled in configuration. */
  enabled: boolean;
  /** If `status` is `"error"`, a human-readable error message. */
  errorMessage?: string;
  /**
   * Consecutive failure count.
   * Incremented on health-check failures; reset on success.
   */
  failureCount: number;
  /** Names of tools registered by this plugin (prefixed). */
  tools: string[];
}

// ---------------------------------------------------------------------------
// Plugin Factory
// ---------------------------------------------------------------------------

/**
 * The shape of the default export every plugin module must provide.
 *
 * A factory is a zero-argument function that returns a fresh
 * {@link CoAssistantPlugin} instance. This allows the plugin manager to
 * instantiate plugins lazily and in isolation.
 *
 * @example
 * ```ts
 * // plugins/weather/index.ts
 * import type { PluginFactory } from "../types.js";
 *
 * const createPlugin: PluginFactory = () => ({
 *   id: "weather",
 *   name: "Weather",
 *   version: "0.1.0",
 *   description: "Provides current weather data",
 *   requiredCredentials: ["OPENWEATHER_API_KEY"],
 *   async initialize(ctx) { … },
 *   getTools() { return [ … ]; },
 *   async destroy() { … },
 *   async healthCheck() { return true; },
 * });
 *
 * export default createPlugin;
 * ```
 */
export type PluginFactory = () => CoAssistantPlugin;

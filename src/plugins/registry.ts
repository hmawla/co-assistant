/**
 * @module plugins/registry
 * @description Plugin registry for discovering and tracking available plugins.
 *
 * Responsible for:
 * - Scanning the plugins directory to discover available plugins
 * - Reading and validating each plugin's `plugin.json` manifest against
 *   {@link PluginManifestSchema}
 * - Tracking which plugins are enabled / disabled
 * - Persisting enable/disable state to `config.json`
 *
 * Usage:
 * ```ts
 * const registry = createPluginRegistry();
 * await registry.discoverPlugins();
 * registry.enablePlugin("gmail");
 * ```
 */

import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import { type PluginManifest, PluginManifestSchema } from "./types.js";
import { loadAppConfig, resetConfig, AppConfigSchema } from "../core/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the manifest file expected inside each plugin subdirectory. */
const MANIFEST_FILENAME = "plugin.json";

/** Default path to the config file used for persistence. */
const CONFIG_PATH = "./config.json";

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that discovers plugins on disk, validates their manifests, and
 * manages the enabled / disabled state for each plugin.
 */
export class PluginRegistry {
  /** Validated manifests keyed by plugin ID. */
  private manifests: Map<string, PluginManifest> = new Map();

  /** Set of currently-enabled plugin IDs. */
  private enabledPlugins: Set<string> = new Set();

  /** Namespaced logger for registry operations. */
  private logger: Logger;

  /**
   * @param pluginsDir - Absolute or relative path to the directory that
   *   contains plugin subdirectories.
   */
  constructor(private pluginsDir: string) {
    this.logger = createChildLogger("plugins:registry");
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * Scan the plugins directory and discover all available plugins.
   *
   * For every subdirectory that contains a valid `plugin.json` the manifest
   * is parsed, validated with {@link PluginManifestSchema}, and stored.
   * Invalid or missing manifests are logged as warnings and skipped — they
   * never crash the application.
   *
   * After discovery the enabled state for each plugin is loaded from the
   * application config (`config.json → app.plugins[id].enabled`).
   *
   * @returns Array of all successfully validated {@link PluginManifest}s.
   */
  async discoverPlugins(): Promise<PluginManifest[]> {
    this.manifests.clear();
    this.enabledPlugins.clear();

    // Ensure the plugins directory exists.
    if (!existsSync(this.pluginsDir)) {
      this.logger.info(
        { pluginsDir: this.pluginsDir },
        "Plugins directory does not exist — creating it",
      );
      mkdirSync(this.pluginsDir, { recursive: true });
      return [];
    }

    // Enumerate subdirectories.
    const entries = readdirSync(this.pluginsDir);

    for (const entry of entries) {
      const entryPath = path.join(this.pluginsDir, entry);

      // Only consider directories.
      if (!statSync(entryPath).isDirectory()) {
        continue;
      }

      const manifestPath = path.join(entryPath, MANIFEST_FILENAME);

      // Check that plugin.json exists.
      if (!existsSync(manifestPath)) {
        this.logger.warn(
          { dir: entry },
          `Skipping "${entry}": no ${MANIFEST_FILENAME} found`,
        );
        continue;
      }

      // Read and parse JSON.
      let raw: unknown;
      try {
        const content = readFileSync(manifestPath, "utf-8");
        raw = JSON.parse(content);
      } catch (err) {
        this.logger.warn(
          { dir: entry, error: (err as Error).message },
          `Skipping "${entry}": failed to read or parse ${MANIFEST_FILENAME}`,
        );
        continue;
      }

      // Validate against the Zod schema.
      const result = PluginManifestSchema.safeParse(raw);

      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        this.logger.warn(
          { dir: entry },
          `Skipping "${entry}": manifest validation failed:\n${issues}`,
        );
        continue;
      }

      const manifest = result.data;
      this.manifests.set(manifest.id, manifest);
      this.logger.info(
        { pluginId: manifest.id, version: manifest.version },
        `Discovered plugin "${manifest.name}"`,
      );
    }

    // Load enabled state from config.json.
    this.loadEnabledState();

    return this.getManifests();
  }

  // -----------------------------------------------------------------------
  // Manifest accessors
  // -----------------------------------------------------------------------

  /**
   * Get all discovered plugin manifests.
   *
   * @returns A shallow copy of the manifests array.
   */
  getManifests(): PluginManifest[] {
    return Array.from(this.manifests.values());
  }

  /**
   * Get a specific plugin's manifest by ID.
   *
   * @param pluginId - The unique plugin identifier.
   * @returns The manifest if found, otherwise `undefined`.
   */
  getManifest(pluginId: string): PluginManifest | undefined {
    return this.manifests.get(pluginId);
  }

  // -----------------------------------------------------------------------
  // Enabled / disabled state
  // -----------------------------------------------------------------------

  /**
   * Check whether a plugin is currently enabled.
   *
   * @param pluginId - The unique plugin identifier.
   * @returns `true` if the plugin is enabled.
   */
  isEnabled(pluginId: string): boolean {
    return this.enabledPlugins.has(pluginId);
  }

  /**
   * Enable a plugin and persist the state to `config.json`.
   *
   * @param pluginId - The unique plugin identifier.
   */
  enablePlugin(pluginId: string): void {
    this.enabledPlugins.add(pluginId);
    this.logger.info({ pluginId }, `Plugin "${pluginId}" enabled`);
    this.persistPluginState(pluginId, true);
  }

  /**
   * Disable a plugin and persist the state to `config.json`.
   *
   * @param pluginId - The unique plugin identifier.
   */
  disablePlugin(pluginId: string): void {
    this.enabledPlugins.delete(pluginId);
    this.logger.info({ pluginId }, `Plugin "${pluginId}" disabled`);
    this.persistPluginState(pluginId, false);
  }

  /**
   * Get the list of currently-enabled plugin IDs.
   *
   * @returns Array of enabled plugin ID strings.
   */
  getEnabledPluginIds(): string[] {
    return Array.from(this.enabledPlugins);
  }

  /**
   * Get the list of all discovered plugin IDs.
   *
   * @returns Array of all known plugin ID strings.
   */
  getAllPluginIds(): string[] {
    return Array.from(this.manifests.keys());
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Load the enabled state for every discovered plugin from the application
   * config.  Plugins whose config entry has `enabled: true` are added to the
   * enabled set.
   */
  private loadEnabledState(): void {
    let appConfig: Record<string, unknown>;

    try {
      // Read the raw config to avoid triggering env-var validation via
      // the singleton `getConfig()` (which also loads EnvConfig).
      if (existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        appConfig = AppConfigSchema.parse(raw);
      } else {
        appConfig = AppConfigSchema.parse({}) as unknown as Record<string, unknown>;
      }
    } catch {
      this.logger.warn("Could not load config.json — defaulting all plugins to disabled");
      return;
    }

    const plugins = (appConfig as { plugins?: Record<string, { enabled?: boolean }> }).plugins ?? {};

    for (const id of this.manifests.keys()) {
      if (plugins[id]?.enabled === true) {
        this.enabledPlugins.add(id);
        this.logger.debug({ pluginId: id }, `Plugin "${id}" is enabled via config`);
      }
    }
  }

  /**
   * Persist the enabled/disabled state for a single plugin to `config.json`.
   *
   * Reads the current file, updates the relevant entry, and writes it back.
   * If the file does not exist a minimal config is created.
   */
  private persistPluginState(pluginId: string, enabled: boolean): void {
    try {
      let config: Record<string, unknown> = {};

      if (existsSync(CONFIG_PATH)) {
        config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
      }

      // Ensure the plugins map exists.
      if (!config.plugins || typeof config.plugins !== "object") {
        config.plugins = {};
      }

      const plugins = config.plugins as Record<string, Record<string, unknown>>;

      if (!plugins[pluginId]) {
        plugins[pluginId] = { enabled, credentials: {} };
      } else {
        plugins[pluginId].enabled = enabled;
      }

      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");

      // Bust the singleton cache so subsequent `getConfig()` calls pick up
      // the new state.
      resetConfig();

      this.logger.debug(
        { pluginId, enabled },
        "Persisted plugin state to config.json",
      );
    } catch (err) {
      this.logger.error(
        { pluginId, error: (err as Error).message },
        "Failed to persist plugin state to config.json",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link PluginRegistry} instance.
 *
 * @param pluginsDir - Path to the plugins directory.  Defaults to
 *   `<cwd>/plugins`.
 * @returns A ready-to-use `PluginRegistry`.
 */
export function createPluginRegistry(pluginsDir?: string): PluginRegistry {
  return new PluginRegistry(pluginsDir ?? path.join(process.cwd(), "plugins"));
}

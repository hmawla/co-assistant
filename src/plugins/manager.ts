/**
 * @module plugins/manager
 * @description Central plugin lifecycle manager — discovers, loads, initialises,
 * and shuts down plugins. Coordinates with the {@link PluginRegistry} for
 * discovery and enable/disable persistence, the {@link PluginSandbox} for
 * error-isolated execution, the {@link CredentialManager} for credential
 * validation, and {@link PluginStateRepository} for per-plugin state storage.
 *
 * Usage:
 * ```ts
 * const manager = createPluginManager(registry, sandbox, credentials, stateRepo);
 * await manager.initialize();  // discover + load enabled plugins
 * const tools = manager.getAllTools();
 * // … later …
 * await manager.shutdown();
 * ```
 */

import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginSandbox } from "./sandbox.js";
import type { CredentialManager } from "./credentials.js";
import type { PluginStateRepository } from "../storage/repositories/plugin-state.js";
import type {
  CoAssistantPlugin,
  PluginContext,
  PluginFactory,
  PluginInfo,
  PluginStateStore,
  PluginStatus,
  ToolDefinition,
} from "./types.js";

const pluginLogger = createChildLogger("plugins:manager");

// ---------------------------------------------------------------------------
// Plugin compilation helper
// ---------------------------------------------------------------------------

/**
 * Walk up from the current file to find the nearest `node_modules` directory.
 * This allows plugins to reference packages (zod, googleapis, etc.) that are
 * installed alongside co-assistant, even when the user's cwd has no
 * node_modules of its own.
 */
function findNodeModules(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Compile a TypeScript plugin entry point to a single ESM JavaScript file
 * using esbuild. All imports — local (./auth.js → ./auth.ts) and
 * third-party (zod, googleapis) — are bundled into the output so the
 * compiled plugin is fully self-contained.
 *
 * The compiled file is cached next to the source as `index.compiled.mjs`.
 * It is only rebuilt when the source directory has been modified.
 *
 * This avoids all Node.js ESM loader hook issues (tsx register/tsImport)
 * that break across different Node versions (especially Node 24+).
 */
async function compilePlugin(tsEntryPath: string): Promise<string> {
  const outfile = tsEntryPath.replace(/\.ts$/, ".compiled.mjs");
  const pluginDir = path.dirname(tsEntryPath);

  // Check if compiled version exists and is reasonably fresh.
  // We compare against the directory mtime — any file change in the
  // plugin dir bumps it, triggering a recompile.
  if (existsSync(outfile)) {
    try {
      const compiledMtime = statSync(outfile).mtimeMs;
      const dirMtime = statSync(pluginDir).mtimeMs;
      if (compiledMtime >= dirMtime) {
        pluginLogger.debug({ outfile }, "Using cached compiled plugin");
        return outfile;
      }
    } catch {
      // If stat fails, just recompile
    }
  }

  pluginLogger.debug({ tsEntryPath, outfile }, "Compiling plugin with esbuild");

  // Resolve the package's own node_modules so plugins can import
  // shared deps (e.g. zod, googleapis) even when running from a
  // different cwd that has no local node_modules.
  const pkgNodeModules = findNodeModules();

  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [tsEntryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    // Bundle EVERYTHING — including node_modules packages — so the
    // compiled plugin is fully self-contained and works regardless of
    // which directory the user runs co-assistant from.
    // esbuild's nodePaths lets us find the package's own deps.
    nodePaths: pkgNodeModules ? [pkgNodeModules] : [],
    logLevel: "warning",
  });

  pluginLogger.debug({ outfile }, "Plugin compiled successfully");
  return outfile;
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

/**
 * Central orchestrator that loads plugins, manages their lifecycle, and
 * coordinates with the registry, sandbox, credential manager, and state
 * repository.
 */
export class PluginManager {
  /** Active (loaded and initialised) plugin instances keyed by ID. */
  private plugins: Map<string, CoAssistantPlugin> = new Map();

  /** Current lifecycle status for every known plugin. */
  private pluginStatuses: Map<string, PluginStatus> = new Map();

  /** Namespaced logger for manager operations. */
  private logger: Logger;

  constructor(
    private registry: PluginRegistry,
    private sandbox: PluginSandbox,
    private credentials: CredentialManager,
    private stateRepo: PluginStateRepository,
  ) {
    this.logger = createChildLogger("plugins:manager");
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  /**
   * Initialise the plugin system: discover plugins on disk, then load and
   * initialise every enabled plugin.
   *
   * Safe to call exactly once at application startup. Errors from individual
   * plugins are caught and logged — a single broken plugin never prevents the
   * rest from loading.
   */
  async initialize(): Promise<void> {
    this.logger.info("Initializing plugin system…");

    const manifests = await this.registry.discoverPlugins();
    const discovered = manifests.length;
    let loaded = 0;
    let failed = 0;

    const enabledIds = this.registry.getEnabledPluginIds();

    for (const pluginId of enabledIds) {
      try {
        await this.loadPlugin(pluginId);
        loaded++;
      } catch (err) {
        failed++;
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          { pluginId, error: error.message },
          `Failed to load plugin "${pluginId}"`,
        );
        this.pluginStatuses.set(pluginId, "error");
      }
    }

    this.logger.info(
      { discovered, loaded, failed },
      `Plugin system ready — ${discovered} discovered, ${loaded} loaded, ${failed} failed`,
    );
  }

  // -----------------------------------------------------------------------
  // Load / Unload
  // -----------------------------------------------------------------------

  /**
   * Load and initialise a specific plugin by ID.
   *
   * Steps:
   * 1. Resolve the plugin manifest from the registry.
   * 2. Validate credentials via the {@link CredentialManager}.
   * 3. Dynamically import the plugin module (preferring compiled `.js`).
   * 4. Invoke the factory to obtain a {@link CoAssistantPlugin} instance.
   * 5. Build a {@link PluginContext} and call `plugin.initialize()` inside
   *    the sandbox.
   * 6. Store the active plugin and set its status to `"active"`.
   *
   * @param pluginId - Unique identifier of the plugin to load.
   * @throws If the manifest is not found, credentials are invalid, or the
   *         module cannot be imported.
   */
  async loadPlugin(pluginId: string): Promise<void> {
    this.logger.info({ pluginId }, `Loading plugin "${pluginId}"…`);

    // 1. Manifest
    const manifest = this.registry.getManifest(pluginId);
    if (!manifest) {
      throw new Error(`No manifest found for plugin "${pluginId}"`);
    }

    this.pluginStatuses.set(pluginId, "loaded");

    // 2. Credentials
    let creds: Record<string, string> = {};
    try {
      creds = this.credentials.getValidatedCredentials(
        pluginId,
        manifest.requiredCredentials,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(
        { pluginId, error: error.message },
        `Credential validation failed for "${pluginId}" — loading with empty credentials`,
      );
    }

    // 3. Dynamic import
    const pluginPath = this.resolvePluginPath(pluginId);
    this.logger.debug({ pluginId, pluginPath }, "Importing plugin module");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      // For .ts plugins, compile to a single .mjs bundle using esbuild.
      // This resolves all local sub-imports (./auth.js → ./auth.ts) at
      // compile time, producing a self-contained ESM file that works with
      // native import() on any Node version without loader hooks.
      if (pluginPath.endsWith(".ts")) {
        const compiledPath = await compilePlugin(pluginPath);
        mod = await import(pathToFileURL(compiledPath).href);
      } else {
        mod = await import(pluginPath);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.pluginStatuses.set(pluginId, "error");
      throw new Error(
        `Failed to import plugin module "${pluginId}" from ${pluginPath}: ${error.message}`,
      );
    }

    // 4. Factory
    const factory: PluginFactory | undefined =
      typeof mod.default === "function"
        ? mod.default
        : typeof mod.createPlugin === "function"
          ? mod.createPlugin
          : undefined;

    if (!factory) {
      this.pluginStatuses.set(pluginId, "error");
      throw new Error(
        `Plugin "${pluginId}" does not export a default factory or createPlugin function`,
      );
    }

    const plugin = factory();

    // 5. Build context & initialise
    const context = this.buildPluginContext(pluginId, creds);

    const initResult = await this.sandbox.safeExecute(
      pluginId,
      "initialize",
      () => plugin.initialize(context),
    );

    // safeExecute returns undefined on failure
    if (initResult === undefined && manifest.requiredCredentials.length > 0) {
      this.logger.warn(
        { pluginId },
        `Plugin "${pluginId}" initialize() did not succeed — marking as error`,
      );
    }

    // 6. Store
    this.plugins.set(pluginId, plugin);
    this.pluginStatuses.set(pluginId, "active");
    this.logger.info(
      { pluginId, version: manifest.version },
      `Plugin "${manifest.name}" v${manifest.version} loaded successfully`,
    );
  }

  /**
   * Unload a plugin: invoke its `destroy()` hook inside the sandbox,
   * remove it from the active plugin map, and mark it as unloaded.
   *
   * @param pluginId - Unique identifier of the plugin to unload.
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      this.logger.warn({ pluginId }, `Plugin "${pluginId}" is not loaded — nothing to unload`);
      return;
    }

    this.logger.info({ pluginId }, `Unloading plugin "${pluginId}"…`);

    await this.sandbox.safeExecute(pluginId, "destroy", () => plugin.destroy());

    this.plugins.delete(pluginId);
    this.pluginStatuses.set(pluginId, "unloaded");
    this.logger.info({ pluginId }, `Plugin "${pluginId}" unloaded`);
  }

  // -----------------------------------------------------------------------
  // Enable / Disable
  // -----------------------------------------------------------------------

  /**
   * Enable a plugin: persist the enabled state in the registry and load the
   * plugin if it is not already active.
   *
   * @param pluginId - Unique identifier of the plugin to enable.
   */
  async enablePlugin(pluginId: string): Promise<void> {
    this.logger.info({ pluginId }, `Enabling plugin "${pluginId}"`);
    this.registry.enablePlugin(pluginId);

    if (!this.plugins.has(pluginId)) {
      await this.loadPlugin(pluginId);
    }
  }

  /**
   * Disable a plugin: persist the disabled state in the registry and unload
   * the plugin if it is currently active.
   *
   * @param pluginId - Unique identifier of the plugin to disable.
   */
  async disablePlugin(pluginId: string): Promise<void> {
    this.logger.info({ pluginId }, `Disabling plugin "${pluginId}"`);
    this.registry.disablePlugin(pluginId);

    if (this.plugins.has(pluginId)) {
      await this.unloadPlugin(pluginId);
    }

    this.pluginStatuses.set(pluginId, "disabled");
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /**
   * Get all active (loaded and running) plugin instances.
   *
   * @returns A new Map containing only the currently active plugins.
   */
  getActivePlugins(): Map<string, CoAssistantPlugin> {
    return new Map(this.plugins);
  }

  /**
   * Collect all tool definitions from every active plugin.
   *
   * Tool names are prefixed with the owning plugin's ID
   * (`<pluginId>__<toolName>`) to guarantee uniqueness. Handlers are wrapped
   * by the sandbox so errors are isolated.
   *
   * @returns Flat array of all tools across all active plugins.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const [pluginId, plugin] of this.plugins) {
      try {
        const pluginTools = plugin.getTools();
        for (const tool of pluginTools) {
          tools.push({
            name: `${pluginId}__${tool.name}`,
            description: tool.description,
            parameters: tool.parameters,
            handler: this.sandbox.wrapToolHandler(pluginId, tool.name, tool.handler),
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          { pluginId, error: error.message },
          `Failed to get tools from plugin "${pluginId}"`,
        );
      }
    }

    return tools;
  }

  /**
   * Build a read-only info snapshot for every discovered plugin.
   *
   * Combines manifest metadata, current lifecycle status, enabled state,
   * sandbox failure counts, and registered tool names.
   *
   * @returns Array of {@link PluginInfo} objects (for display / admin API).
   */
  getPluginInfoList(): PluginInfo[] {
    const manifests = this.registry.getManifests();

    return manifests.map((manifest) => {
      const pluginId = manifest.id;
      const status = this.pluginStatuses.get(pluginId) ?? "unloaded";
      const enabled = this.registry.isEnabled(pluginId);
      const failureCount = this.sandbox.getFailureCount(pluginId);

      // Collect tool names from the active instance (if any).
      let toolNames: string[] = [];
      const plugin = this.plugins.get(pluginId);
      if (plugin) {
        try {
          toolNames = plugin.getTools().map((t) => `${pluginId}__${t.name}`);
        } catch {
          // Plugin may be in a bad state — silently skip tool enumeration.
        }
      }

      const info: PluginInfo = {
        id: pluginId,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        status,
        enabled,
        failureCount,
        tools: toolNames,
      };

      if (status === "error") {
        info.errorMessage = this.sandbox.isDisabled(pluginId)
          ? "Auto-disabled due to repeated failures"
          : "Plugin encountered an error during lifecycle";
      }

      return info;
    });
  }

  /**
   * Get info about a specific discovered plugin.
   *
   * @param pluginId - The unique plugin identifier.
   * @returns The plugin info snapshot, or `undefined` if the plugin was not
   *          discovered.
   */
  getPluginInfo(pluginId: string): PluginInfo | undefined {
    return this.getPluginInfoList().find((info) => info.id === pluginId);
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down all active plugins.
   *
   * Calls `destroy()` on each plugin inside the sandbox so that a failing
   * plugin does not prevent the rest from cleaning up.
   */
  async shutdown(): Promise<void> {
    this.logger.info("Shutting down plugin system…");

    const pluginIds = Array.from(this.plugins.keys());

    for (const pluginId of pluginIds) {
      await this.unloadPlugin(pluginId);
    }

    this.logger.info(
      { count: pluginIds.length },
      `Plugin system shut down — ${pluginIds.length} plugin(s) unloaded`,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the file-system path for a plugin module.
   *
   * Prefers the compiled `.js` file; falls back to `.ts` for development.
   */
  private resolvePluginPath(pluginId: string): string {
    const baseDir = path.join(process.cwd(), "plugins", pluginId);

    const jsPath = path.join(baseDir, "index.js");
    if (existsSync(jsPath)) {
      return jsPath;
    }

    const tsPath = path.join(baseDir, "index.ts");
    if (existsSync(tsPath)) {
      return tsPath;
    }

    // Fall back to .js — the dynamic import will surface a clear error.
    return jsPath;
  }

  /**
   * Build a {@link PluginContext} for a specific plugin.
   *
   * The context provides credentials, a namespaced state store backed by the
   * {@link PluginStateRepository}, and a child logger.
   */
  private buildPluginContext(
    pluginId: string,
    credentials: Record<string, string>,
  ): PluginContext {
    const stateStore: PluginStateStore = {
      get: (key: string) => this.stateRepo.get(pluginId, key),
      set: (key: string, value: string) => this.stateRepo.set(pluginId, key, value),
      delete: (key: string) => this.stateRepo.delete(pluginId, key),
      getAll: () => this.stateRepo.getAll(pluginId),
    };

    return {
      pluginId,
      credentials,
      state: stateStore,
      logger: createChildLogger(`plugin:${pluginId}`, { pluginId }),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link PluginManager} instance.
 *
 * @param registry   - Plugin registry for discovery and enable/disable state.
 * @param sandbox    - Execution sandbox for error isolation.
 * @param credentials - Credential manager for validation.
 * @param stateRepo  - Repository for per-plugin persistent state.
 * @returns A ready-to-use `PluginManager`.
 */
export function createPluginManager(
  registry: PluginRegistry,
  sandbox: PluginSandbox,
  credentials: CredentialManager,
  stateRepo: PluginStateRepository,
): PluginManager {
  return new PluginManager(registry, sandbox, credentials, stateRepo);
}

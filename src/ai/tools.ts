/**
 * @module ai/tools
 * @description Tool aggregation — collects tools from all active plugins,
 * prefixes names to avoid collisions, wraps handlers in the plugin sandbox
 * for error isolation, and converts everything into Copilot SDK format.
 */

import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import type { CoAssistantPlugin, ToolDefinition } from "../plugins/types.js";
import { PluginSandbox, pluginSandbox } from "../plugins/sandbox.js";

// Re-export the SDK Tool type for downstream convenience.
type SDKTool = Tool<unknown>;

// ---------------------------------------------------------------------------
// ToolAggregator
// ---------------------------------------------------------------------------

/**
 * Collects {@link ToolDefinition} arrays from every active plugin, converts
 * them into Copilot SDK `Tool` objects via `defineTool`, and returns a flat
 * array ready to be passed to `client.createSession({ tools })`.
 *
 * Each tool name is prefixed with the owning plugin's ID (e.g.
 * `"gmail_send_email"`) so tools from different plugins never collide.
 * Handlers are wrapped through {@link PluginSandbox.wrapToolHandler} so that
 * a failing tool returns a descriptive error string to the model instead of
 * crashing the process.
 */
export class ToolAggregator {
  private logger: Logger;

  constructor(private sandbox: PluginSandbox) {
    this.logger = createChildLogger("ai:tools");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Collect tools from every plugin in the map, prefix names, wrap handlers
   * for safety, and return a flat array of SDK-compatible tool definitions.
   *
   * Plugins that throw during `getTools()` are skipped (error is logged).
   * Plugins that return an empty array are skipped (info is logged).
   * Duplicate prefixed tool names are detected — only the first is kept.
   *
   * @param plugins - Map of pluginId → active plugin instance.
   * @returns Array of SDK `Tool` objects ready for `createSession`.
   */
  aggregateTools(plugins: Map<string, CoAssistantPlugin>): SDKTool[] {
    const allTools: SDKTool[] = [];
    const seenNames = new Set<string>();

    for (const [pluginId, plugin] of plugins) {
      let rawTools: ToolDefinition[] | undefined;

      try {
        rawTools = plugin.getTools();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          { pluginId, error: message },
          `Plugin "${pluginId}" threw during getTools() — skipping`,
        );
        continue;
      }

      if (!rawTools || rawTools.length === 0) {
        this.logger.info({ pluginId }, `Plugin "${pluginId}" exposes no tools`);
        continue;
      }

      const converted = this.convertPluginTools(pluginId, rawTools);

      for (const tool of converted) {
        // defineTool returns an opaque object; we rely on the prefixed name
        // we built during conversion for duplicate detection.
        const prefixedName = `${pluginId}_${rawTools[converted.indexOf(tool)]?.name ?? ""}`;

        if (seenNames.has(prefixedName)) {
          this.logger.warn(
            { pluginId, toolName: prefixedName },
            `Duplicate tool name "${prefixedName}" — keeping first occurrence`,
          );
          continue;
        }

        seenNames.add(prefixedName);
        allTools.push(tool);
      }

      this.logger.info(
        { pluginId, toolCount: converted.length },
        `Registered ${converted.length} tool(s) from "${pluginId}"`,
      );
    }

    this.logger.info(
      { totalTools: allTools.length, pluginCount: plugins.size },
      `Aggregated ${allTools.length} tool(s) from ${plugins.size} plugin(s)`,
    );

    return allTools;
  }

  /**
   * Convert all {@link ToolDefinition} entries from a single plugin into
   * SDK-compatible tools.
   *
   * Tool names are prefixed with the plugin ID (e.g. `"gmail_send_email"`).
   * Handlers are wrapped through the sandbox for error isolation.
   *
   * @param pluginId - Unique identifier of the owning plugin.
   * @param tools    - The plugin's raw tool definitions.
   * @returns Array of SDK `Tool` objects.
   */
  convertPluginTools(pluginId: string, tools: ToolDefinition[]): SDKTool[] {
    return tools.map((tool) => this.convertTool(pluginId, tool));
  }

  /**
   * Convert a single {@link ToolDefinition} into SDK format using
   * `defineTool` from `@github/copilot-sdk`.
   *
   * @param pluginId - Unique identifier of the owning plugin.
   * @param tool     - The raw tool definition to convert.
   * @returns An SDK `Tool` object.
   */
  convertTool(pluginId: string, tool: ToolDefinition): SDKTool {
    const prefixedName = `${pluginId}_${tool.name}`;
    const prefixedDescription = `[${pluginId}] ${tool.description}`;
    const wrappedHandler = this.sandbox.wrapToolHandler(
      pluginId,
      tool.name,
      tool.handler,
    );

    return defineTool(prefixedName, {
      description: prefixedDescription,
      parameters: tool.parameters as Record<string, unknown>,
      handler: wrappedHandler as (args: unknown) => Promise<unknown>,
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Pre-configured tool aggregator wired to the default plugin sandbox. */
export const toolAggregator = new ToolAggregator(pluginSandbox);

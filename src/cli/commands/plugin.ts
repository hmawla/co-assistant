/**
 * @module cli/commands/plugin
 * @description CLI commands for plugin management — list, enable, disable,
 * inspect, and scaffold plugins.
 */

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPluginRegistry } from "../../plugins/registry.js";
import { credentialManager } from "../../plugins/credentials.js";
import type { PluginManifest } from "../../plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create and discover a fresh {@link PluginRegistry}.
 * Returns the registry and all discovered manifests.
 */
async function loadRegistry() {
  const registry = createPluginRegistry();
  const manifests = await registry.discoverPlugins();
  return { registry, manifests };
}

/**
 * Look up a plugin by ID, printing an error and exiting if not found.
 */
function requireManifest(
  manifests: PluginManifest[],
  pluginId: string,
): PluginManifest {
  const manifest = manifests.find((m) => m.id === pluginId);
  if (!manifest) {
    console.error(`✗ Plugin '${pluginId}' not found. Run 'plugin list' to see available plugins.`);
    process.exit(1);
  }
  return manifest;
}

/**
 * Convert a kebab-case plugin id to a Title Case name.
 * e.g. "my-cool-plugin" → "My Cool Plugin"
 */
function toTitleCase(id: string): string {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `plugin list` — List all discovered plugins with status and credential info. */
async function handleList(): Promise<void> {
  const { registry, manifests } = await loadRegistry();

  if (manifests.length === 0) {
    console.log("\n🔌 No plugins discovered. Add plugins to the plugins/ directory.\n");
    return;
  }

  // Credential status lookup may fail if env config is incomplete — handle gracefully.
  let credMap = new Map<string, { configured: string[]; missing: string[] }>();
  try {
    const credStatuses = credentialManager.getCredentialStatus(manifests);
    credMap = new Map(credStatuses.map((s) => [s.pluginId, s]));
  } catch {
    // Config not fully initialised — credential info will be unavailable.
  }

  console.log("\n🔌 Discovered Plugins:\n");

  for (const manifest of manifests) {
    const enabled = registry.isEnabled(manifest.id);
    const cred = credMap.get(manifest.id);

    const statusIcon = enabled ? "✅ Enabled" : "❌ Disabled";
    let credLabel: string;
    if (!manifest.requiredCredentials.length) {
      credLabel = "✓ none required";
    } else if (!cred) {
      credLabel = "⚠ unknown (config unavailable)";
    } else if (cred.missing.length === 0) {
      credLabel = "✓ configured";
    } else {
      credLabel = `✗ missing (${cred.missing.join(", ")})`;
    }

    console.log(`  ${manifest.id} (v${manifest.version}) - ${manifest.name}`);
    console.log(`  Status: ${statusIcon} | Credentials: ${credLabel}\n`);
  }
}

/** `plugin enable <id>` — Enable a plugin by ID. */
async function handleEnable(pluginId: string): Promise<void> {
  const { registry, manifests } = await loadRegistry();
  requireManifest(manifests, pluginId);

  if (registry.isEnabled(pluginId)) {
    console.log(`ℹ Plugin '${pluginId}' is already enabled.`);
    return;
  }

  registry.enablePlugin(pluginId);
  console.log(`✓ Plugin '${pluginId}' enabled`);
}

/** `plugin disable <id>` — Disable a plugin by ID. */
async function handleDisable(pluginId: string): Promise<void> {
  const { registry, manifests } = await loadRegistry();
  requireManifest(manifests, pluginId);

  if (!registry.isEnabled(pluginId)) {
    console.log(`ℹ Plugin '${pluginId}' is already disabled.`);
    return;
  }

  registry.disablePlugin(pluginId);
  console.log(`✓ Plugin '${pluginId}' disabled`);
}

/** `plugin info <id>` — Show detailed information about a plugin. */
async function handleInfo(pluginId: string): Promise<void> {
  const { registry, manifests } = await loadRegistry();
  const manifest = requireManifest(manifests, pluginId);

  const enabled = registry.isEnabled(manifest.id);
  const divider = "─".repeat(22);

  console.log(`\n📋 Plugin: ${manifest.name}`);
  console.log(divider);
  console.log(`ID:          ${manifest.id}`);
  console.log(`Version:     ${manifest.version}`);
  console.log(`Description: ${manifest.description}`);
  if (manifest.author) {
    console.log(`Author:      ${manifest.author}`);
  }
  console.log(`Status:      ${enabled ? "Enabled" : "Disabled"}`);

  if (manifest.requiredCredentials.length > 0) {
    let cred: { configured: string[]; missing: string[] } | undefined;
    try {
      const credStatuses = credentialManager.getCredentialStatus([manifest]);
      cred = credStatuses[0];
    } catch {
      // Config not fully initialised.
    }

    console.log("\nRequired Credentials:");
    for (const req of manifest.requiredCredentials) {
      const isConfigured = cred?.configured.includes(req.key) ?? false;
      const tag = isConfigured ? "[configured]" : "[missing]";
      console.log(`  ${req.key} - ${req.description} ${tag}`);
    }
  } else {
    console.log("\nNo credentials required.");
  }

  console.log();
}

/** `plugin create <id>` — Scaffold a new plugin directory from a template. */
async function handleCreate(pluginId: string): Promise<void> {
  // Validate the plugin ID is kebab-case.
  if (!/^[a-z0-9-]+$/.test(pluginId)) {
    console.error("✗ Plugin ID must be kebab-case (lowercase letters, numbers, and hyphens only).");
    process.exit(1);
  }

  const pluginDir = path.join(process.cwd(), "plugins", pluginId);

  if (existsSync(pluginDir)) {
    console.error(`✗ Directory already exists: plugins/${pluginId}/`);
    process.exit(1);
  }

  mkdirSync(pluginDir, { recursive: true });

  const displayName = toTitleCase(pluginId);

  // -- plugin.json ----------------------------------------------------------
  const manifestContent = JSON.stringify(
    {
      id: pluginId,
      name: displayName,
      version: "1.0.0",
      description: `Description of the ${displayName} plugin`,
      author: "co-assistant",
      requiredCredentials: [],
      dependencies: [],
    },
    null,
    2,
  );

  // -- index.ts -------------------------------------------------------------
  const indexContent = `import type { CoAssistantPlugin, PluginContext, ToolDefinition } from "../../src/plugins/types.js";
import { tools } from "./tools.js";

export default function createPlugin(): CoAssistantPlugin {
  return {
    id: "${pluginId}",
    name: "${displayName} Plugin",
    version: "1.0.0",
    description: "Description of your plugin",
    requiredCredentials: [],

    async initialize(context: PluginContext): Promise<void> {
      context.logger.info("Plugin initialized");
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async destroy(): Promise<void> {},

    async healthCheck(): Promise<boolean> {
      return true;
    },
  };
}
`;

  // -- tools.ts -------------------------------------------------------------
  const toolsContent = `import type { ToolDefinition } from "../../src/plugins/types.js";

/**
 * Tools exposed by the ${displayName} plugin.
 */
export const tools: ToolDefinition[] = [
  {
    name: "example",
    description: "An example tool — replace with your own",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Example input parameter" },
      },
      required: ["input"],
    },
    handler: async (args) => {
      const input = args.input as string;
      return \`Echo: \${input}\`;
    },
  },
];
`;

  // -- README.md ------------------------------------------------------------
  const readmeContent = `# ${displayName} Plugin

> Description of the ${displayName} plugin

## Setup

1. Add any required credentials to \`config.json\`:

\`\`\`json
{
  "plugins": {
    "${pluginId}": {
      "enabled": true,
      "credentials": {}
    }
  }
}
\`\`\`

2. Enable the plugin:

\`\`\`bash
co-assistant plugin enable ${pluginId}
\`\`\`

## Tools

| Tool | Description |
|------|-------------|
| \`example\` | An example tool — replace with your own |

## Development

Edit \`tools.ts\` to add or modify the tools this plugin exposes.
`;

  // Write all files.
  writeFileSync(path.join(pluginDir, "plugin.json"), manifestContent + "\n", "utf-8");
  writeFileSync(path.join(pluginDir, "index.ts"), indexContent, "utf-8");
  writeFileSync(path.join(pluginDir, "tools.ts"), toolsContent, "utf-8");
  writeFileSync(path.join(pluginDir, "README.md"), readmeContent, "utf-8");

  console.log(`✓ Plugin '${pluginId}' scaffolded at plugins/${pluginId}/`);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Registers the `plugin` subcommand on the given program.
 * Provides subcommands for managing plugins: list, enable, disable, info, create.
 */
export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command("plugin")
    .description("Manage plugins");

  plugin
    .command("list")
    .description("List all available plugins")
    .action(handleList);

  plugin
    .command("enable")
    .description("Enable a plugin")
    .argument("<id>", "Plugin ID to enable")
    .action(handleEnable);

  plugin
    .command("disable")
    .description("Disable a plugin")
    .argument("<id>", "Plugin ID to disable")
    .action(handleDisable);

  plugin
    .command("info")
    .description("Show detailed information about a plugin")
    .argument("<id>", "Plugin ID to inspect")
    .action(handleInfo);

  plugin
    .command("create")
    .description("Scaffold a new plugin from a template")
    .argument("<id>", "ID for the new plugin (kebab-case)")
    .action(handleCreate);
}

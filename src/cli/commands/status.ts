/**
 * @module cli/commands/status
 * @description CLI command to show bot and plugin status.
 * Displays configuration state, plugin status, and current model.
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { createPluginRegistry } from "../../plugins/registry.js";
import { getDatabase, closeDatabase } from "../../storage/database.js";
import { PreferencesRepository } from "../../storage/repositories/preferences.js";
import { createModelRegistry } from "../../ai/models.js";

/**
 * Registers the `status` subcommand on the given program.
 * Displays the current status of the bot and all plugins.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show bot and plugin status")
    .action(async () => {
      console.log("\n📊 Co-Assistant Status\n");

      // Config files
      const envExists = existsSync(".env");
      const configExists = existsSync("config.json");
      console.log(`  .env:         ${envExists ? "✓ found" : "✗ not found"}`);
      console.log(`  config.json:  ${configExists ? "✓ found" : "✗ not found"}`);

      // Current model
      try {
        const db = getDatabase();
        const prefs = new PreferencesRepository(db);
        const registry = createModelRegistry(prefs);
        console.log(`  AI model:     ${registry.getCurrentModelId()}`);
        closeDatabase();
      } catch {
        console.log("  AI model:     ⚠ could not determine");
      }

      // Plugins
      try {
        const pluginRegistry = createPluginRegistry();
        const manifests = await pluginRegistry.discoverPlugins();

        if (manifests.length === 0) {
          console.log("\n  🔌 No plugins discovered.\n");
        } else {
          console.log(`\n  🔌 Plugins (${manifests.length}):\n`);
          for (const m of manifests) {
            const enabled = pluginRegistry.isEnabled(m.id);
            const icon = enabled ? "✅" : "❌";
            console.log(`    ${icon} ${m.id} v${m.version}`);
          }
          console.log();
        }
      } catch {
        console.log("\n  🔌 Plugins: ⚠ could not scan\n");
      }
    });
}

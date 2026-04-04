/**
 * @module cli/commands/model
 * @description CLI command for AI model selection and configuration.
 * Provides subcommands to list available models, show the current model,
 * and set a new active model via the ModelRegistry.
 */

import { Command } from "commander";
import { getDatabase, closeDatabase } from "../../storage/database.js";
import { PreferencesRepository } from "../../storage/repositories/preferences.js";
import { createModelRegistry } from "../../ai/models.js";
import type { ModelInfo } from "../../ai/models.js";

/**
 * Create a {@link ModelRegistry} backed by the singleton database.
 * Caller is responsible for calling {@link closeDatabase} when done.
 */
function initRegistry() {
  const db = getDatabase();
  const prefs = new PreferencesRepository(db);
  return createModelRegistry(prefs);
}

/**
 * Render a table of models to the console.
 * Marks the currently-selected model with an asterisk prefix.
 */
function printModelTable(models: ModelInfo[], currentId: string): void {
  const idHeader = "ID";
  const providerHeader = "Provider";
  const descHeader = "Description";

  const idWidth = Math.max(idHeader.length, ...models.map((m) => m.id.length + 2)); // +2 for "* " prefix
  const providerWidth = Math.max(providerHeader.length, ...models.map((m) => m.provider.length));
  const descWidth = Math.max(descHeader.length, ...models.map((m) => m.description.length));

  const pad = (str: string, len: number) => str + " ".repeat(Math.max(0, len - str.length));
  const row = (id: string, prov: string, desc: string) =>
    `│ ${pad(id, idWidth)} │ ${pad(prov, providerWidth)} │ ${pad(desc, descWidth)} │`;

  const top = `┌─${"─".repeat(idWidth)}─┬─${"─".repeat(providerWidth)}─┬─${"─".repeat(descWidth)}─┐`;
  const mid = `├─${"─".repeat(idWidth)}─┼─${"─".repeat(providerWidth)}─┼─${"─".repeat(descWidth)}─┤`;
  const bot = `└─${"─".repeat(idWidth)}─┴─${"─".repeat(providerWidth)}─┴─${"─".repeat(descWidth)}─┘`;

  console.log("\nAvailable Models:");
  console.log(top);
  console.log(row(idHeader, providerHeader, descHeader));
  console.log(mid);

  for (const m of models) {
    const label = m.id === currentId ? `* ${m.id}` : `  ${m.id}`;
    console.log(row(label, m.provider, m.description));
  }

  console.log(bot);
  console.log("* = currently selected\n");
}

/**
 * Registers the `model` subcommand on the given program.
 * Provides subcommands for managing AI models: list, get, set.
 */
export function registerModelCommand(program: Command): void {
  const model = program
    .command("model")
    .description("Manage AI models");

  // -- model list --------------------------------------------------------
  model
    .command("list")
    .description("List all available AI models")
    .action(async () => {
      try {
        const registry = initRegistry();
        const models = registry.getAvailableModels();
        const currentId = registry.getCurrentModelId();
        printModelTable(models, currentId);
      } finally {
        closeDatabase();
      }
    });

  // -- model get ---------------------------------------------------------
  model
    .command("get")
    .description("Show the currently configured AI model")
    .action(async () => {
      try {
        const registry = initRegistry();
        const currentId = registry.getCurrentModelId();
        console.log(`Current model: ${currentId}`);
      } finally {
        closeDatabase();
      }
    });

  // -- model set <modelId> -----------------------------------------------
  model
    .command("set")
    .description("Set the active AI model")
    .argument("<modelId>", "Model identifier to activate")
    .action(async (modelId: string) => {
      try {
        const registry = initRegistry();

        if (!registry.isValidModel(modelId)) {
          console.log(`⚠ Warning: '${modelId}' is not in the known models list`);
        }

        registry.setCurrentModel(modelId);
        console.log(`✓ Model set to: ${modelId}`);
      } finally {
        closeDatabase();
      }
    });
}

/**
 * @module cli/commands/start
 * @description CLI command to start the Co-Assistant Telegram bot.
 * Creates an {@link App} instance and boots all subsystems.
 */

import { Command } from "commander";
import { App } from "../../core/app.js";

/**
 * Registers the `start` subcommand on the given Commander program.
 *
 * @param program - The root Commander program instance.
 */
export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Co-Assistant bot")
    .option("-v, --verbose", "Enable verbose/debug logging")
    .action(async (options) => {
      const app = new App();
      await app.start({ verbose: options.verbose });
    });
}

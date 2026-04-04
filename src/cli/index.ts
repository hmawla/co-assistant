#!/usr/bin/env node

/**
 * @module cli/index
 * @description CLI entry point using Commander.js for the co-assistant CLI.
 * Registers all subcommands and parses process arguments.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { setLogLevel } from "../core/logger.js";
import { registerStartCommand } from "./commands/start.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerPluginCommand } from "./commands/plugin.js";
import { registerModelCommand } from "./commands/model.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerHeartbeatCommand } from "./commands/heartbeat.js";

// Suppress pino logs in CLI mode unless explicitly overridden.
if (!process.env.LOG_LEVEL) {
  setLogLevel("silent");
}

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("co-assistant")
  .description("AI-powered Telegram personal assistant using GitHub Copilot SDK")
  .version(pkg.version);

registerStartCommand(program);
registerSetupCommand(program);
registerPluginCommand(program);
registerModelCommand(program);
registerHeartbeatCommand(program);
registerStatusCommand(program);

program.parse(process.argv);

/**
 * @module gmail
 * @description Gmail plugin entry point.
 *
 * Provides email searching, reading, and sending capabilities via the
 * Gmail REST API. This plugin serves as a reference implementation for
 * building Co-Assistant plugins.
 */

import type {
  CoAssistantPlugin,
  PluginContext,
  ToolDefinition,
} from "../../src/plugins/types.js";
import { GmailAuth } from "./auth.js";
import { createGmailTools } from "./tools.js";

/**
 * Factory function that creates a new Gmail plugin instance.
 *
 * The plugin follows the standard Co-Assistant lifecycle:
 * 1. `initialize()` — sets up the OAuth2 auth helper and creates tool defs.
 * 2. `getTools()`   — returns the tool definitions for the AI session.
 * 3. `destroy()`    — cleans up resources (no-op for this plugin).
 *
 * @returns A fully-formed {@link CoAssistantPlugin} for Gmail integration.
 */
export default function createPlugin(): CoAssistantPlugin {
  let auth: GmailAuth;
  let toolDefs: ToolDefinition[];

  return {
    id: "gmail",
    name: "Gmail Plugin",
    version: "1.0.0",
    description: "Send, read, and search Gmail messages",
    requiredCredentials: [
      "GMAIL_CLIENT_ID",
      "GMAIL_CLIENT_SECRET",
      "GMAIL_REFRESH_TOKEN",
    ],

    async initialize(context: PluginContext) {
      auth = new GmailAuth(
        context.credentials.GMAIL_CLIENT_ID,
        context.credentials.GMAIL_CLIENT_SECRET,
        context.credentials.GMAIL_REFRESH_TOKEN,
      );

      toolDefs = createGmailTools(auth, context.logger);
      context.logger.info("Gmail plugin initialized");
    },

    getTools(): ToolDefinition[] {
      return toolDefs;
    },

    async destroy() {
      // No persistent connections or resources to release.
    },

    async healthCheck(): Promise<boolean> {
      return auth.isConfigured();
    },
  };
}

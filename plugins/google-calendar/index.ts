/**
 * @module google-calendar
 * @description Google Calendar plugin — view, create, update, and delete
 * calendar events via the Google Calendar v3 API.
 *
 * This is a reference implementation showing how to build a fully-featured
 * Co-Assistant plugin with OAuth2 authentication and multiple tool definitions.
 */

import type {
  CoAssistantPlugin,
  PluginContext,
  PluginFactory,
  ToolDefinition,
} from "../../src/plugins/types.js";
import { CalendarAuth } from "./auth.js";
import { createCalendarTools } from "./tools.js";

/**
 * Factory function that creates a new Google Calendar plugin instance.
 *
 * This is the default export expected by the plugin loader (see
 * {@link PluginFactory}).
 */
const createPlugin: PluginFactory = (): CoAssistantPlugin => {
  let auth: CalendarAuth;
  let tools: ToolDefinition[] = [];
  let logger: PluginContext["logger"];

  return {
    id: "google-calendar",
    name: "Google Calendar Plugin",
    version: "1.0.0",
    description: "View, create, and manage Google Calendar events",
    requiredCredentials: [
      "GCAL_CLIENT_ID",
      "GCAL_CLIENT_SECRET",
      "GCAL_REFRESH_TOKEN",
    ],

    async initialize(context: PluginContext): Promise<void> {
      logger = context.logger;
      logger.info("Initialising Google Calendar plugin…");

      auth = new CalendarAuth(
        context.credentials.GCAL_CLIENT_ID,
        context.credentials.GCAL_CLIENT_SECRET,
        context.credentials.GCAL_REFRESH_TOKEN,
      );

      if (!auth.isConfigured()) {
        throw new Error(
          "Google Calendar plugin is missing one or more required credentials.",
        );
      }

      tools = createCalendarTools(auth);
      logger.info(`Registered ${tools.length} calendar tools`);
    },

    getTools(): ToolDefinition[] {
      return tools;
    },

    async destroy(): Promise<void> {
      tools = [];
      logger?.info("Google Calendar plugin destroyed");
    },

    async healthCheck(): Promise<boolean> {
      try {
        // A lightweight token refresh confirms the credentials are still valid.
        await auth.getAccessToken();
        return true;
      } catch {
        return false;
      }
    },
  };
};

export default createPlugin;

# Plugin Development Guide

Plugins are the primary way to extend Co-Assistant with new capabilities. Each plugin exposes one or more **tools** that the AI model can invoke during a conversation — searching emails, creating calendar events, fetching weather data, or anything else you can build with an API.

This guide walks you through building a plugin from scratch. You'll learn the interfaces, the lifecycle, and the patterns that make a plugin production-ready.

> **Prerequisites:** Familiarity with TypeScript and Node.js. No prior knowledge of the Co-Assistant codebase is required.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Plugin Structure](#plugin-structure)
3. [Plugin Manifest (plugin.json)](#plugin-manifest-pluginjson)
4. [The CoAssistantPlugin Interface](#the-coassistantplugin-interface)
5. [PluginContext — What's Available at Runtime](#plugincontext--whats-available-at-runtime)
6. [Defining Tools](#defining-tools)
7. [Credential Management](#credential-management)
8. [State Management](#state-management)
9. [Error Handling](#error-handling)
10. [Health Checks](#health-checks)
11. [Testing Your Plugin](#testing-your-plugin)
12. [Complete Example — The Gmail Plugin](#complete-example--the-gmail-plugin)
13. [Best Practices](#best-practices)

---

## Quick Start

The fastest way to create a new plugin is with the built-in scaffold command:

```bash
co-assistant plugin create my-plugin
```

This generates a ready-to-edit directory under `plugins/`:

```
plugins/my-plugin/
├── plugin.json    # Plugin manifest (metadata + credential requirements)
├── index.ts       # Plugin entry point (factory function)
├── tools.ts       # AI tool definitions
└── README.md      # Plugin documentation
```

Enable it:

```bash
co-assistant plugin enable my-plugin
```

List all discovered plugins to verify:

```bash
co-assistant plugin list
```

Get detailed info about a specific plugin:

```bash
co-assistant plugin info my-plugin
```

That's it — you now have a working plugin. The rest of this guide explains how to customise every part of it.

---

## Plugin Structure

Every plugin lives in its own subdirectory under `plugins/`. The directory name should match the plugin's `id`.

```
plugins/my-plugin/
├── plugin.json         # Required — manifest with metadata and credential declarations
├── index.ts            # Required — default export is a factory that returns a CoAssistantPlugin
├── tools.ts            # Recommended — tool definitions, kept separate for clarity
├── auth.ts             # Optional — authentication helpers (OAuth, API key management)
└── README.md           # Optional — human-readable documentation
```

### Required files

| File | Purpose |
|------|---------|
| `plugin.json` | Declarative metadata validated at load time. Defines the plugin's identity, version, credential requirements, and dependencies. |
| `index.ts` | Must default-export (or named-export `createPlugin`) a **factory function** that returns a `CoAssistantPlugin` object. |

### Recommended files

| File | Purpose |
|------|---------|
| `tools.ts` | Keep tool definitions in a separate file so `index.ts` stays focused on lifecycle. |
| `auth.ts` | Encapsulate API authentication logic (token refresh, header generation). |
| `README.md` | Explain what the plugin does, what credentials are needed, and how to set it up. |

---

## Plugin Manifest (plugin.json)

The manifest is validated against a Zod schema (`PluginManifestSchema`) when the registry discovers your plugin. If validation fails, the plugin is skipped with a warning.

### Full schema

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A short description of what this plugin does",
  "author": "your-name",
  "requiredCredentials": [
    {
      "key": "MY_API_KEY",
      "description": "API key for the My Service API",
      "type": "apikey"
    }
  ],
  "dependencies": []
}
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | ✅ | Unique identifier. **Must be kebab-case** (`a-z`, `0-9`, `-` only). Must match the directory name. |
| `name` | `string` | ✅ | Human-readable display name. |
| `version` | `string` | ✅ | Semantic version in strict `MAJOR.MINOR.PATCH` format (e.g. `"1.2.3"`). |
| `description` | `string` | ✅ | Brief description shown in `plugin list` and `plugin info`. |
| `author` | `string` | — | Author or organisation name. |
| `requiredCredentials` | `array` | — | Credentials the plugin needs. Defaults to `[]`. See [Credential Management](#credential-management). |
| `dependencies` | `array` | — | IDs of other plugins this plugin depends on. Dependencies are loaded first. Defaults to `[]`. |

### Credential requirement objects

Each entry in `requiredCredentials` has the following shape:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `key` | `string` | — | The credential key used to look up the value at runtime. |
| `description` | `string` | — | Human-readable explanation shown during setup. |
| `type` | `"text"` \| `"oauth"` \| `"apikey"` | `"text"` | Hint for the setup wizard about the kind of credential. |

### Example — plugin with OAuth credentials

```json
{
  "id": "gmail",
  "name": "Gmail Plugin",
  "version": "1.0.0",
  "description": "Send, read, and search Gmail messages via the Gmail API",
  "author": "co-assistant",
  "requiredCredentials": [
    { "key": "GMAIL_CLIENT_ID", "description": "Google OAuth2 Client ID", "type": "oauth" },
    { "key": "GMAIL_CLIENT_SECRET", "description": "Google OAuth2 Client Secret", "type": "oauth" },
    { "key": "GMAIL_REFRESH_TOKEN", "description": "Google OAuth2 Refresh Token", "type": "oauth" }
  ],
  "dependencies": []
}
```

### Example — plugin with no credentials

```json
{
  "id": "hello-world",
  "name": "Hello World",
  "version": "1.0.0",
  "description": "A minimal example plugin that needs no credentials",
  "author": "co-assistant",
  "requiredCredentials": [],
  "dependencies": []
}
```

---

## The CoAssistantPlugin Interface

Every plugin is a plain object that implements the `CoAssistantPlugin` interface. Your entry point (`index.ts`) must export a **factory function** — a zero-argument function that returns a fresh plugin instance.

```ts
// plugins/types.ts — simplified
export interface CoAssistantPlugin {
  id: string;                       // Unique identifier (kebab-case)
  name: string;                     // Display name
  version: string;                  // Semantic version
  description: string;              // Short description
  requiredCredentials: string[];    // Credential keys this plugin needs

  initialize(context: PluginContext): Promise<void>;
  getTools(): ToolDefinition[];
  destroy(): Promise<void>;
  healthCheck(): Promise<boolean>;
}

export type PluginFactory = () => CoAssistantPlugin;
```

### Method-by-method walkthrough

#### `initialize(context: PluginContext): Promise<void>`

Called **exactly once** after the plugin is loaded and credentials are verified. Use this to:

- Set up API clients
- Open connections
- Create tool definitions that depend on runtime context

```ts
async initialize(context: PluginContext) {
  this.apiClient = new MyApiClient(context.credentials.MY_API_KEY);
  this.tools = createMyTools(this.apiClient, context.logger);
  context.logger.info("Plugin initialized");
}
```

#### `getTools(): ToolDefinition[]`

Called after `initialize()`. Returns the array of tool definitions that this plugin exposes to the AI model. The plugin manager prefixes each tool's name with the plugin ID automatically (e.g. `my-plugin__search`).

```ts
getTools(): ToolDefinition[] {
  return this.tools;
}
```

#### `destroy(): Promise<void>`

Called during graceful shutdown. Clean up resources — close HTTP connections, flush buffers, release file handles.

```ts
async destroy() {
  await this.apiClient.disconnect();
}
```

#### `healthCheck(): Promise<boolean>`

Called periodically by the sandbox. Return `true` if the plugin is fully operational.

```ts
async healthCheck(): Promise<boolean> {
  return this.apiClient.isConnected();
}
```

### Minimal complete example

```ts
// plugins/hello-world/index.ts
import type {
  CoAssistantPlugin,
  PluginContext,
  ToolDefinition,
} from "../../src/plugins/types.js";

export default function createPlugin(): CoAssistantPlugin {
  let ctx: PluginContext;

  return {
    id: "hello-world",
    name: "Hello World",
    version: "1.0.0",
    description: "A minimal example plugin",
    requiredCredentials: [],

    async initialize(context) {
      ctx = context;
      ctx.logger.info("Hello World plugin initialized");
    },

    getTools(): ToolDefinition[] {
      return [
        {
          name: "greet",
          description: "Say hello to someone",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name to greet" },
            },
            required: ["name"],
          },
          handler: async (args) => {
            const name = args.name as string;
            return `Hello, ${name}! 👋`;
          },
        },
      ];
    },

    async destroy() {},

    async healthCheck() {
      return true;
    },
  };
}
```

### Factory export conventions

The plugin manager accepts either of these export styles:

```ts
// Option 1: default export (preferred)
export default function createPlugin(): CoAssistantPlugin { … }

// Option 2: named export
export function createPlugin(): CoAssistantPlugin { … }
```

---

## PluginContext — What's Available at Runtime

When `initialize()` is called, the plugin receives a `PluginContext` object with everything it needs:

```ts
export interface PluginContext {
  pluginId: string;                    // Your plugin's ID
  credentials: Record<string, string>; // Pre-validated credential values
  state: PluginStateStore;             // Namespaced persistent storage
  logger: Logger;                      // Pino child logger tagged with your plugin ID
}
```

### `credentials`

A key-value map of all credentials declared in your manifest. All keys listed in `requiredCredentials` are **guaranteed** to be present and non-empty by the time `initialize()` is called.

```ts
async initialize(context: PluginContext) {
  const apiKey = context.credentials.MY_API_KEY;
  // Safe to use — validated before initialize() was called
}
```

### `state`

A namespaced key-value store for persistent data. Keys are automatically scoped to your plugin — you can't accidentally read or write another plugin's data.

```ts
export interface PluginStateStore {
  get(key: string): string | null;            // Read a value (null if missing)
  set(key: string, value: string): void;      // Write a value
  delete(key: string): void;                  // Remove a key
  getAll(): Record<string, string>;           // Snapshot of all your data
}
```

See [State Management](#state-management) for usage patterns.

### `logger`

A [Pino](https://github.com/pinojs/pino) child logger. All log entries are automatically tagged with your plugin ID, so you never need to add it manually.

```ts
context.logger.info("Plugin initialized");
context.logger.debug({ query }, "Searching...");
context.logger.error({ error: err.message }, "API call failed");
```

---

## Defining Tools

Tools are the core of a plugin — they're what the AI model actually calls. Each tool is a `ToolDefinition` object:

```ts
export interface ToolDefinition {
  name: string;                               // Tool name (without plugin prefix)
  description: string;                        // Tells the AI when to use this tool
  parameters: Record<string, unknown> | ZodType; // Parameter schema
  handler: (args: Record<string, unknown>) => Promise<string | Record<string, unknown>>;
}
```

### Tool naming

You only provide the short name. The plugin manager automatically prefixes it with your plugin ID using a double underscore separator:

- You define: `name: "search_emails"`
- AI model sees: `gmail__search_emails`

This guarantees uniqueness across all plugins.

### Parameter schemas

You have two options for declaring parameters:

#### Option A: JSON Schema (simple, no dependencies)

```ts
const tool: ToolDefinition = {
  name: "lookup",
  description: "Look up a record by ID",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Record ID to look up" },
      includeDetails: { type: "boolean", description: "Include full details" },
    },
    required: ["id"],
  },
  handler: async (args) => { /* ... */ },
};
```

#### Option B: Zod schema (type-safe, with validation)

```ts
import { z } from "zod";

const tool: ToolDefinition = {
  name: "search_emails",
  description: "Search for emails using a query string",
  parameters: z.object({
    query: z.string().describe("Search query"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Maximum number of results"),
  }),
  handler: async (args) => { /* ... */ },
};
```

Zod schemas are automatically converted to JSON Schema at registration time. Use `.describe()` on each field — these descriptions help the AI model understand what to pass.

### Handler patterns

Handlers receive parsed arguments and must return either a `string` or a `Record<string, unknown>` (JSON-serializable object).

**Return a string** for simple text responses:

```ts
handler: async (args) => {
  const name = args.name as string;
  return `Hello, ${name}!`;
}
```

**Return an object** for structured data the AI can reason about:

```ts
handler: async (args) => {
  const results = await searchApi(args.query as string);
  return {
    resultCount: results.length,
    items: results.map(r => ({ id: r.id, title: r.title })),
  };
}
```

**Return an error string** on failure (never throw — see [Error Handling](#error-handling)):

```ts
handler: async (args) => {
  try {
    const data = await fetchData(args.id as string);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error fetching data: ${message}`;
  }
}
```

### Organising tools in a separate file

Keep `index.ts` focused on lifecycle and put tool definitions in `tools.ts`:

```ts
// plugins/my-plugin/tools.ts
import { z } from "zod";
import type { ToolDefinition } from "../../src/plugins/types.js";

export function createTools(apiClient: MyApiClient, logger: Logger): ToolDefinition[] {
  return [
    {
      name: "search",
      description: "Search for items",
      parameters: z.object({
        query: z.string().describe("Search query"),
      }),
      handler: async (args) => {
        try {
          const results = await apiClient.search(args.query as string);
          logger.debug({ count: results.length }, "Search completed");
          return { results };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ error: message }, "Search failed");
          return `Error: ${message}`;
        }
      },
    },
  ];
}
```

```ts
// plugins/my-plugin/index.ts
import type { CoAssistantPlugin, PluginContext, ToolDefinition } from "../../src/plugins/types.js";
import { createTools } from "./tools.js";

export default function createPlugin(): CoAssistantPlugin {
  let tools: ToolDefinition[];

  return {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    description: "Does something useful",
    requiredCredentials: ["MY_API_KEY"],

    async initialize(context: PluginContext) {
      const client = new MyApiClient(context.credentials.MY_API_KEY);
      tools = createTools(client, context.logger);
    },

    getTools: () => tools,
    async destroy() {},
    async healthCheck() { return true; },
  };
}
```

---

## Credential Management

### How credentials are stored

Credentials live in `config.json` under the `plugins.<pluginId>.credentials` key:

```json
{
  "plugins": {
    "my-plugin": {
      "enabled": true,
      "credentials": {
        "MY_API_KEY": "sk-abc123..."
      }
    }
  }
}
```

### How they're declared

In your `plugin.json`, list every credential key your plugin needs:

```json
{
  "requiredCredentials": [
    {
      "key": "MY_API_KEY",
      "description": "API key for the My Service API",
      "type": "apikey"
    },
    {
      "key": "MY_WEBHOOK_SECRET",
      "description": "Webhook signing secret",
      "type": "text"
    }
  ]
}
```

### How validation works

Before `initialize()` is called, the `CredentialManager` verifies that every key declared in `requiredCredentials` exists in config and has a non-empty value. If any are missing:

1. A warning is logged with the list of missing keys.
2. The plugin is loaded with empty credentials (it can still start, but API calls will likely fail).

### Credential types

| Type | Meaning |
|------|---------|
| `"text"` | Generic text secret (default). |
| `"apikey"` | An API key — hints to the setup wizard to treat it as a secret. |
| `"oauth"` | OAuth token or related credential. |

The `type` field is a hint for the setup wizard and CLI display. At runtime, all credentials are plain strings regardless of type.

### Accessing credentials at runtime

Inside `initialize()`, credentials are available on the context:

```ts
async initialize(context: PluginContext) {
  const apiKey = context.credentials.MY_API_KEY;
  const secret = context.credentials.MY_WEBHOOK_SECRET;
}
```

### Checking credential status via CLI

```bash
# See which credentials are configured vs missing
co-assistant plugin info my-plugin
```

Output:

```
📋 Plugin: My Plugin
──────────────────────
ID:          my-plugin
Version:     1.0.0
Description: Does something useful
Status:      Enabled

Required Credentials:
  MY_API_KEY - API key for the My Service API [configured]
  MY_WEBHOOK_SECRET - Webhook signing secret [missing]
```

---

## State Management

Each plugin gets a **namespaced key-value store** that persists across restarts. Use it for caching, user preferences, pagination cursors, or any data your plugin needs to remember.

### Basic operations

```ts
async initialize(context: PluginContext) {
  const { state } = context;

  // Store a value
  state.set("last-sync", new Date().toISOString());

  // Read a value (returns null if not found)
  const lastSync = state.get("last-sync");

  // Delete a value
  state.delete("temp-data");

  // Get everything
  const allData = state.getAll();
  // => { "last-sync": "2024-01-15T10:30:00.000Z" }
}
```

### Using state in tool handlers

Capture the state store in a closure so tool handlers can access it:

```ts
export default function createPlugin(): CoAssistantPlugin {
  let state: PluginStateStore;

  return {
    // ...
    async initialize(context) {
      state = context.state;
    },

    getTools() {
      return [{
        name: "get_preference",
        description: "Get a saved preference",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Preference key" },
          },
          required: ["key"],
        },
        handler: async (args) => {
          const value = state.get(args.key as string);
          return value ?? "No preference set for that key.";
        },
      }];
    },
    // ...
  };
}
```

### Important notes

- **Keys are automatically namespaced** — `state.set("foo", "bar")` only affects your plugin. Another plugin setting `"foo"` is completely independent.
- **Values are strings** — to store complex data, `JSON.stringify()` on write and `JSON.parse()` on read.
- **Storage is synchronous** — `get`, `set`, and `delete` are synchronous calls backed by SQLite.

---

## Error Handling

The plugin system is designed to be resilient. A single broken plugin should **never** crash the assistant or affect other plugins.

### The golden rule: never throw from tool handlers

Tool handlers are called by the AI model. If a handler throws, the sandbox catches it and returns a generic error message. You lose the opportunity to provide helpful context. Instead, catch errors yourself and return a descriptive string:

```ts
// ✅ Good — return an error string
handler: async (args) => {
  try {
    const data = await apiClient.fetch(args.id as string);
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "API call failed");
    return `Error fetching data: ${message}`;
  }
}

// ❌ Bad — throwing propagates to the sandbox
handler: async (args) => {
  const data = await apiClient.fetch(args.id as string); // might throw!
  return { success: true, data };
}
```

### How the sandbox protects you

The `PluginSandbox` wraps every plugin method call (`initialize`, `destroy`, tool handlers) in a try/catch boundary:

1. **Errors never propagate** into the host process.
2. **Consecutive failures are counted** per plugin.
3. **Auto-disable** kicks in after 5 consecutive failures (configurable via `pluginHealth.maxFailures` in `config.json`). When a plugin is auto-disabled, all its tool calls return an error message instead of executing.
4. **A successful call resets the counter** — proving the plugin has recovered.

When a tool handler throws, the AI model receives:

```
Error: Tool search_emails failed: unexpected error during execution
```

When a plugin is auto-disabled:

```
Error: Tool search_emails failed: plugin has been disabled due to repeated failures
```

### Best practices

- Always wrap external API calls in try/catch.
- Return error strings that include enough context for the AI to explain the failure to the user.
- Log errors with the plugin logger so they appear in the application logs.
- Never let credential values leak into error messages or logs.

---

## Health Checks

The `healthCheck()` method is called periodically to verify your plugin is operational.

### What makes a good health check

A health check should verify the **core dependency** of your plugin:

```ts
// ✅ Good — verifies the essential resource
async healthCheck(): Promise<boolean> {
  return this.apiClient.isConnected();
}

// ✅ Good — verifies credentials are still valid
async healthCheck(): Promise<boolean> {
  try {
    await this.auth.getAccessToken();
    return true;
  } catch {
    return false;
  }
}

// ❌ Bad — always returns true (not useful)
async healthCheck(): Promise<boolean> {
  return true;
}
```

### Health check failures

Failed health checks increment the sandbox's failure counter. After `maxFailures` consecutive failures (default: 5), the plugin is auto-disabled. The counter resets on any successful operation.

---

## Testing Your Plugin

### 1. Scaffold and enable

```bash
co-assistant plugin create my-plugin
co-assistant plugin enable my-plugin
```

### 2. Verify discovery

```bash
co-assistant plugin list
```

You should see your plugin listed as enabled.

### 3. Check credentials (if applicable)

```bash
co-assistant plugin info my-plugin
```

Ensure all required credentials show `[configured]`.

### 4. Start the assistant

Start Co-Assistant and interact with it via Telegram (or your configured interface). Ask the AI to use your plugin's tools:

> "Use the my-plugin example tool with input 'test'"

### 5. Check logs

Review the application logs for entries tagged with your plugin ID. The namespaced logger makes it easy to filter:

```bash
# Look for your plugin's log entries
cat logs/app.log | grep '"pluginId":"my-plugin"'
```

### 6. Iterate

- Edit `tools.ts` to refine your tool definitions.
- Restart the assistant to pick up changes.
- Use `plugin disable` / `plugin enable` to toggle without removing files.

---

## Complete Example — The Gmail Plugin

The Gmail plugin is the reference implementation. Let's walk through every file.

### `plugins/gmail/plugin.json`

```json
{
  "id": "gmail",
  "name": "Gmail Plugin",
  "version": "1.0.0",
  "description": "Send, read, and search Gmail messages via the Gmail API",
  "author": "co-assistant",
  "requiredCredentials": [
    { "key": "GMAIL_CLIENT_ID", "description": "Google OAuth2 Client ID", "type": "oauth" },
    { "key": "GMAIL_CLIENT_SECRET", "description": "Google OAuth2 Client Secret", "type": "oauth" },
    { "key": "GMAIL_REFRESH_TOKEN", "description": "Google OAuth2 Refresh Token", "type": "oauth" }
  ],
  "dependencies": []
}
```

Three OAuth credentials are declared. The `"type": "oauth"` hints to the setup wizard that these are part of an OAuth flow.

### `plugins/gmail/index.ts`

```ts
import type {
  CoAssistantPlugin,
  PluginContext,
  ToolDefinition,
} from "../../src/plugins/types.js";
import { GmailAuth } from "./auth.js";
import { createGmailTools } from "./tools.js";

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
      // Create the auth helper using validated credentials
      auth = new GmailAuth(
        context.credentials.GMAIL_CLIENT_ID,
        context.credentials.GMAIL_CLIENT_SECRET,
        context.credentials.GMAIL_REFRESH_TOKEN,
      );

      // Build tool definitions that close over the auth helper
      toolDefs = createGmailTools(auth, context.logger);
      context.logger.info("Gmail plugin initialized");
    },

    getTools(): ToolDefinition[] {
      return toolDefs;
    },

    async destroy() {
      // No persistent connections to close
    },

    async healthCheck(): Promise<boolean> {
      // Verify credentials are present
      return auth.isConfigured();
    },
  };
}
```

Key patterns to note:

- **Factory function** — `createPlugin()` returns a fresh plugin instance with private state captured in a closure (`auth`, `toolDefs`).
- **Credentials are used in `initialize()`** — the `GmailAuth` helper is constructed with the pre-validated credential values.
- **Tools are built during initialization** — they close over the `auth` instance and the `logger`.
- **Health check is meaningful** — it verifies the auth helper has non-empty credentials.

### `plugins/gmail/auth.ts`

```ts
export class GmailAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    // Refresh the token using the Google OAuth2 endpoint
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh token (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}
```

This pattern — a dedicated auth class that caches tokens and refreshes transparently — is reusable for any OAuth-based plugin.

### `plugins/gmail/tools.ts`

The Gmail plugin defines five tools:

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_threads` | Search Gmail threads with full message history | `query` (string), `maxThreads` (number, optional), `includeLatestBody` (boolean, optional) |
| `get_thread` | Get a full thread by ID with all messages | `threadId` (string) |
| `search_emails` | Search Gmail with a query string | `query` (string), `maxResults` (number, optional), `includeBody` (boolean, optional) |
| `read_email` | Read the full content of an email | `messageId` (string) |
| `send_email` | Send an email | `to` (string), `subject` (string), `body` (string) |

Here's the `search_emails` tool as an example of the pattern:

```ts
import { z } from "zod";
import type { ToolDefinition } from "../../src/plugins/types.js";

const searchEmails: ToolDefinition = {
  name: "search_emails",
  description:
    "Search for emails in Gmail using a query string (same syntax as the Gmail search bar)",
  parameters: z.object({
    query: z.string().describe("Gmail search query"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Maximum number of results to return"),
  }),

  handler: async (args) => {
    try {
      const query = args.query as string;
      const maxResults = (args.maxResults as number | undefined) ?? 10;

      // 1. List message IDs
      const listRes = await fetch(`${GMAIL_API}/messages?q=${query}&maxResults=${maxResults}`, {
        headers: await authHeaders(auth),
      });

      if (!listRes.ok) {
        return `Error searching emails (${listRes.status}): ${await listRes.text()}`;
      }

      const listData = await listRes.json();
      if (!listData.messages?.length) {
        return "No emails found matching that query.";
      }

      // 2. Fetch metadata for each message
      const results = await Promise.all(
        listData.messages.map(async (msg) => {
          // ... fetch and format each message
        }),
      );

      // 3. Return structured data
      return {
        resultCount: results.length,
        estimatedTotal: listData.resultSizeEstimate ?? results.length,
        messages: results,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error searching emails: ${message}`;
    }
  },
};
```

Notice the pattern every tool follows:

1. **Extract and validate arguments** from the `args` object.
2. **Call the external API** with proper authentication.
3. **Handle HTTP errors** by returning descriptive error strings.
4. **Return structured data** for successful results.
5. **Wrap everything in try/catch** — never let exceptions escape.

### Configuration in `config.json`

```json
{
  "plugins": {
    "gmail": {
      "enabled": true,
      "credentials": {
        "GMAIL_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GMAIL_CLIENT_SECRET": "your-client-secret",
        "GMAIL_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

---

## Best Practices

### Plugin isolation

- Each plugin runs in its own logical sandbox. Errors are caught and counted — they never crash other plugins or the host process.
- State is namespaced — your `state.set("key", "value")` can never collide with another plugin's keys.
- Tool names are prefixed — `my-plugin__tool-name` — so naming conflicts are impossible.

### Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Plugin ID | kebab-case | `google-calendar` |
| Plugin directory | Matches ID | `plugins/google-calendar/` |
| Tool names | snake_case | `search_emails`, `send_email` |
| Credential keys | UPPER_SNAKE_CASE | `GMAIL_CLIENT_ID` |

### Credential security

- **Never log credential values.** The logger is for debugging — use it for keys, not values.
- **Store credentials in `config.json` only** — never hard-code them in plugin source.
- **Keep `config.json` out of version control** — it's in `.gitignore` for a reason. Commit `config.json.example` with empty placeholder values instead.

### Code organisation

- Keep `index.ts` small — it should only handle the lifecycle (`initialize`, `getTools`, `destroy`, `healthCheck`).
- Put tool definitions in `tools.ts`.
- Put authentication logic in `auth.ts`.
- Each file should have a single responsibility.

### Tool design

- **Write clear descriptions** — the AI model reads them to decide when to invoke your tool. Be specific about what the tool does and what the parameters mean.
- **Use Zod schemas** when you want parameter validation and rich `.describe()` annotations.
- **Return structured data** (objects) rather than formatted strings when the result has multiple fields. The AI can format the data for the user more naturally.
- **Handle partial failures gracefully** — if one item in a batch fails, return the successful results alongside error information rather than failing the entire call.

### Performance

- **Cache tokens and expensive computations** — the Gmail plugin caches access tokens and only refreshes when they expire.
- **Use `Promise.all` for independent requests** — the Gmail search tool fetches message metadata in parallel.
- **Set reasonable defaults** — limit result counts (e.g. `maxResults` defaults to 10) to avoid slow responses.

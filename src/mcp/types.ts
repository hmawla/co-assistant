/**
 * @module mcp/types
 * @description Type definitions and Zod schemas for MCP server configuration.
 *
 * Co-assistant stores MCP server definitions in `config.json` under the `mcp`
 * key. Each definition mirrors the shape expected by the Copilot SDK's
 * `createSession({ mcpServers })` option, extended with two metadata fields:
 *
 * - **`name`** — human-readable display label (not passed to the SDK)
 * - **`enabled`** — when `false` the server is excluded at session creation time
 *
 * The {@link toSdkMcpServers} helper converts a stored {@link McpConfig} into
 * the exact object the SDK expects: disabled servers are filtered out and the
 * `name`/`enabled` metadata fields are stripped.  Environment-variable
 * placeholders (`${VAR}`) inside `headers` and `env` values are resolved
 * against `process.env` at call time so secrets can live in `.env`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas — Local (stdio) server
// ---------------------------------------------------------------------------

/**
 * Zod schema for a **local / stdio** MCP server.
 *
 * The Copilot SDK spawns the specified `command` as a child process and
 * communicates with it over stdin/stdout.  Ideal for local tools, file
 * access, and custom scripts.
 */
export const McpLocalServerConfigSchema = z.object({
  /** Discriminant — `"local"` or `"stdio"` (both accepted by the SDK). */
  type: z.enum(["local", "stdio"]).default("local"),

  /** Human-readable display name (co-assistant metadata, not sent to SDK). */
  name: z.string().min(1),

  /** Whether this server is active. Disabled servers are excluded from sessions. */
  enabled: z.boolean().default(true),

  /** Executable to run (e.g. `"node"`, `"npx"`, `"python"`). */
  command: z.string().min(1),

  /** Arguments passed to the command. */
  args: z.array(z.string()).default([]),

  /**
   * Additional environment variables for the spawned process.
   * Values may contain `${VAR}` placeholders resolved from `process.env`.
   */
  env: z.record(z.string(), z.string()).optional(),

  /** Working directory for the spawned process. */
  cwd: z.string().optional(),

  /**
   * Tool filter.  `["*"]` enables all tools (recommended); an empty array
   * disables all tools; a specific list enables only those named tools.
   */
  tools: z.array(z.string()).default(["*"]),

  /** Per-call timeout in milliseconds. */
  timeout: z.number().optional(),
});

/** Inferred type for a local MCP server config. */
export type McpLocalServerConfig = z.infer<typeof McpLocalServerConfigSchema>;

// ---------------------------------------------------------------------------
// Schemas — Remote (HTTP / SSE) server
// ---------------------------------------------------------------------------

/**
 * Zod schema for a **remote HTTP/SSE** MCP server.
 *
 * The Copilot SDK connects to the specified URL over HTTP.  Ideal for
 * shared services and cloud-hosted tools.
 */
export const McpHttpServerConfigSchema = z.object({
  /** Discriminant — `"http"` or `"sse"` (both accepted by the SDK). */
  type: z.enum(["http", "sse"]),

  /** Human-readable display name (co-assistant metadata, not sent to SDK). */
  name: z.string().min(1),

  /** Whether this server is active. Disabled servers are excluded from sessions. */
  enabled: z.boolean().default(true),

  /** Full URL of the MCP server endpoint (e.g. `"https://api.example.com/mcp"`). */
  url: z.string().url(),

  /**
   * HTTP headers sent with every request (e.g. `Authorization`).
   * Values may contain `${VAR}` placeholders resolved from `process.env`.
   */
  headers: z.record(z.string(), z.string()).optional(),

  /**
   * Tool filter.  `["*"]` enables all tools (recommended); an empty array
   * disables all tools; a specific list enables only those named tools.
   */
  tools: z.array(z.string()).default(["*"]),

  /** Per-call timeout in milliseconds. */
  timeout: z.number().optional(),
});

/** Inferred type for an HTTP MCP server config. */
export type McpHttpServerConfig = z.infer<typeof McpHttpServerConfigSchema>;

// ---------------------------------------------------------------------------
// Discriminated union & top-level config
// ---------------------------------------------------------------------------

/**
 * Union of all supported MCP server types.
 *
 * Discriminated on the `type` field — `"local"` / `"stdio"` for subprocess
 * servers and `"http"` / `"sse"` for remote servers.
 */
export const McpServerConfigSchema = z.discriminatedUnion("type", [
  McpLocalServerConfigSchema,
  McpHttpServerConfigSchema,
]);

/** Inferred type for a single MCP server definition. */
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Top-level MCP configuration block stored under `config.json → mcp`.
 */
export const McpConfigSchema = z.object({
  /**
   * Map of server ID → server definition.
   * Server IDs are arbitrary kebab-case strings (e.g. `"filesystem"`, `"github"`).
   */
  servers: z.record(z.string(), McpServerConfigSchema).default({}),
});

/** Inferred type for the full MCP config block. */
export type McpConfig = z.infer<typeof McpConfigSchema>;

// ---------------------------------------------------------------------------
// SDK conversion helper
// ---------------------------------------------------------------------------

/**
 * Resolve `${VAR}` placeholders in a string against `process.env`.
 *
 * Unknown variables are left as-is rather than replaced with `undefined`,
 * making misconfiguration visible rather than silently broken.
 */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    return process.env[varName] ?? match;
  });
}

/**
 * Resolve all values in a string record.
 */
function resolveRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, resolveEnvVars(v)]),
  );
}

/**
 * SDK-facing shape for a local MCP server entry (after stripping metadata).
 *
 * Matches the `mcpServers` object shape expected by the Copilot SDK's
 * `createSession()` option.
 */
export interface SdkMcpLocalEntry {
  type: "local" | "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  tools?: string[];
  timeout?: number;
}

/**
 * SDK-facing shape for an HTTP MCP server entry (after stripping metadata).
 */
export interface SdkMcpHttpEntry {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
  timeout?: number;
}

/** SDK-facing MCP server entry (union). */
export type SdkMcpEntry = SdkMcpLocalEntry | SdkMcpHttpEntry;

/** SDK-facing `mcpServers` map passed directly to `createSession()`. */
export type SdkMcpServers = Record<string, SdkMcpEntry>;

/**
 * Convert a stored {@link McpConfig} into the `mcpServers` object accepted by
 * the Copilot SDK's `createSession()` option.
 *
 * Disabled servers (where `enabled === false`) are excluded.
 * The `name` and `enabled` metadata fields are stripped.
 * `${VAR}` placeholders in `headers` and `env` values are resolved from
 * `process.env` so secrets can be stored in `.env` rather than `config.json`.
 *
 * Returns `undefined` when no servers are enabled, signalling to the caller
 * that the `mcpServers` option should be omitted from `createSession()`.
 *
 * @param config - The `mcp` block from `config.json` (may be `undefined`).
 * @returns SDK-ready server map, or `undefined` if nothing is enabled.
 */
export function toSdkMcpServers(config: McpConfig | undefined): SdkMcpServers | undefined {
  if (!config || Object.keys(config.servers).length === 0) return undefined;

  const result: SdkMcpServers = {};

  for (const [id, server] of Object.entries(config.servers)) {
    if (!server.enabled) continue;

    // Omit `tools` only when it's the wildcard sentinel ["*"] — let the SDK expose all tools.
    // An explicit empty array [] is passed through as-is (caller's intent).
    const toolFilter =
      server.tools.length === 1 && server.tools[0] === "*"
        ? undefined
        : server.tools;

    if (server.type === "local" || server.type === "stdio") {
      const entry: SdkMcpLocalEntry = {
        type: server.type,
        command: server.command,
        args: server.args,
      };
      if (toolFilter) entry.tools = toolFilter;
      if (server.env) entry.env = resolveRecord(server.env);
      if (server.cwd) entry.cwd = server.cwd;
      if (server.timeout !== undefined) entry.timeout = server.timeout;
      result[id] = entry;
    } else {
      const entry: SdkMcpHttpEntry = {
        type: server.type,
        url: server.url,
      };
      if (toolFilter) entry.tools = toolFilter;
      if (server.headers) entry.headers = resolveRecord(server.headers);
      if (server.timeout !== undefined) entry.timeout = server.timeout;
      result[id] = entry;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

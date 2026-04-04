# Architecture

> Technical reference for developers working on the Co-Assistant codebase.

---

## 1. System Overview

Co-Assistant is a single-user AI-powered Telegram bot built on the **GitHub Copilot SDK**. It acts as a personal assistant that can be extended with plugins (Gmail, Google Calendar, custom integrations) whose capabilities are exposed as tools the AI model can invoke during a conversation.

Key design decisions:

- **Single-user by design** — an auth guard restricts all interaction to one Telegram user ID, simplifying session and security models.
- **Plugin-first extensibility** — every external capability (email, calendar, etc.) is a plugin. The core never imports plugin code directly; plugins are discovered on disk, dynamically imported, and sandboxed.
- **Singleton subsystems** — the Copilot client, session manager, sandbox, and credential manager are singletons wired together at startup. This keeps dependency graphs simple for a single-process Node.js application.
- **Copilot SDK as the AI backbone** — rather than calling LLM APIs directly, the system delegates to the Copilot SDK which handles authentication, model routing, and tool-calling protocol.

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          CLI (Commander.js)                          │
│   co-assistant start | setup | plugin | model | status               │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ creates App instance
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Core Orchestrator (App)                       │
│  Boots subsystems in order, registers signal handlers, tears down    │
└──┬───────────┬──────────────┬──────────────┬────────────────────┬───┘
   │           │              │              │                    │
   ▼           ▼              ▼              ▼                    ▼
┌────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐ ┌──────────┐
│Config  │ │  Database   │ │  Model     │ │Plugin System │ │Telegram  │
│(.env + │ │  (SQLite +  │ │  Registry  │ │              │ │Bot       │
│config  │ │  WAL +      │ │(preferences│ │  Registry    │ │(Telegraf)│
│.json)  │ │  migrations)│ │ backed)    │ │     │        │ │          │
└────────┘ └──────┬─────┘ └─────┬──────┘ │  Manager     │ └────┬─────┘
                  │             │         │     │        │      │
                  ▼             │         │  Sandbox     │      │
           ┌───────────┐       │         │     │        │      │
           │Repositories│       │         │ Credentials  │      │
           │ •Conver-   │       │         └──────┬───────┘      │
           │  sation    │◄──────┘                │              │
           │ •Prefer-   │                        ▼              │
           │  ences     │              ┌───────────────────┐    │
           │ •Plugin    │              │  Plugin Instances  │    │
           │  State     │              │  (Gmail, Calendar, │    │
           │ •Plugin    │              │   Custom, …)       │    │
           │  Health    │              └─────────┬─────────┘    │
           └───────────┘                        │              │
                                                ▼              │
                                     ┌────────────────────┐    │
                                     │  Tool Definitions   │    │
                                     │  (prefixed, sand-   │    │
                                     │   boxed handlers)   │    │
                                     └─────────┬──────────┘    │
                                               │               │
                                               ▼               │
                                     ┌────────────────────┐    │
                                     │  Copilot SDK        │    │
                                     │  Client + Session   │◄───┘
                                     │  (model, tools,     │────► AI Model
                                     │   streaming)        │
                                     └────────────────────┘
```

### Middleware pipeline (Telegram → AI):

```
Telegram Update
      │
      ▼
  Logging Middleware ─── logs updateType, userId, preview, duration
      │
      ▼
  Auth Guard ────────── compares ctx.from.id against allowedUserId
      │                 unauthorized → silently dropped
      ▼
  Error Handler ─────── try/catch wrapper; replies with error message
      │
      ▼
  Command Router ────── /command → onCommand handler (optional)
      │
      ▼
  Message Handler ───── text → AI session → reply
```

---

## 3. Component Descriptions

### 3.1 Core (`src/core/`)

| File | Purpose |
|------|---------|
| **`app.ts`** | Top-level orchestrator. The `App` class owns the boot and shutdown sequences. Every subsystem is started in dependency order and torn down in reverse. Each shutdown step is wrapped in try/catch so a failing subsystem never blocks cleanup of the others. |
| **`config.ts`** | Two-source configuration: `.env` (secrets, validated via Zod `EnvConfigSchema`) and `config.json` (app settings, validated via `AppConfigSchema`). A singleton `getConfig()` caches the merged result. A `resetConfig()` busts the cache when `config.json` is written at runtime (e.g., plugin enable/disable). |
| **`logger.ts`** | Structured logging via pino. A single root logger is created at module load; subsystems obtain child loggers via `createChildLogger(name)` so every log line carries a `component` field. In development, pino-pretty is used if installed; in production, ndjson goes to stdout. `setLogLevel()` changes the level at runtime (child loggers inherit it). |
| **`errors.ts`** | Error hierarchy rooted at `CoAssistantError`. Each subclass (`ConfigError`, `PluginError`, `AIError`, `BotError`) carries a machine-readable `code` and optional structured `context`. Static factory methods (`AIError.sendFailed(reason)`) ensure consistent error construction. `formatError()` renders any thrown value into a human-readable string with code and context. |

### 3.2 AI Engine (`src/ai/`)

| File | Purpose |
|------|---------|
| **`client.ts`** | Wraps the `@github/copilot-sdk` `CopilotClient` with lifecycle management (`start`, `stop`, `restart`). The singleton `copilotClient` is the only place the SDK client is instantiated. Throws `AIError.clientStartFailed` on failure. |
| **`session.ts`** | Manages a single Copilot session. `createSession(model, tools)` converts `ToolDefinition[]` into SDK `Tool[]` via `defineTool`, creates the session with `onPermissionRequest: approveAll`. Supports both blocking (`sendAndWait`) and streaming (`send` + event listeners for `assistant.message_delta`, `assistant.message`, `session.idle`). `switchModel()` and `updateTools()` close and recreate the session because the SDK binds tools at creation time. |
| **`models.ts`** | Registry of known AI models (GPT-4.1, GPT-4o, GPT-5, Claude Sonnet 4, Claude Opus 4, o3, o4-mini). Model selection is resolved from persisted preference → `DEFAULT_MODEL` env var. Supports runtime registration of custom models (BYOK). Unknown model IDs are allowed (the SDK may support them) but logged as warnings. |
| **`tools.ts`** | `ToolAggregator` collects tools from all active plugins, prefixes names (`<pluginId>_<toolName>`), wraps handlers through `PluginSandbox.wrapToolHandler()` for error isolation, and converts to SDK format. Duplicate names are detected and deduplicated (first wins). |

### 3.3 Plugin System (`src/plugins/`)

| File | Purpose |
|------|---------|
| **`types.ts`** | Central type definitions. `PluginManifestSchema` (Zod) validates `plugin.json` files. `CoAssistantPlugin` interface defines the lifecycle contract: `initialize(ctx)` → `getTools()` → `destroy()` → `healthCheck()`. `ToolDefinition` mirrors the shape expected by `defineTool`. `PluginFactory` is the default export shape (zero-arg function returning a plugin instance). |
| **`registry.ts`** | `PluginRegistry` scans `<cwd>/plugins/` for subdirectories containing a `plugin.json`, validates each manifest against `PluginManifestSchema`, and tracks enabled/disabled state. Enable/disable state is persisted to `config.json` and busts the config cache via `resetConfig()`. |
| **`manager.ts`** | `PluginManager` orchestrates the full plugin lifecycle. For each enabled plugin: resolve manifest → validate credentials → dynamic import (prefer `.js`, fallback `.ts`) → invoke factory → build `PluginContext` (credentials + namespaced state store + child logger) → `initialize()` inside sandbox → store active instance. `getAllTools()` collects and prefixes tools from all active plugins. |
| **`sandbox.ts`** | `PluginSandbox` is the error isolation boundary. `safeExecute()` wraps every plugin method in try/catch; errors are logged, never propagated. Consecutive failures are counted per plugin. After `maxFailures` (default 5, configurable via `config.json`) consecutive errors, the plugin is auto-disabled — subsequent calls are short-circuited. A successful call resets the counter. `wrapToolHandler()` returns error strings to the AI model instead of throwing. |
| **`credentials.ts`** | `CredentialManager` reads credentials from `config.json → plugins.<id>.credentials`, validates that every key declared in the manifest is present and non-empty, and throws `PluginError.credentialsMissing` if not. Credential values are never logged. |

### 3.4 Telegram Bot (`src/bot/`)

| File | Purpose |
|------|---------|
| **`bot.ts`** | `TelegramBot` wraps Telegraf. `initialize()` registers middleware in order: logging → auth → error-catching → optional command handler → text message handler → catch-all for non-text. `launch()` starts long-polling and registers SIGINT/SIGTERM handlers. Does not depend on the global config singleton (token and user ID are injected). |
| **`handlers/message.ts`** | `createMessageHandler()` factory receives `SessionManager` + `ConversationRepository`. Flow: send typing indicator → persist user message → forward to `sessionManager.sendMessage()` → persist assistant response → reply (splitting at 4096 chars on paragraph/newline boundaries). |
| **`handlers/command.ts`** | Command routing for `/start`, `/model`, `/plugin`, etc. |
| **`handlers/callback.ts`** | Callback query handler for inline keyboard interactions. |
| **`middleware/auth.ts`** | Compares `ctx.from.id` against a single allowed user ID. Unauthorized updates are silently dropped (never calling `next()`) and logged at `warn` level. |
| **`middleware/logging.ts`** | Logs every update with `updateType`, `updateId`, `userId`, a 50-char text preview, and wall-clock duration of downstream processing. |

### 3.5 Storage (`src/storage/`)

| File | Purpose |
|------|---------|
| **`database.ts`** | Singleton `better-sqlite3` connection with WAL mode. On first call to `getDatabase()`: creates the data directory, opens the file, enables WAL, and runs pending migrations. Each migration runs in its own transaction; a `_migrations` table tracks which have been applied. `closeDatabase()` closes the connection and clears the singleton. |
| **`migrations/001-initial.ts`** | Creates the four application tables: `conversations`, `plugin_state`, `preferences`, `plugin_health` with indexes. |
| **`repositories/conversation.ts`** | `ConversationRepository` — insert messages, retrieve history (newest-first), get recent context window (oldest-first), clear, count. |
| **`repositories/preferences.ts`** | `PreferencesRepository` — generic key-value store for app-wide settings (e.g., selected AI model). Uses upsert via `ON CONFLICT`. |
| **`repositories/plugin-state.ts`** | `PluginStateRepository` — per-plugin namespaced key-value store. Composite PK `(plugin_id, key)`. |
| **`repositories/plugin-health.ts`** | `PluginHealthRepository` — append-only health log. Supports querying recent entries and counting errors within a time window. |

### 3.6 CLI (`src/cli/`)

| Command | Purpose |
|---------|---------|
| **`co-assistant start`** | Boots the full application via `new App().start()`. Accepts `-v / --verbose` flag. |
| **`co-assistant setup`** | Interactive first-run wizard for `.env` and `config.json`. |
| **`co-assistant plugin`** | List, enable, disable, and inspect plugins. |
| **`co-assistant model`** | List available models, show current, switch models. |
| **`co-assistant status`** | Display runtime status of all subsystems. |

---

## 4. Data Flow

Step-by-step: what happens when a user sends a Telegram message.

```
 User types "Check my email"
      │
      ▼
 ① Telegram API delivers update to Telegraf (long-polling)
      │
      ▼
 ② Logging middleware records: updateId, userId, "Check my em…"
      │
      ▼
 ③ Auth middleware checks ctx.from.id === allowedUserId
      │  (mismatch → drop silently, log warning)
      │
      ▼
 ④ Error-handling middleware wraps downstream in try/catch
      │
      ▼
 ⑤ Text message handler fires:
      │
      ├─ a. ctx.sendChatAction("typing")
      │
      ├─ b. conversationRepo.addMessage("user", text)
      │      → INSERT INTO conversations
      │
      ├─ c. sessionManager.sendMessage(text)
      │      │
      │      ▼
      │  ⑥ Copilot SDK session.sendAndWait({ prompt })
      │      │
      │      ├── SDK may invoke registered tools (e.g. gmail__search_email)
      │      │      │
      │      │      ▼
      │      │   Sandbox-wrapped handler executes plugin code
      │      │      │
      │      │      ├── success → result returned to model
      │      │      └── failure → error string returned to model,
      │      │                    failure counter incremented
      │      │
      │      └── Model generates final response
      │
      ├─ d. conversationRepo.addMessage("assistant", response, model)
      │      → INSERT INTO conversations
      │
      └─ e. splitMessage(response, 4096) → ctx.reply(chunk) for each
```

---

## 5. Plugin Isolation

The sandbox is the critical boundary between the host process and plugin code. Every plugin method invocation and every tool call goes through it.

### Error Boundary

```
┌────────────────────────────────────────────┐
│            PluginSandbox                   │
│                                            │
│  safeExecute(pluginId, method, fn)         │
│  ┌──────────────────────────────────────┐  │
│  │ if (isDisabled(pluginId)) → skip     │  │
│  │                                      │  │
│  │ try {                                │  │
│  │   result = await fn()                │  │
│  │   recordSuccess(pluginId)  ← resets  │  │
│  │   return result              counter │  │
│  │ } catch (err) {                      │  │
│  │   recordFailure(pluginId, err)       │  │
│  │   if (count >= maxFailures)          │  │
│  │     → auto-disable plugin            │  │
│  │   return undefined                   │  │
│  │ }                                    │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

### Key behaviours

| Behaviour | Detail |
|-----------|--------|
| **Error containment** | Errors never propagate out of `safeExecute()`. The method always returns either the result or `undefined`. |
| **Consecutive failure tracking** | Each failure increments a per-plugin counter. A success resets it to zero. This means intermittent errors don't accumulate. |
| **Auto-disable threshold** | Default `maxFailures = 5` (configurable in `config.json → pluginHealth.maxFailures`). Once reached, the plugin is added to the `disabledPlugins` set and all future calls are short-circuited. |
| **Tool handler wrapping** | `wrapToolHandler()` returns a function with the same signature. On failure, it returns a descriptive error *string* (not an exception) so the AI model receives actionable feedback like `"Error: Tool send_email failed: plugin has been disabled due to repeated failures"`. |
| **Health logging** | Each failure is also written to the `plugin_health` table (best-effort; storage errors are swallowed). |
| **Manual reset** | `resetPlugin(pluginId)` clears the counter and removes the plugin from the disabled set, allowing a re-enabled plugin to start fresh. |

---

## 6. Storage Schema

Database: SQLite with WAL journal mode. File: `./data/co-assistant.db`.

### `_migrations`

Tracks which schema migrations have been applied.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT PRIMARY KEY` | Migration identifier (e.g., `"001-initial"`). |
| `applied_at` | `DATETIME` | Timestamp when the migration was applied. Default: `CURRENT_TIMESTAMP`. |

### `conversations`

Stores the full conversation history between user and assistant.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | Row identifier. |
| `role` | `TEXT` | `NOT NULL CHECK(IN ('user','assistant','system'))` | Message author role. |
| `content` | `TEXT` | `NOT NULL` | Message text content. |
| `model` | `TEXT` | nullable | AI model that generated the response (null for user messages). |
| `created_at` | `DATETIME` | `DEFAULT CURRENT_TIMESTAMP` | When the message was stored. |

**Index:** `idx_conversations_created_at` on `created_at` — speeds up chronological queries used for context windows.

### `preferences`

Application-wide key-value settings (e.g., currently selected AI model).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `key` | `TEXT` | `PRIMARY KEY` | Setting name (e.g., `"current_model"`). |
| `value` | `TEXT` | `NOT NULL` | Setting value. |
| `updated_at` | `DATETIME` | `DEFAULT CURRENT_TIMESTAMP` | Last modification time. |

### `plugin_state`

Per-plugin namespaced key-value store for persistent plugin data.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `plugin_id` | `TEXT` | `NOT NULL`, part of composite PK | Owning plugin identifier. |
| `key` | `TEXT` | `NOT NULL`, part of composite PK | State key. |
| `value` | `TEXT` | nullable | State value. |
| `updated_at` | `DATETIME` | `DEFAULT CURRENT_TIMESTAMP` | Last modification time. |

**Primary key:** `(plugin_id, key)` — ensures each plugin's keys are unique.

### `plugin_health`

Append-only log of plugin health events, used for failure analysis.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `INTEGER` | `PRIMARY KEY AUTOINCREMENT` | Row identifier. |
| `plugin_id` | `TEXT` | `NOT NULL` | Plugin that was checked. |
| `status` | `TEXT` | `NOT NULL CHECK(IN ('ok','error','disabled'))` | Health outcome. |
| `error_message` | `TEXT` | nullable | Error details when `status = 'error'`. |
| `checked_at` | `DATETIME` | `DEFAULT CURRENT_TIMESTAMP` | When the check occurred. |

**Index:** `idx_plugin_health_plugin_id` on `plugin_id` — supports per-plugin health queries.

---

## 7. Configuration

Co-Assistant uses a two-source configuration strategy:

### `.env` — Secrets and environment-specific values

Loaded via `dotenv` and validated against `EnvConfigSchema` (Zod). Missing `.env` is non-fatal (values may come from the host environment).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot API token from BotFather. |
| `TELEGRAM_USER_ID` | ✅ | — | Authorized Telegram user ID. |
| `GITHUB_TOKEN` | ❌ | — | GitHub token for Copilot SDK auth. |
| `LOG_LEVEL` | ❌ | `"info"` | One of: `debug`, `info`, `warn`, `error`. |
| `DEFAULT_MODEL` | ❌ | `"gpt-4.1"` | Fallback model when no preference is persisted. |

### `config.json` — Application settings and plugin configuration

Validated against `AppConfigSchema` (Zod). If the file doesn't exist, a default is generated from schema defaults on first run.

```jsonc
{
  "plugins": {
    "<plugin-id>": {
      "enabled": true,              // whether the plugin is loaded at startup
      "credentials": {              // plugin-specific secrets
        "API_KEY": "…"
      }
    }
  },
  "bot": {
    "maxMessageLength": 4096,       // Telegram message split threshold
    "typingIndicator": true         // send typing action before AI response
  },
  "ai": {
    "maxRetries": 3,                // retry count for failed AI calls
    "sessionTimeout": 3600000       // session TTL in ms (1 hour)
  },
  "pluginHealth": {
    "maxFailures": 5,               // consecutive failures before auto-disable
    "checkInterval": 60000          // health check interval in ms
  }
}
```

### Why two sources?

- **`.env`** holds secrets that should never be committed to version control and vary between environments (local dev, staging, production).
- **`config.json`** holds structural configuration (plugin enable/disable, tuning parameters) that is safe to commit and is modified at runtime by the plugin registry when plugins are enabled/disabled.

The singleton `getConfig()` loads both sources once and caches the result. The cache is busted via `resetConfig()` when `config.json` is written (e.g., by `PluginRegistry.persistPluginState()`).

---

## 8. Startup Sequence

When `co-assistant start` runs, the following happens in order:

```
 1.  CLI parses args → creates App instance → calls app.start()
 2.  Load configuration (getConfig → dotenv + config.json)
 3.  Set log level to "debug" if --verbose flag is present
 4.  Initialize database (getDatabase → create dirs → open SQLite → WAL → migrations)
 5.  Create repositories (ConversationRepo, PreferencesRepo, PluginStateRepo)
 6.  Create model registry (backed by PreferencesRepo for persisted selection)
 7.  Discover plugins (PluginRegistry scans plugins/ dir, validates manifests)
 8.  Initialize plugin manager:
     a. For each enabled plugin:
        i.   Resolve manifest from registry
        ii.  Validate credentials via CredentialManager
        iii. Dynamic import of plugin module (prefer .js, fallback .ts)
        iv.  Invoke factory function to get plugin instance
        v.   Build PluginContext (credentials + state store + logger)
        vi.  Call plugin.initialize(context) inside sandbox
        vii. Store active plugin instance, set status = "active"
     b. Log summary: discovered / loaded / failed counts
 9.  Start Copilot client (new CopilotClient() → client.start())
10.  Resolve current model (preferences → env default)
11.  Collect all tools from active plugins (prefixed, sandbox-wrapped)
12.  Create AI session (client.createSession with model + tools + approveAll)
13.  Create Telegram bot:
     a. new TelegramBot(token)
     b. Register middleware stack: logging → auth → error → commands → messages
     c. bot.launch() → Telegraf starts long-polling
14.  Log startup banner: model, plugin count, version
15.  Register process signal handlers: SIGINT, SIGTERM → app.shutdown()
```

---

## 9. Shutdown Sequence

Graceful shutdown runs in reverse dependency order. Each step is wrapped in its own try/catch — a failure in one step never prevents subsequent steps from executing.

```
 1.  Guard against re-entrant shutdown (isShuttingDown flag)
 2.  Stop Telegram bot (Telegraf.stop → cancels long-polling)
 3.  Close AI session (session.disconnect)
 4.  Stop Copilot client (client.stop)
 5.  Shutdown plugins:
     a. For each active plugin:
        i.  Call plugin.destroy() inside sandbox
        ii. Remove from active map, set status = "unloaded"
 6.  Close database (instance.close → null singleton)
 7.  Log "Goodbye!" → process.exit(0)
```

The ordering matters: the bot is stopped first so no new messages arrive while the AI session and plugins are being torn down. The database closes last because plugin destroy hooks may need to persist final state.

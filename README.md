# Co-Assistant

[![CI](https://github.com/hmawla/co-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/hmawla/co-assistant/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@hmawla/co-assistant)](https://www.npmjs.com/package/@hmawla/co-assistant)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[Homepage](https://hmawla.github.io/co-assistant)** · **[npm](https://www.npmjs.com/package/@hmawla/co-assistant)** · **[Plugin Guide](docs/plugin-development.md)** · **[CLI Reference](docs/cli-reference.md)**

AI-powered Telegram personal assistant built on the GitHub Copilot SDK.

Chat with state-of-the-art AI models (GPT-5, Claude Sonnet 4, o3, and more) directly from Telegram. Extend it with plugins for Gmail, Google Calendar, or build your own.

---

## Quick Start

### 1. Prerequisites

| Requirement | How to get it |
|------------|---------------|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) |
| **Telegram Bot Token** | Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token |
| **Telegram User ID** | Message [@userinfobot](https://t.me/userinfobot) → copy the numeric ID |
| **GitHub Token** | [github.com/settings/tokens](https://github.com/settings/tokens) — create a token with Copilot access |

### 2. Install

Install globally from npm:

```bash
npm install -g @hmawla/co-assistant
```

### 3. Create a project directory

Co-Assistant needs a working directory to store your configuration, plugins, and data:

```bash
mkdir my-assistant && cd my-assistant
```

### 4. Set up

Run the interactive setup wizard — it walks you through every credential and preference:

```bash
co-assistant setup
```

The wizard creates your `.env` file and `config.json`. Re-run it anytime to update settings.

### 5. Start

```bash
co-assistant start
```

Open Telegram, find your bot, and send a message. That's it.

**Verbose mode** (shows messages and debug logs in the terminal):

```bash
co-assistant start -v
```

---

## Installation Methods

### Global install from npm (recommended)

Works on **Linux**, **macOS**, and **Windows**:

```bash
npm install -g @hmawla/co-assistant
```

After install, the `co-assistant` command is available everywhere. Create a directory for your instance and run `co-assistant setup` inside it.

> **Windows note:** If `co-assistant` is not found after install, ensure your npm global bin
> directory is in your `PATH`. Run `npm config get prefix` and add the resulting path + `/bin`
> (or `\bin` on Windows) to your system PATH.

### Run without installing (npx)

Try it out without a global install:

```bash
npx @hmawla/co-assistant setup
npx @hmawla/co-assistant start
```

### Install from source

For development or customisation:

```bash
git clone https://github.com/hmawla/co-assistant.git
cd co-assistant
npm install
```

Run commands via tsx during development:

```bash
npx tsx src/cli/index.ts setup
npx tsx src/cli/index.ts start -v
```

Or build first, then run the compiled output:

```bash
npm run build
node dist/cli/index.js start
```

---

## Personalise

Two markdown files control how the AI behaves and who it knows you are:

| File | Purpose | Included in package? |
|------|---------|---------------------|
| `personality.md` | Defines the assistant's tone, style, and behaviour | ✅ Yes — edit to customise |
| `user.md` | Your personal profile (name, role, timezone, preferences) | Template only (`user.md.example`) |

**Set up your user profile:**

```bash
cp user.md.example user.md
# Edit user.md with your details
```

Both files are read fresh on each message — edit them anytime without restarting. If the files don't exist in your working directory, the assistant works fine without them.

---

## Production Deployment

For running Co-Assistant permanently on a server (VPS, Raspberry Pi, etc.).

### Linux — systemd (recommended)

```bash
# Install globally on the server
npm install -g @hmawla/co-assistant

# Create a dedicated directory
sudo mkdir -p /opt/co-assistant
sudo chown $USER:$USER /opt/co-assistant
cd /opt/co-assistant

# Set up credentials
co-assistant setup
```

Create a systemd service:

```bash
sudo nano /etc/systemd/system/co-assistant.service
```

```ini
[Unit]
Description=Co-Assistant Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/opt/co-assistant
ExecStart=/usr/bin/co-assistant start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

> **Tip:** Run `which co-assistant` to find the exact path for `ExecStart` if it differs.

```bash
sudo systemctl daemon-reload
sudo systemctl enable co-assistant
sudo systemctl start co-assistant
```

**Useful commands:**

```bash
sudo systemctl status co-assistant    # Check if running
sudo journalctl -u co-assistant -f    # Live logs
sudo systemctl restart co-assistant   # Restart after config changes
```

### macOS — launchd

```bash
npm install -g @hmawla/co-assistant
mkdir -p ~/co-assistant && cd ~/co-assistant
co-assistant setup
```

Create a launch agent:

```bash
nano ~/Library/LaunchAgents/com.co-assistant.plist
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.co-assistant</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/co-assistant</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/your-username/co-assistant</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/your-username/co-assistant/co-assistant.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/your-username/co-assistant/co-assistant.log</string>
</dict>
</plist>
```

> **Tip:** Run `which co-assistant` and replace `/usr/local/bin/co-assistant` with the actual path.

```bash
launchctl load ~/Library/LaunchAgents/com.co-assistant.plist
```

### Windows — Task Scheduler or PM2

**Option A: PM2 (cross-platform, recommended for Windows)**

```powershell
npm install -g @hmawla/co-assistant pm2
mkdir C:\co-assistant
cd C:\co-assistant
co-assistant setup
pm2 start co-assistant -- start
pm2 save
pm2-startup install    # auto-start on boot
```

**Option B: Task Scheduler**

1. Open Task Scheduler → Create Basic Task
2. Set trigger to "When the computer starts"
3. Action: Start a program
   - Program: `co-assistant` (or full path from `where co-assistant`)
   - Arguments: `start`
   - Start in: `C:\co-assistant`
4. Check "Run whether user is logged on or not"

### Any OS — PM2

PM2 works the same way on Linux, macOS, and Windows:

```bash
npm install -g @hmawla/co-assistant pm2
mkdir my-assistant && cd my-assistant
co-assistant setup
pm2 start co-assistant -- start
pm2 save
pm2 startup    # generates command to auto-start on boot
```

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
RUN npm install -g @hmawla/co-assistant
COPY .env config.json personality.md ./
COPY plugins/ plugins/
COPY heartbeats/ heartbeats/
# Optional — only if you created a user.md:
# COPY user.md ./
CMD ["co-assistant", "start"]
```

```bash
docker build -t co-assistant .
docker run -d --restart=always --name co-assistant co-assistant
```

---

## Environment Variables

All configured via `.env` (the setup wizard handles this):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `TELEGRAM_USER_ID` | ✅ | — | Your Telegram numeric user ID |
| `GITHUB_TOKEN` | ✅ | — | GitHub token with Copilot access |
| `DEFAULT_MODEL` | — | `gpt-4.1` | AI model to use on startup |
| `LOG_LEVEL` | — | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `HEARTBEAT_INTERVAL_MINUTES` | — | `0` | Scheduled heartbeat interval (0 = disabled) |
| `AI_SESSION_POOL_SIZE` | — | `3` | Number of parallel AI sessions |

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `co-assistant setup` | Interactive setup wizard |
| `co-assistant start` | Start the bot |
| `co-assistant start -v` | Start with verbose logging |
| `co-assistant model` | Show current AI model |
| `co-assistant model <name>` | Switch AI model |
| `co-assistant plugin list` | List discovered plugins in local `plugins/` |
| `co-assistant plugin available` | List bundled first-party plugins |
| `co-assistant plugin install <id>` | Install a bundled plugin into `plugins/` |
| `co-assistant plugin install --all` | Install all bundled plugins |
| `co-assistant plugin enable <name>` | Enable a plugin |
| `co-assistant plugin disable <name>` | Disable a plugin |
| `co-assistant plugin configure <name>` | Set up plugin credentials |
| `co-assistant heartbeat list` | List heartbeat events |
| `co-assistant heartbeat add` | Create a new heartbeat event |
| `co-assistant heartbeat remove <name>` | Delete a heartbeat event |
| `co-assistant heartbeat run [name]` | Test heartbeat(s) on demand |
| `co-assistant status` | Show bot and system status |

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | List available commands |
| `/model [name]` | View or change the AI model |
| `/plugins` | List plugins and their status |
| `/enable <plugin>` | Enable a plugin |
| `/disable <plugin>` | Disable a plugin |
| `/clear` | Clear conversation and reset AI context |
| `/update` | Check for updates — tap "Update Now" to self-update |
| `/status` | Show bot status |
| `/heartbeat [name]` | Run heartbeat event(s) on demand |
| `/hb [name]` | Shorthand for `/heartbeat` |
| `/mcp` | List configured MCP servers and their status |

Anything else you type is a conversation with the AI.

---

## Available Models

Models are grouped by rate consumption (requests per prompt):

| Tier | Models | Rate |
|------|--------|------|
| **Premium** | `gpt-5`, `o3`, `claude-opus-4` | 3× |
| **Standard** | `gpt-4.1`, `gpt-4o`, `o4-mini`, `claude-sonnet-4` | 1× |
| **Low** | `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`, `o3-mini`, `claude-haiku-4.5` | 0.33× |
| **Free** | `gpt-4.1-nano` | 0× |

Switch anytime: `co-assistant model claude-sonnet-4`

---

## Personality & User Profile

### `personality.md` — How the AI behaves

Defines the assistant's identity, tone, formatting rules, and boundaries. Shipped with a sensible default. Edit it to change the assistant's style — changes apply on the next message.

### `user.md` — Who you are

Your personal details (name, title, timezone, role, preferences) so the AI can address you correctly and understand your context. Copy `user.md.example` to get started.

Both files are injected as system-level context on every message:
1. **Personality** — how the assistant should behave
2. **User profile** — who it's talking to
3. **Your message** — the actual prompt

---

## Plugins

### Included Plugins

| Plugin | Tools provided |
|--------|---------------|
| **Gmail** | Search threads, get thread, search emails, read email, send email |
| **Google Calendar** | List events, create event, update event, delete event |

### Install Plugins

Co-Assistant ships with first-party plugins (Gmail, Google Calendar). If you installed via npm, they aren't in your working directory yet — install them with:

```bash
# See what's available
co-assistant plugin available

# Install a specific plugin
co-assistant plugin install gmail

# Install all bundled plugins at once
co-assistant plugin install --all

# Overwrite an existing plugin (e.g. after an update)
co-assistant plugin install gmail --force
```

### Enable a Plugin

```bash
co-assistant plugin enable gmail
co-assistant plugin configure gmail
```

The configure command walks you through setting up OAuth credentials. For Google plugins, it includes an automated local OAuth flow to obtain refresh tokens.

### Create Your Own Plugin

Create a directory under `plugins/` in your working directory:

```
plugins/my-plugin/
├── plugin.json    # Manifest (id, name, version, credentials)
└── index.ts       # Entry point exporting createPlugin()
```

**`plugin.json`:**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does",
  "requiredCredentials": [
    { "key": "API_KEY", "description": "API key for the service" }
  ]
}
```

**`index.ts`:**

```typescript
import type { CoAssistantPlugin, PluginContext } from "../../src/plugins/types.js";

export default function createPlugin(): CoAssistantPlugin {
  return {
    id: "my-plugin",
    name: "My Plugin",
    version: "1.0.0",
    description: "What it does",
    requiredCredentials: [{ key: "API_KEY", description: "API key" }],

    async initialize(context: PluginContext) {
      // Set up connections, validate credentials
    },

    getTools() {
      return [{
        name: "do_something",
        description: "Does something useful",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "The input" },
          },
          required: ["input"],
        },
        handler: async (args: Record<string, unknown>) => {
          return `Result for: ${args.input}`;
        },
      }];
    },

    async destroy() {},
    async healthCheck() { return true; },
  };
}
```

Tool names are automatically prefixed with the plugin ID (e.g., `my-plugin_do_something`) to prevent collisions. Plugins run in a sandbox — failures are isolated and auto-disabled after 5 consecutive errors.

> 📖 See [docs/plugin-development.md](docs/plugin-development.md) for the full guide.

---

## MCP Servers

Co-Assistant supports [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) natively via the GitHub Copilot SDK. MCP servers extend the AI with external tools over **stdio** (local process) or **HTTP/SSE** (remote service).

```bash
# Add a server (interactive wizard)
co-assistant mcp add

# List all configured servers
co-assistant mcp list

# Enable / disable / remove
co-assistant mcp enable <id>
co-assistant mcp disable <id>
co-assistant mcp remove <id>
```

Configure manually in `config.json` under the `mcp.servers` key — see `config.json.example` for a template.

Environment variables can be injected into headers/env values using `${VAR_NAME}` syntax:

```json
"headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
```

> 📖 See [docs/mcp.md](docs/mcp.md) for the full guide, popular servers, and troubleshooting.

---

## Heartbeat Events

Heartbeats are scheduled AI prompts that run every N minutes. Use them for periodic checks like "do I have unread emails that need a reply?" or "are there new PRs awaiting my review?"

### Quick setup

1. Set the interval in `.env`: `HEARTBEAT_INTERVAL_MINUTES=5`
2. Add a heartbeat event: `co-assistant heartbeat add`
3. Or trigger manually via Telegram: `/heartbeat`

### Simple heartbeat

The minimum setup is a single `.heartbeat.md` file in the `heartbeats/` directory:

```
heartbeats/
└── morning-briefing.heartbeat.md
```

The file contains the prompt sent to the AI agent on each tick. The AI response is forwarded to you via Telegram.

### Deduplication

To avoid repeated notifications for the same items, add the `{{DEDUP_STATE}}` placeholder to your prompt and include a `<!-- PROCESSED: id1, id2 -->` marker in the AI's response:

```markdown
<!-- heartbeats/pr-review.heartbeat.md -->
Check for open PRs awaiting my review. Already-notified PRs:
{{DEDUP_STATE}}

If there are new PRs, notify me and end your response with:
<!-- PROCESSED: <pr_id1>, <pr_id2> -->
```

On subsequent runs, `{{DEDUP_STATE}}` is replaced with a list of IDs from previous `<!-- PROCESSED: ... -->` markers so the AI can skip already-reported items.

> **Note:** `{{DEDUP_STATE}}` is designed for simple heartbeats without hooks. When using hooks, handle deduplication in your hooks instead: load state in `preAgentCall`, inject it into the prompt via `buildPrompt`, and save updated state in `postAgentCall`.

### Hooks pipeline

For heartbeats that need to fetch live data before calling the AI (e.g., querying an API), create a sibling `.heartbeat.hooks.mjs` file:

```
heartbeats/
├── pr-review.heartbeat.md
└── pr-review.heartbeat.hooks.mjs   ← auto-loaded when present
```

The hooks file exports up to three optional async functions forming a pipeline:

```
preAgentCall(state, context) → [optional: buildPrompt()] → AI agent call → [optional: postAgentCall()]
```

**`preAgentCall` receives two arguments:**
- `state` — the persisted `HeartbeatState` (`{ processedIds, lastRun }`) loaded by the engine
- `context` — an object provided by the engine with helpers:
  - `context.callTool(pluginId, toolName, args)` — call any active plugin's tool directly (e.g. `gmail`, `google-calendar`) without going through the AI agent

**Complete annotated example:**

```js
// heartbeats/pr-review.heartbeat.hooks.mjs

/**
 * Runs BEFORE the AI call. Fetch or prepare any data you need.
 * Receives the persisted state and an engine context with `callTool`.
 * Return null to abort the pipeline — the AI agent is NOT called.
 */
export async function preAgentCall(state, context) {
  // Call a plugin tool directly — no AI token cost
  const result = await context.callTool("github", "list_prs", { state: "open" });
  if (typeof result === "string") return null; // plugin error → abort

  const newPRs = result.prs.filter(pr => !state.processedIds.includes(pr.id));
  if (newPRs.length === 0) return null; // nothing new → abort

  return { processedIds: state.processedIds, prs: newPRs };
}

/**
 * Optional. Build the final prompt from pre-fetched data + the base .heartbeat.md text.
 * If omitted, use the {{PRE_AGENT_DATA}} placeholder in your .heartbeat.md instead.
 */
export async function buildPrompt(preData, basePrompt) {
  const prList = preData.prs.map(pr => `- #${pr.number}: ${pr.title}`).join("\n");
  return `${basePrompt}\n\nNew open PRs:\n${prList}`;
}

/**
 * Optional. Post-process the AI response before it is sent to Telegram.
 * Return { newState, response }:
 *   - newState — persisted by the engine (null = don't update state)
 *   - response — sent to Telegram (null = suppress notification)
 */
export async function postAgentCall(preData, agentResponse) {
  const merged = [...new Set([...preData.processedIds, ...preData.prs.map(pr => pr.id)])];
  return {
    newState: { processedIds: merged, lastRun: new Date().toISOString() },
    response: agentResponse || null,
  };
}
```

**When to use each hook:**

| Hook | Use when… |
|---|---|
| `preAgentCall` | You need live data (plugin tool calls, DB queries) before the AI runs |
| `preAgentCall` returns `null` | Skip the AI call entirely when there's nothing to process |
| `buildPrompt` | You want full control over the final prompt structure |
| `postAgentCall` | You need to filter, transform, persist state, or suppress the response |

All three hooks are optional — only export the ones you need.

### `context.callTool` — calling plugin tools from hooks

`context.callTool(pluginId, toolName, args)` lets hooks call any active plugin's tools directly, without burning AI tokens. Returns the tool's result (an object) or an error string.

```js
// Call gmail plugin's search_threads tool
const result = await context.callTool("gmail", "search_threads", {
  query: "in:inbox",
  maxThreads: 10,
});
if (typeof result === "string") return null; // handle error
```

Use this to pre-filter data in `preAgentCall` so the AI only sees what genuinely needs attention.

### `{{PRE_AGENT_DATA}}` placeholder

As a simpler alternative to `buildPrompt`, add `{{PRE_AGENT_DATA}}` directly in your `.heartbeat.md`. It is replaced with the JSON-serialised output of `preAgentCall()` automatically:

```markdown
<!-- heartbeats/pr-review.heartbeat.md -->
Here are the current open PRs (JSON):
{{PRE_AGENT_DATA}}

Notify me of any PRs that have been waiting more than 24 hours.
```

### Backward compatibility

Heartbeats without a hooks file work exactly as before. `{{DEDUP_STATE}}` and `<!-- PROCESSED: ... -->` deduplication markers are fully preserved and unaffected by the new hooks system.

---

## Architecture

```
your-project/                   # Your working directory
├── .env                        # Credentials (auto-created by setup)
├── config.json                 # Plugin & runtime config (auto-created)
├── personality.md              # AI personality instructions
├── user.md                     # Your personal profile
├── plugins/                    # Your plugins (gmail, google-calendar, custom)
│   ├── gmail/
│   └── google-calendar/
├── heartbeats/                 # Heartbeat prompt files
├── data/                       # SQLite database (auto-created)
└── node_modules/               # If installed locally
```

When installed globally, the package provides the `co-assistant` binary. All runtime files (config, data, plugins, heartbeats) live in whichever directory you run the command from.

**Key internals:**

- **Session pool** — Multiple parallel AI sessions so messages don't queue behind each other
- **System context** — `personality.md` + `user.md` injected into every AI prompt as system instructions
- **Plugin sandbox** — Every plugin call wrapped in try/catch with auto-disable after 5 failures
- **Plugin loader** — Uses `tsx/esm/api` to dynamically import TypeScript plugins from `plugins/`
- **Garbage collector** — Prunes old conversations (30 days) and health records (7 days); logs memory stats
- **Heartbeat deduplication** — State files track processed item IDs to avoid duplicate notifications
- **Reply threading** — Each AI response threads back to the user's original Telegram message

---

## Updating

```bash
npm update -g @hmawla/co-assistant
```

Your `.env`, `config.json`, `user.md`, plugins, and heartbeats are unaffected — they live in your working directory, not in the package.

---

## Uninstall

```bash
npm uninstall -g @hmawla/co-assistant
```

Your working directory and data are preserved. Delete it manually if no longer needed.

---

## License

MIT

# 🤖 Co-Assistant

AI-powered Telegram personal assistant built on the GitHub Copilot SDK.

Chat with state-of-the-art AI models (GPT-5, Claude Sonnet 4, o3, and more) directly from Telegram. Extend it with plugins for Gmail, Google Calendar, or build your own.

---

## Setup

### Prerequisites

| Requirement | How to get it |
|------------|---------------|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) |
| **Telegram Bot Token** | Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token |
| **Telegram User ID** | Message [@userinfobot](https://t.me/userinfobot) → copy the numeric ID |
| **GitHub Token** | [github.com/settings/tokens](https://github.com/settings/tokens) — create a token with Copilot access |

### Install & Configure

```bash
git clone https://github.com/your-username/co-assistant.git
cd co-assistant
npm install
```

Run the interactive setup wizard — it walks you through every credential and preference:

```bash
npx tsx src/cli/index.ts setup
```

The wizard creates your `.env` file and `config.json`. You can re-run it at any time to update settings.

### Personalise

Two markdown files control how the AI behaves and who it knows you are:

| File | Purpose | Committed? |
|------|---------|------------|
| `personality.md` | Defines the assistant's tone, style, and behaviour | ✅ Yes |
| `user.md` | Your personal profile (name, role, timezone, preferences) | ❌ Gitignored |

**Set up your user profile** (copy the template and fill in your details):

```bash
cp user.md.example user.md
```

Both files are read fresh on each message — edit them anytime without restarting.

### Start

```bash
npx tsx src/cli/index.ts start
```

Open Telegram, find your bot, and send a message. That's it.

**Verbose mode** (shows incoming/outgoing messages and debug logs in the terminal):

```bash
npx tsx src/cli/index.ts start -v
```

---

## Production Deployment

For running Co-Assistant permanently on a server (VPS, Raspberry Pi, etc.).

### 1. Build

```bash
npm run build
```

This compiles TypeScript to `dist/` via tsup.

### 2. Run with systemd (recommended for Linux)

Create a service file:

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
WorkingDirectory=/path/to/co-assistant
ExecStart=/usr/bin/node dist/index.js start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

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

### 3. Alternative: PM2

```bash
npm install -g pm2
pm2 start dist/index.js --name co-assistant -- start
pm2 save
pm2 startup    # generates command to auto-start on boot
```

### 4. Alternative: Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ dist/
COPY plugins/ plugins/
COPY heartbeats/ heartbeats/
COPY personality.md ./
COPY config.json .env ./
# Optional — only if you created a user.md:
# COPY user.md ./
CMD ["node", "dist/index.js", "start"]
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

## CLI Commands

**How to run commands:**

```bash
# During development (runs TypeScript directly):
npx tsx src/cli/index.ts setup
npx tsx src/cli/index.ts start -v

# After building (npm run build):
node dist/cli/index.js setup
node dist/cli/index.js start

# After global install (npm install -g .):
co-assistant setup
co-assistant start
```

| Command | Description |
|---------|-------------|
| `setup` | Interactive setup wizard |
| `start` | Start the bot (`-v` for verbose) |
| `model` | Show current model |
| `model <name>` | Switch AI model |
| `plugin list` | List discovered plugins |
| `plugin enable <name>` | Enable a plugin |
| `plugin disable <name>` | Disable a plugin |
| `plugin configure <name>` | Set up plugin credentials |
| `heartbeat list` | List heartbeat events |
| `heartbeat add` | Create a new heartbeat event |
| `heartbeat remove <name>` | Delete a heartbeat event |
| `heartbeat run [name]` | Test heartbeat(s) on demand |
| `status` | Show bot and system status |

---

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/help` | List available commands |
| `/heartbeat [name]` | Run heartbeat event(s) on demand |
| `/hb [name]` | Shorthand for `/heartbeat` |

Anything else you type is a conversation with the AI.

---

## Available Models

Models are grouped by rate consumption (requests per prompt):

| Tier | Models | Rate |
|------|--------|------|
| **Premium** | `gpt-5`, `o3`, `claude-opus-4` | 3x |
| **Standard** | `gpt-4.1`, `gpt-4o`, `o4-mini`, `claude-sonnet-4` | 1x |
| **Low** | `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-5-mini`, `o3-mini`, `claude-haiku-4.5` | 0.33x |
| **Free** | `gpt-4.1-nano` | 0x |

Switch via CLI (`co-assistant model claude-sonnet-4`) or in the setup wizard.

---

## Personality & User Profile

### `personality.md` — How the AI behaves

Defines the assistant's identity, tone, formatting rules, and boundaries. This file is committed to the repo so your team shares the same base personality. Edit it to change the assistant's style.

### `user.md` — Who you are

Contains your personal details so the AI can address you correctly and understand your context. This file is gitignored — each user creates their own from the template.

Both files are injected as system-level context on every message. The AI sees:
1. Personality instructions (how to behave)
2. User profile (who it's talking to)
3. Your actual message

---

## Plugins

### Included Plugins

| Plugin | Tools provided |
|--------|---------------|
| **Gmail** | Search emails, read email, send email, send reply |
| **Google Calendar** | List events, create event, update event, delete event |

### Enable a Plugin

```bash
npx tsx src/cli/index.ts plugin enable gmail
npx tsx src/cli/index.ts plugin configure gmail
```

The configure command walks you through setting up OAuth credentials. For Google plugins, it includes an automated local OAuth flow to obtain refresh tokens.

### Create Your Own Plugin

Create a directory under `plugins/` with:

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

## Heartbeat Events

Heartbeats are scheduled AI prompts that run every N minutes. Use them for periodic checks like "do I have unread emails that need a reply?"

### Setup

1. Set the interval in `.env`: `HEARTBEAT_INTERVAL_MINUTES=5`
2. Add a heartbeat event:

```bash
npx tsx src/cli/index.ts heartbeat add
```

3. Or trigger manually via Telegram: `/heartbeat`

Heartbeat prompts are stored as `.heartbeat.md` files in the `heartbeats/` directory. They support deduplication via `{{DEDUP_STATE}}` placeholders and `<!-- PROCESSED: id1, id2 -->` markers.

---

## Architecture

```
co-assistant/
├── src/
│   ├── ai/            # Copilot SDK client, session pool, model registry
│   ├── bot/           # Telegraf bot, handlers, middleware (auth, logging)
│   ├── cli/           # Commander.js CLI (setup, start, plugin, model, heartbeat)
│   ├── core/          # App orchestrator, config, logger, heartbeat, GC
│   ├── plugins/       # Plugin registry, manager, sandbox, credentials
│   ├── storage/       # SQLite database, migrations, repositories
│   └── utils/         # Google OAuth helper
├── plugins/           # Installed plugins (gmail, google-calendar)
├── heartbeats/        # Heartbeat prompt files (.heartbeat.md)
├── data/              # SQLite database (auto-created)
├── personality.md     # AI personality & behaviour instructions
├── user.md            # Your personal profile (gitignored)
├── user.md.example    # User profile template
├── config.json        # Plugin & runtime configuration (gitignored)
└── config.json.example
```

**Key internals:**

- **Session pool** — Multiple parallel AI sessions so messages don't queue behind each other
- **System context** — `personality.md` + `user.md` injected into every AI prompt as system instructions
- **Plugin sandbox** — Every plugin call wrapped in try/catch with auto-disable after 5 failures
- **Plugin loader** — Uses `tsx/esm/api` to dynamically import TypeScript plugins from `plugins/`
- **Garbage collector** — Prunes old conversations (30 days) and health records (7 days); logs memory stats
- **Heartbeat deduplication** — State files track processed item IDs to avoid duplicate notifications
- **Reply threading** — Each AI response threads back to the user's original Telegram message

---

## License

MIT

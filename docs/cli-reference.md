# CLI Reference

> **Binary:** `co-assistant` · **Version:** 1.0.0

---

## Global Options

Every command inherits the following flags:

| Flag | Description |
|------|-------------|
| `-V, --version` | Print the CLI version and exit |
| `-h, --help` | Show help for any command |

```bash
co-assistant --version
co-assistant --help
co-assistant <command> --help
```

---

## `co-assistant start`

Start the Co-Assistant Telegram bot. Creates an application instance and boots all subsystems (AI, Telegram, plugins).

### Syntax

```
co-assistant start [options]
```

### Options

| Flag | Description |
|------|-------------|
| `-v, --verbose` | Enable verbose/debug logging |

### Examples

```bash
# Start the bot
co-assistant start

# Start with debug output
co-assistant start --verbose
```

### Notes

- Requires a valid `.env` file with at least `TELEGRAM_BOT_TOKEN` configured. Run `co-assistant setup` first if you haven't already.
- The process runs in the foreground. Use Ctrl+C to stop.

---

## `co-assistant setup`

Run the interactive setup wizard. Walks through Telegram, AI, and GitHub configuration, writing values to `.env`, then optionally configures plugins.

### Syntax

```
co-assistant setup [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--plugin <id>` | Skip the global wizard and configure a single plugin only |

### Examples

```bash
# Run the full setup wizard
co-assistant setup
```

```
🔧 Co-Assistant Setup Wizard
────────────────────────────

Step 1: Telegram Bot Configuration
  Telegram Bot Token (from @BotFather): ********
  Your Telegram User ID: 123456789

Step 2: AI Configuration
  Default AI Model (gpt-4.1): gpt-4.1

Step 3: Optional - GitHub Token
  GitHub Token (for Copilot SDK, optional): ********

✓ Configuration saved to .env

Would you like to configure plugins now? (y/N)
```

```bash
# Configure a single plugin directly
co-assistant setup --plugin github
```

```
Configuring plugin: github

  Configuring github...
  GITHUB_TOKEN (GitHub personal access token): ********
  Enable this plugin? (y/N) y
  ✓ github configured and enabled
```

### Notes

- The global wizard walks through four steps: Telegram bot token, AI model, GitHub token, and plugin configuration.
- Environment values are saved to `.env`. Plugin settings are saved to `config.json`.
- If `--plugin <id>` references a plugin that doesn't exist, the command exits with an error and lists available plugins.
- Press Ctrl+C at any time to cancel setup gracefully.

---

## `co-assistant plugin`

Manage plugins — list, enable, disable, inspect, and scaffold new plugins.

### Syntax

```
co-assistant plugin <subcommand> [args]
```

### Subcommands

- [`plugin list`](#co-assistant-plugin-list)
- [`plugin enable <id>`](#co-assistant-plugin-enable-id)
- [`plugin disable <id>`](#co-assistant-plugin-disable-id)
- [`plugin info <id>`](#co-assistant-plugin-info-id)
- [`plugin create <id>`](#co-assistant-plugin-create-id)

---

### `co-assistant plugin list`

List all discovered plugins with their status and credential information.

#### Syntax

```
co-assistant plugin list
```

#### Examples

```bash
co-assistant plugin list
```

```
🔌 Discovered Plugins:

  github (v1.0.0) - GitHub Plugin
  Status: ✅ Enabled | Credentials: ✓ configured

  linear (v1.0.0) - Linear Plugin
  Status: ❌ Disabled | Credentials: ✗ missing (LINEAR_API_KEY)
```

#### Notes

- Plugins are auto-discovered from the `plugins/` directory.
- Credential status shows whether all required credentials are configured in `config.json`.

---

### `co-assistant plugin enable <id>`

Enable a plugin by ID.

#### Syntax

```
co-assistant plugin enable <id>
```

| Argument | Description |
|----------|-------------|
| `<id>` | Plugin ID to enable |

#### Examples

```bash
co-assistant plugin enable github
```

```
✓ Plugin 'github' enabled
```

```bash
# If already enabled
co-assistant plugin enable github
```

```
ℹ Plugin 'github' is already enabled.
```

#### Notes

- The plugin must exist in the `plugins/` directory. If not found, the command exits with an error suggesting `plugin list`.

---

### `co-assistant plugin disable <id>`

Disable a plugin by ID.

#### Syntax

```
co-assistant plugin disable <id>
```

| Argument | Description |
|----------|-------------|
| `<id>` | Plugin ID to disable |

#### Examples

```bash
co-assistant plugin disable github
```

```
✓ Plugin 'github' disabled
```

```bash
# If already disabled
co-assistant plugin disable github
```

```
ℹ Plugin 'github' is already disabled.
```

---

### `co-assistant plugin info <id>`

Show detailed information about a plugin, including version, author, status, and credential configuration.

#### Syntax

```
co-assistant plugin info <id>
```

| Argument | Description |
|----------|-------------|
| `<id>` | Plugin ID to inspect |

#### Examples

```bash
co-assistant plugin info github
```

```
📋 Plugin: GitHub Plugin
──────────────────────
ID:          github
Version:     1.0.0
Description: GitHub integration plugin
Author:      co-assistant
Status:      Enabled

Required Credentials:
  GITHUB_TOKEN - GitHub personal access token [configured]
```

---

### `co-assistant plugin create <id>`

Scaffold a new plugin from a template. Creates a ready-to-edit plugin directory under `plugins/`.

#### Syntax

```
co-assistant plugin create <id>
```

| Argument | Description |
|----------|-------------|
| `<id>` | ID for the new plugin (must be kebab-case) |

#### Examples

```bash
co-assistant plugin create my-plugin
```

```
✓ Plugin 'my-plugin' scaffolded at plugins/my-plugin/
```

#### Generated Files

| File | Purpose |
|------|---------|
| `plugin.json` | Plugin manifest (id, name, version, credentials) |
| `index.ts` | Plugin entry point with lifecycle hooks |
| `tools.ts` | Tool definitions exposed by the plugin |
| `README.md` | Plugin documentation template |

#### Notes

- The plugin ID must be **kebab-case** (lowercase letters, numbers, and hyphens only). Invalid IDs are rejected.
- The command exits with an error if a directory with the same name already exists under `plugins/`.
- The generated `plugin.json` name is derived from the ID (e.g., `my-plugin` → "My Plugin").

---

## `co-assistant model`

Manage AI model selection and configuration.

### Syntax

```
co-assistant model <subcommand> [args]
```

### Subcommands

- [`model list`](#co-assistant-model-list)
- [`model get`](#co-assistant-model-get)
- [`model set <modelId>`](#co-assistant-model-set-modelid)

---

### `co-assistant model list`

List all available AI models in a formatted table. The currently selected model is marked with `*`.

#### Syntax

```
co-assistant model list
```

#### Examples

```bash
co-assistant model list
```

```
Available Models:
┌──────────────────┬──────────┬──────────────────────────────┐
│ ID               │ Provider │ Description                  │
├──────────────────┼──────────┼──────────────────────────────┤
│ * gpt-4.1        │ openai   │ Latest GPT-4.1 model         │
│   gpt-4.1-mini   │ openai   │ Smaller, faster GPT-4.1      │
│   claude-sonnet   │ claude   │ Claude Sonnet model          │
└──────────────────┴──────────┴──────────────────────────────┘
* = currently selected
```

---

### `co-assistant model get`

Print the currently configured AI model ID.

#### Syntax

```
co-assistant model get
```

#### Examples

```bash
co-assistant model get
```

```
Current model: gpt-4.1
```

---

### `co-assistant model set <modelId>`

Set the active AI model. The selection is persisted to the database.

#### Syntax

```
co-assistant model set <modelId>
```

| Argument | Description |
|----------|-------------|
| `<modelId>` | Model identifier to activate |

#### Examples

```bash
co-assistant model set gpt-4.1-mini
```

```
✓ Model set to: gpt-4.1-mini
```

```bash
# Setting an unknown model (still allowed, but warns)
co-assistant model set custom-model
```

```
⚠ Warning: 'custom-model' is not in the known models list
✓ Model set to: custom-model
```

#### Notes

- Use `model list` to see valid model IDs.
- Unknown model IDs produce a warning but are still accepted, allowing use of newly released models before the known-models list is updated.

---

## `co-assistant status`

Show the current status of the bot and all plugins.

### Syntax

```
co-assistant status
```

### Examples

```bash
co-assistant status
```

```
Fetching status...
```

### Notes

- This command is currently a placeholder and will display full runtime status information in a future release.

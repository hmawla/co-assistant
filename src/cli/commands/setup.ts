/**
 * @module cli/commands/setup
 * @description CLI command for interactive setup and configuration wizard.
 *
 * Provides two modes:
 * - **Global setup** (`co-assistant setup`) — walks the user through Telegram,
 *   AI model selection, and GitHub configuration, writing values to `.env`,
 *   then optionally configures plugins with guided credential setup.
 * - **Single-plugin setup** (`co-assistant setup --plugin <id>`) — configures
 *   one plugin's credentials and enabled state in `config.json`.
 *
 * For Google-based plugins (Gmail, Google Calendar), the setup accepts a
 * client_secret JSON file path instead of prompting for individual OAuth fields.
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  promptText,
  promptSecret,
  promptConfirm,
  promptSelect,
  promptFilePath,
} from "../../utils/prompt.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  performGoogleOAuthFlow,
  GOOGLE_PLUGIN_SCOPES,
} from "../../utils/google-oauth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the environment file. */
const ENV_PATH = "./.env";

/** Path to the application configuration file. */
const CONFIG_PATH = "./config.json";

// ---------------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------------

/**
 * Parse an existing `.env` file into a key-value map.
 * Lines that are blank, comments, or malformed are silently skipped.
 *
 * @returns A `Map<string, string>` of environment variable names to values.
 */
function parseEnvFile(): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return vars;

  const content = readFileSync(ENV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars.set(key, value);
  }
  return vars;
}

/**
 * Write a key-value map back to the `.env` file.
 *
 * Preserves comments and blank lines from the existing file when possible.
 * New keys are appended at the end.
 *
 * @param vars - Map of environment variable names to their values.
 */
function writeEnvFile(vars: Map<string, string>): void {
  const lines: string[] = [];
  const written = new Set<string>();

  // Preserve structure of existing file
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        lines.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        lines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIdx).trim();
      if (vars.has(key)) {
        lines.push(`${key}=${vars.get(key)}`);
        written.add(key);
      } else {
        lines.push(line);
      }
    }
  }

  // Append any new keys not already in the file
  for (const [key, value] of vars) {
    if (!written.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// config.json helpers
// ---------------------------------------------------------------------------

/**
 * Load the current `config.json` as a plain object.
 * Returns an empty object if the file does not exist.
 */
function loadConfigJson(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write the config object back to `config.json` (pretty-printed).
 */
function saveConfigJson(config: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Available AI models (mirrors src/ai/models.ts DEFAULT_MODELS)
// ---------------------------------------------------------------------------

/** Model choices displayed during setup. Format: "id — description [rate]" */
const MODEL_CHOICES = [
  // Premium (3x per request)
  "gpt-5 — OpenAI GPT-5 [3x]",
  "o3 — OpenAI o3 reasoning [3x]",
  "claude-opus-4 — Anthropic Claude Opus 4 [3x]",
  // Standard (1x per request)
  "gpt-4.1 — OpenAI GPT-4.1 [1x]",
  "gpt-4o — OpenAI GPT-4o multimodal [1x]",
  "o4-mini — OpenAI o4-mini reasoning [1x]",
  "claude-sonnet-4 — Anthropic Claude Sonnet 4 [1x]",
  // Low (0.33x per request)
  "gpt-4o-mini — OpenAI GPT-4o Mini [0.33x]",
  "gpt-4.1-mini — OpenAI GPT-4.1 Mini [0.33x]",
  "gpt-5-mini — OpenAI GPT-5 Mini [0.33x]",
  "o3-mini — OpenAI o3-mini reasoning [0.33x]",
  "claude-haiku-4.5 — Anthropic Claude Haiku 4.5 [0.33x]",
  // Free (0x per request)
  "gpt-4.1-nano — OpenAI GPT-4.1 Nano [0x]",
];

/**
 * Extract the model ID from a model choice string (e.g. "gpt-4.1 — ...").
 */
function extractModelId(choice: string): string {
  return choice.split("—")[0].trim();
}

// ---------------------------------------------------------------------------
// Plugin credential guides
// ---------------------------------------------------------------------------

/**
 * Per-plugin setup instructions shown before prompting for credentials.
 * Helps users understand what credentials are needed and where to get them.
 */
const PLUGIN_CREDENTIAL_GUIDES: Record<string, string> = {
  gmail: `
  📋 Gmail Plugin — Setup Guide
  ──────────────────────────────
  To use the Gmail plugin you need Google OAuth2 credentials:

  1. Go to https://console.cloud.google.com/apis/credentials
  2. Create a project (or select an existing one)
  3. Configure the OAuth consent screen (APIs & Services → OAuth consent screen)
     - Set to "External" for personal use, add your email as a test user
  4. Enable the "Gmail API" under APIs & Services → Library
  5. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
  6. Application type: "Desktop app" (recommended — allows automatic localhost redirect)
  7. Download the client secret JSON file

  The setup will import your JSON file and then automatically open your browser
  to authorize access. No manual token copy-pasting required!
`,

  "google-calendar": `
  📋 Google Calendar Plugin — Setup Guide
  ─────────────────────────────────────────
  To use the Google Calendar plugin you need Google OAuth2 credentials:

  1. Go to https://console.cloud.google.com/apis/credentials
  2. Create a project (or select an existing one)
  3. Configure the OAuth consent screen (APIs & Services → OAuth consent screen)
     - Set to "External" for personal use, add your email as a test user
  4. Enable the "Google Calendar API" under APIs & Services → Library
  5. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
  6. Application type: "Desktop app" (recommended — allows automatic localhost redirect)
  7. Download the client secret JSON file

  The setup will import your JSON file and then automatically open your browser
  to authorize access. No manual token copy-pasting required!
`,
};

// ---------------------------------------------------------------------------
// Google client secret JSON parser
// ---------------------------------------------------------------------------

/** Structure of a Google OAuth2 client secret JSON file. */
interface GoogleClientSecretJson {
  client_id: string;
  client_secret: string;
}

/**
 * Parse a Google client secret JSON file and extract client_id and client_secret.
 *
 * Supports both "installed" (Desktop) and "web" application types.
 *
 * @param content - Raw JSON string from the downloaded credentials file.
 * @returns Parsed credentials, or `null` if the format is unrecognised.
 */
function parseGoogleClientSecretJson(content: string): GoogleClientSecretJson | null {
  try {
    const parsed = JSON.parse(content) as Record<string, Record<string, string>>;

    // Google exports credentials under either "installed" or "web"
    const creds = parsed.installed ?? parsed.web;
    if (!creds || !creds.client_id || !creds.client_secret) {
      return null;
    }

    return {
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    };
  } catch {
    return null;
  }
}

/**
 * IDs of plugins that use Google OAuth2 and support client_secret JSON import.
 */
const GOOGLE_OAUTH_PLUGINS = new Set(["gmail", "google-calendar"]);

// ---------------------------------------------------------------------------
// Plugin setup flow
// ---------------------------------------------------------------------------

/**
 * Interactive setup for a single plugin.
 *
 * For Google OAuth plugins (Gmail, Google Calendar):
 * 1. Prompts for the client_secret JSON file — **extracts** `client_id` and
 *    `client_secret` and stores them directly in config.json (the file itself
 *    is never referenced again).
 * 2. Runs a local OAuth authorization flow (temporary HTTP server + browser)
 *    to obtain the refresh token automatically.
 * 3. Falls back to manual refresh-token entry if the OAuth flow fails.
 *
 * For other plugins, prompts for each credential individually.
 *
 * Shows a credential setup guide before prompting if one is available.
 *
 * @param manifest - The plugin's validated manifest.
 */
async function setupPlugin(manifest: PluginManifest): Promise<void> {
  console.log(`\n  Configuring ${manifest.id}...`);

  // Show credential guide if available
  const guide = PLUGIN_CREDENTIAL_GUIDES[manifest.id];
  if (guide) {
    console.log(guide);
  }

  const config = loadConfigJson();
  const plugins = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;
  const existing = (plugins[manifest.id] ?? {}) as Record<string, unknown>;
  const existingCreds = (existing.credentials ?? {}) as Record<string, string>;
  const newCreds: Record<string, string> = { ...existingCreds };

  if (GOOGLE_OAUTH_PLUGINS.has(manifest.id)) {
    // --- Google OAuth plugins: JSON import → local OAuth flow ---
    const prefix = manifest.id === "gmail" ? "GMAIL" : "GCAL";
    const clientIdKey = `${prefix}_CLIENT_ID`;
    const clientSecretKey = `${prefix}_CLIENT_SECRET`;
    const refreshTokenKey = `${prefix}_REFRESH_TOKEN`;

    const hasExisting = existingCreds[clientIdKey] && existingCreds[clientSecretKey];
    const skipJson = hasExisting && !(await promptConfirm(
      "  Existing credentials found. Re-import client secret JSON?",
      false,
    ));

    if (!skipJson) {
      console.log("  Provide the path to your Google OAuth client_secret JSON file.");
      console.log("  (Downloaded from Google Cloud Console → Credentials)");
      console.log("  Note: Only the credentials are extracted — the file is not stored or referenced.\n");

      // Keep prompting until we get a valid file
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const jsonContent = await promptFilePath("  Path to client_secret JSON file");
        const parsed = parseGoogleClientSecretJson(jsonContent);

        if (parsed) {
          newCreds[clientIdKey] = parsed.client_id;
          newCreds[clientSecretKey] = parsed.client_secret;
          console.log(`  ✓ Extracted client_id: ${parsed.client_id.slice(0, 20)}...`);
          console.log(`  ✓ Extracted client_secret: ${"*".repeat(8)}`);
          break;
        } else {
          console.log("  ⚠ Could not parse client_secret JSON. Expected format:");
          console.log('    { "installed": { "client_id": "...", "client_secret": "..." } }');
          console.log("  Please try again.\n");
        }
      }
    }

    // ── Obtain refresh token via local OAuth flow ──────────────────────
    const clientId = newCreds[clientIdKey];
    const clientSecret = newCreds[clientSecretKey];
    const scopes = GOOGLE_PLUGIN_SCOPES[manifest.id];

    const hasRefreshToken = Boolean(existingCreds[refreshTokenKey]);
    const runOAuth = !hasRefreshToken || (await promptConfirm(
      "  Run Google authorization to obtain a new refresh token?",
      !hasRefreshToken, // default to yes if no existing token
    ));

    if (runOAuth && clientId && clientSecret && scopes) {
      try {
        const result = await performGoogleOAuthFlow(clientId, clientSecret, scopes);
        newCreds[refreshTokenKey] = result.refreshToken;
        console.log("  ✅ Authorization successful! Refresh token obtained and stored.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`\n  ⚠ OAuth flow failed: ${message}`);
        console.log("  Falling back to manual entry...\n");

        // Manual fallback: let the user paste a refresh token
        const manualToken = await promptSecret(`  ${refreshTokenKey} (paste refresh token manually)`);
        newCreds[refreshTokenKey] = manualToken || existingCreds[refreshTokenKey] || "";
      }
    } else if (!runOAuth) {
      // Keep existing refresh token
      newCreds[refreshTokenKey] = existingCreds[refreshTokenKey] || "";
    }
  } else {
    // --- Generic plugins: prompt per credential ---
    for (const cred of manifest.requiredCredentials) {
      const current = existingCreds[cred.key] || undefined;
      const isSensitive =
        cred.type === "apikey" ||
        cred.type === "oauth" ||
        cred.key.toLowerCase().includes("secret") ||
        cred.key.toLowerCase().includes("token");

      if (isSensitive) {
        const value = await promptSecret(`  ${cred.key} (${cred.description})`);
        newCreds[cred.key] = value || current || "";
      } else {
        const value = await promptText(`  ${cred.key} (${cred.description})`, current);
        newCreds[cred.key] = value;
      }
    }
  }

  const enable = await promptConfirm("  Enable this plugin?", false);

  plugins[manifest.id] = {
    ...existing,
    enabled: enable,
    credentials: newCreds,
  };
  config.plugins = plugins;
  saveConfigJson(config);

  console.log(`  ✓ ${manifest.id} configured${enable ? " and enabled" : ""}`);
}

// ---------------------------------------------------------------------------
// Global setup flow
// ---------------------------------------------------------------------------

/**
 * Run the full interactive setup wizard.
 *
 * Walks the user through:
 * 1. Telegram bot configuration (token, user ID)
 * 2. AI model selection from a list of available Copilot models
 * 3. Optional GitHub token
 * 4. Optional plugin configuration (with guided credential setup)
 *
 * All environment values are written to `.env`.
 */
async function runGlobalSetup(): Promise<void> {
  console.log("\n🔧 Co-Assistant Setup Wizard");
  console.log("────────────────────────────\n");

  const envVars = parseEnvFile();

  // Step 1: Telegram
  console.log("Step 1: Telegram Bot Configuration");
  console.log(`
  📋 How to get your Telegram Bot Token:
  ───────────────────────────────────────
  1. Open Telegram and search for @BotFather
  2. Send /newbot and follow the prompts to name your bot
  3. BotFather will reply with a token like: 123456789:ABCdefGHI...
  4. Copy that token and paste it below

  📋 How to get your Telegram User ID:
  ─────────────────────────────────────
  1. Open Telegram and search for @userinfobot
  2. Send any message (e.g. /start)
  3. It will reply with your numeric User ID (e.g. 123456789)
  4. This restricts the bot so only you can use it
`);
  const existingToken = envVars.get("TELEGRAM_BOT_TOKEN");
  const existingUserId = envVars.get("TELEGRAM_USER_ID");

  if (existingToken || existingUserId) {
    console.log("  Existing values (press Enter to keep):");
    if (existingToken) console.log(`    Bot Token: ${existingToken.slice(0, 8)}${"*".repeat(12)}`);
    if (existingUserId) console.log(`    User ID:   ${existingUserId}`);
    console.log("");
  }

  const botToken = await promptSecret(
    "  Telegram Bot Token (Enter to keep existing)",
  );
  envVars.set("TELEGRAM_BOT_TOKEN", botToken || existingToken || "");

  const userId = await promptText(
    "  Your Telegram User ID (from @userinfobot)",
    existingUserId,
  );
  envVars.set("TELEGRAM_USER_ID", userId || existingUserId || "");

  // Step 2: AI Model Selection
  console.log("\nStep 2: AI Model Selection");
  const currentModel = envVars.get("DEFAULT_MODEL") || "gpt-4.1";
  console.log(`  Current model: ${currentModel}`);

  const changeModel = await promptConfirm("  Would you like to select a different model?", false);
  if (changeModel) {
    const choice = await promptSelect("  Available Copilot models:", MODEL_CHOICES);
    const selectedModel = extractModelId(choice);
    envVars.set("DEFAULT_MODEL", selectedModel);
    console.log(`  ✓ Model set to: ${selectedModel}`);
  } else {
    envVars.set("DEFAULT_MODEL", currentModel);
  }

  // Step 3: GitHub Token
  console.log("\nStep 3: GitHub Token (for Copilot SDK)");
  console.log(`
  📋 How to get a GitHub Personal Access Token:
  ──────────────────────────────────────────────
  1. Go to https://github.com/settings/tokens?type=beta
  2. Click "Generate new token"
  3. Give it a name (e.g. "co-assistant")
  4. Set expiration as needed
  5. Under "Permissions", enable:
     - "Copilot" → Read-only (required for Copilot SDK access)
  6. Click "Generate token" and copy it

  Alternatively, if you have the GitHub CLI installed:
    gh auth token

  Note: Your account must have an active GitHub Copilot subscription.
`);
  const existingGhToken = envVars.get("GITHUB_TOKEN");
  if (existingGhToken) {
    console.log(`  Existing token: ${existingGhToken.slice(0, 8)}${"*".repeat(12)} (Enter to keep)\n`);
  }
  const ghToken = await promptSecret(
    "  GitHub Token (Enter to keep existing / skip)",
  );
  if (ghToken) {
    envVars.set("GITHUB_TOKEN", ghToken);
  }

  // Ensure LOG_LEVEL has a default
  if (!envVars.has("LOG_LEVEL")) {
    envVars.set("LOG_LEVEL", "info");
  }

  // Step 4: Heartbeat Configuration
  console.log("\nStep 4: Heartbeat Events (Scheduled AI Prompts)");
  console.log(`
  Heartbeat events are prompts the AI processes on a recurring schedule.
  Set the interval in minutes (e.g. 30 = every 30 minutes).
  Set to 0 to disable heartbeat events.
`);
  const currentInterval = envVars.get("HEARTBEAT_INTERVAL_MINUTES") || "0";
  const interval = await promptText(
    "  Heartbeat interval in minutes (0 to disable)",
    currentInterval,
  );
  envVars.set("HEARTBEAT_INTERVAL_MINUTES", interval);

  writeEnvFile(envVars);
  console.log("\n✓ Configuration saved to .env");

  // Remind about personality & user profile
  console.log(`
  💡 Tip: Personalise your assistant!
     • Edit personality.md to change the AI's tone and behaviour.
     • Copy user.md.example → user.md and fill in your details
       so the AI knows your name, role, timezone, and preferences.
     Both files are picked up automatically — no restart needed.
`);

  // Step 5: Plugin configuration
  const configurePlugins = await promptConfirm(
    "\nWould you like to configure plugins now?",
    false,
  );

  if (!configurePlugins) return;

  const registry = createPluginRegistry();
  const manifests = await registry.discoverPlugins();

  if (manifests.length === 0) {
    console.log("\n  No plugins found in the plugins/ directory.");
    return;
  }

  // Plugin selection loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log("\n  Available plugins:");
    manifests.forEach((m, i) => {
      console.log(`    ${i + 1}. ${m.id} - ${m.name}`);
    });

    const answer = await promptText(
      "\n  Select a plugin to configure (number or 'done' to finish)",
    );

    if (answer.toLowerCase() === "done" || answer === "") break;

    const num = parseInt(answer, 10);
    if (num >= 1 && num <= manifests.length) {
      await setupPlugin(manifests[num - 1]);
    } else {
      console.log("  ⚠ Invalid selection. Enter a number or 'done'.");
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Registers the `setup` subcommand on the given Commander program.
 *
 * Options:
 * - `--plugin <id>` — Skip global setup and configure a single plugin.
 *
 * @param program - The root Commander {@link Command} instance.
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Run the interactive setup wizard")
    .option("--plugin <id>", "Configure a specific plugin only")
    .action(async (options: { plugin?: string }) => {
      // Handle Ctrl+C gracefully
      process.on("SIGINT", () => {
        console.log("\n\n👋 Setup cancelled.");
        process.exit(0);
      });

      try {
        if (options.plugin) {
          // Single-plugin mode
          const registry = createPluginRegistry();
          const manifests = await registry.discoverPlugins();
          const manifest = manifests.find((m) => m.id === options.plugin);

          if (!manifest) {
            console.error(`\n✗ Plugin "${options.plugin}" not found.`);
            const ids = manifests.map((m) => m.id);
            if (ids.length > 0) {
              console.error(`  Available plugins: ${ids.join(", ")}`);
            }
            process.exit(1);
          }

          console.log(`\nConfiguring plugin: ${manifest.id}`);
          await setupPlugin(manifest);
        } else {
          // Full setup wizard
          await runGlobalSetup();
        }

        console.log("");
      } catch (err) {
        // Readline close on Ctrl+C throws ERR_USE_AFTER_CLOSE
        if ((err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") {
          console.log("\n\n👋 Setup cancelled.");
          process.exit(0);
        }
        throw err;
      }
    });
}

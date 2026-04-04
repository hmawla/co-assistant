/**
 * @module plugins/credentials
 * @description Per-plugin credential management — reads, validates, and
 * provides credentials declared by each plugin's manifest.
 *
 * Credentials are sourced from the application's `config.json` under
 * `plugins.<pluginId>.credentials`.  The {@link CredentialManager} ensures
 * that every key a plugin declares as required is present and non-empty
 * before the plugin is allowed to initialise.
 *
 * **Security:** credential *values* are never written to logs.
 */

import type { Logger } from "pino";
import { getConfig } from "../core/config.js";
import { PluginError } from "../core/errors.js";
import { createChildLogger } from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single credential requirement from a plugin manifest. */
interface CredentialRequirement {
  key: string;
  description: string;
  type?: string;
}

/** Result of a validation check — either valid or carrying the missing keys. */
type ValidationResult =
  | { valid: true }
  | { valid: false; missing: string[] };

/** Per-plugin status entry returned by {@link CredentialManager.getCredentialStatus}. */
interface CredentialStatusEntry {
  pluginId: string;
  configured: string[];
  missing: string[];
}

// ---------------------------------------------------------------------------
// CredentialManager
// ---------------------------------------------------------------------------

/**
 * Reads, validates, and provides credentials for each plugin based on the
 * application configuration (`config.json`).
 *
 * Typical usage inside the plugin loader:
 * ```ts
 * const creds = credentialManager.getValidatedCredentials(
 *   manifest.id,
 *   manifest.requiredCredentials,
 * );
 * ```
 */
export class CredentialManager {
  private logger: Logger;

  constructor() {
    this.logger = createChildLogger("plugins:credentials");
  }

  /**
   * Get credentials for a plugin from config.json.
   * Returns the credentials `Record` or an empty object if not configured.
   */
  getPluginCredentials(pluginId: string): Record<string, string> {
    const { app } = getConfig();
    return app.plugins[pluginId]?.credentials ?? {};
  }

  /**
   * Validate that all required credentials are present and non-empty.
   *
   * @returns `{ valid: true }` when every required key is present with a
   *   non-empty value, or `{ valid: false, missing }` listing the keys that
   *   are absent or empty.
   */
  validateCredentials(
    pluginId: string,
    requiredCredentials: CredentialRequirement[],
  ): ValidationResult {
    const credentials = this.getPluginCredentials(pluginId);

    const missing = requiredCredentials
      .filter(({ key }) => {
        const value = credentials[key];
        return value === undefined || value === "";
      })
      .map(({ key }) => key);

    if (missing.length === 0) {
      this.logger.debug({ pluginId }, "All required credentials present");
      return { valid: true };
    }

    this.logger.warn(
      { pluginId, missing },
      "Missing required credentials for plugin",
    );
    return { valid: false, missing };
  }

  /**
   * Get credentials for a plugin, throwing {@link PluginError} if any
   * required ones are missing.
   *
   * This is the main method plugins use during initialisation.
   *
   * @throws {PluginError} with code `PLUGIN_CREDENTIALS_MISSING` when one or
   *   more required keys are absent or empty.
   */
  getValidatedCredentials(
    pluginId: string,
    requiredCredentials: CredentialRequirement[],
  ): Record<string, string> {
    const result = this.validateCredentials(pluginId, requiredCredentials);

    if (!result.valid) {
      throw PluginError.credentialsMissing(pluginId, result.missing);
    }

    this.logger.info(
      { pluginId, count: requiredCredentials.length },
      "Credentials validated successfully",
    );

    return this.getPluginCredentials(pluginId);
  }

  /**
   * Check whether a plugin has all required credentials configured.
   *
   * Non-throwing convenience wrapper around {@link validateCredentials}.
   */
  hasRequiredCredentials(
    pluginId: string,
    requiredCredentials: CredentialRequirement[],
  ): boolean {
    return this.validateCredentials(pluginId, requiredCredentials).valid;
  }

  /**
   * Get a summary of credential status for all known plugins.
   * Useful for the CLI status command.
   *
   * @param plugins - Array of plugin descriptors containing their id and
   *   required credential definitions.
   * @returns Per-plugin breakdown of which credentials are configured vs
   *   missing.
   */
  getCredentialStatus(
    plugins: Array<{ id: string; requiredCredentials: CredentialRequirement[] }>,
  ): CredentialStatusEntry[] {
    return plugins.map(({ id, requiredCredentials }) => {
      const credentials = this.getPluginCredentials(id);

      const configured: string[] = [];
      const missing: string[] = [];

      for (const { key } of requiredCredentials) {
        const value = credentials[key];
        if (value !== undefined && value !== "") {
          configured.push(key);
        } else {
          missing.push(key);
        }
      }

      return { pluginId: id, configured, missing };
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Application-wide credential manager instance. */
export const credentialManager = new CredentialManager();

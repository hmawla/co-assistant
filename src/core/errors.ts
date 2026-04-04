/**
 * @module core/errors
 * @description Custom error classes and error handling utilities for the
 * Co-Assistant application. Provides a hierarchy of typed errors with
 * machine-readable codes, optional context, and static factory methods
 * for common failure scenarios.
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * Base error class for all Co-Assistant errors.
 *
 * Every error carries a machine-readable `code` (e.g. `"CONFIG_MISSING_ENV"`)
 * and an optional `context` bag of structured data that aids debugging.
 */
export class CoAssistantError extends Error {
  /** Machine-readable error code. */
  readonly code: string;

  /** Optional structured context for debugging. */
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;

    // Ensure the prototype chain is correct for instanceof checks after
    // transpilation to ES5/ES2015 targets.
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture a clean stack trace (V8 / Node.js specific).
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ---------------------------------------------------------------------------
// ConfigError
// ---------------------------------------------------------------------------

/**
 * Errors related to application configuration — missing environment variables,
 * invalid values, or missing config files.
 */
export class ConfigError extends CoAssistantError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
  }

  /** A required environment variable is not set. */
  static missingEnvVar(varName: string): ConfigError {
    return new ConfigError(
      `Missing required environment variable: ${varName}`,
      'CONFIG_MISSING_ENV',
      { varName },
    );
  }

  /** A configuration value failed validation. */
  static invalidValue(key: string, reason: string): ConfigError {
    return new ConfigError(
      `Invalid configuration value for "${key}": ${reason}`,
      'CONFIG_INVALID_VALUE',
      { key, reason },
    );
  }

  /** The configuration file could not be found on disk. */
  static fileNotFound(path: string): ConfigError {
    return new ConfigError(
      `Configuration file not found: ${path}`,
      'CONFIG_FILE_NOT_FOUND',
      { path },
    );
  }
}

// ---------------------------------------------------------------------------
// PluginError
// ---------------------------------------------------------------------------

/**
 * Errors originating from the plugin subsystem — initialisation failures,
 * tool execution errors, missing credentials, health-check failures, etc.
 */
export class PluginError extends CoAssistantError {
  /** Identifier of the plugin that produced this error. */
  readonly pluginId: string;

  constructor(
    message: string,
    code: string,
    pluginId: string,
    context?: Record<string, unknown>,
  ) {
    super(message, code, { ...context, pluginId });
    this.pluginId = pluginId;
  }

  /** Plugin initialisation failed. */
  static initFailed(pluginId: string, reason: string): PluginError {
    return new PluginError(
      `Plugin "${pluginId}" failed to initialise: ${reason}`,
      'PLUGIN_INIT_FAILED',
      pluginId,
      { reason },
    );
  }

  /** A tool exposed by the plugin failed during execution. */
  static toolFailed(pluginId: string, toolName: string, reason: string): PluginError {
    return new PluginError(
      `Plugin "${pluginId}" tool "${toolName}" failed: ${reason}`,
      'PLUGIN_TOOL_FAILED',
      pluginId,
      { toolName, reason },
    );
  }

  /** Required credentials for the plugin are missing. */
  static credentialsMissing(pluginId: string, keys: string[]): PluginError {
    return new PluginError(
      `Plugin "${pluginId}" is missing required credentials: ${keys.join(', ')}`,
      'PLUGIN_CREDENTIALS_MISSING',
      pluginId,
      { keys },
    );
  }

  /** Plugin health check did not pass. */
  static healthCheckFailed(pluginId: string, reason: string): PluginError {
    return new PluginError(
      `Plugin "${pluginId}" health check failed: ${reason}`,
      'PLUGIN_HEALTH_CHECK_FAILED',
      pluginId,
      { reason },
    );
  }

  /** Plugin is disabled and cannot be used. */
  static disabled(pluginId: string, reason: string): PluginError {
    return new PluginError(
      `Plugin "${pluginId}" is disabled: ${reason}`,
      'PLUGIN_DISABLED',
      pluginId,
      { reason },
    );
  }
}

// ---------------------------------------------------------------------------
// AIError
// ---------------------------------------------------------------------------

/**
 * Errors related to AI / LLM interactions — client start-up, session
 * creation, model resolution, and message sending.
 */
export class AIError extends CoAssistantError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
  }

  /** The AI client failed to start. */
  static clientStartFailed(reason: string): AIError {
    return new AIError(
      `AI client failed to start: ${reason}`,
      'AI_CLIENT_START_FAILED',
      { reason },
    );
  }

  /** A new AI session could not be created. */
  static sessionCreateFailed(reason: string): AIError {
    return new AIError(
      `Failed to create AI session: ${reason}`,
      'AI_SESSION_CREATE_FAILED',
      { reason },
    );
  }

  /** The requested model was not found or is unavailable. */
  static modelNotFound(model: string): AIError {
    return new AIError(
      `AI model not found: ${model}`,
      'AI_MODEL_NOT_FOUND',
      { model },
    );
  }

  /** Sending a message to the AI failed. */
  static sendFailed(reason: string): AIError {
    return new AIError(
      `Failed to send message to AI: ${reason}`,
      'AI_SEND_FAILED',
      { reason },
    );
  }
}

// ---------------------------------------------------------------------------
// BotError
// ---------------------------------------------------------------------------

/**
 * Errors related to the Telegram bot — authorisation, message delivery,
 * and command handling.
 */
export class BotError extends CoAssistantError {
  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message, code, context);
  }

  /** The user is not authorised to interact with the bot. */
  static unauthorized(userId: number): BotError {
    return new BotError(
      `Unauthorized user: ${userId}`,
      'BOT_UNAUTHORIZED',
      { userId },
    );
  }

  /** The bot failed to send a message. */
  static sendFailed(reason: string): BotError {
    return new BotError(
      `Bot failed to send message: ${reason}`,
      'BOT_SEND_FAILED',
      { reason },
    );
  }

  /** A bot command could not be executed. */
  static commandFailed(command: string, reason: string): BotError {
    return new BotError(
      `Bot command "/${command}" failed: ${reason}`,
      'BOT_COMMAND_FAILED',
      { command, reason },
    );
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Type-guard that checks whether an unknown value is a {@link CoAssistantError}.
 */
export function isCoAssistantError(error: unknown): error is CoAssistantError {
  return error instanceof CoAssistantError;
}

/**
 * Safely format any thrown value into a human-readable string.
 *
 * For {@link CoAssistantError} instances the output includes the error code
 * and any attached context.  Non-Error values are coerced via `String()`.
 */
export function formatError(error: unknown): string {
  if (isCoAssistantError(error)) {
    let msg = `[${error.code}] ${error.message}`;
    if (error.context && Object.keys(error.context).length > 0) {
      msg += ` | context: ${JSON.stringify(error.context)}`;
    }
    return msg;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

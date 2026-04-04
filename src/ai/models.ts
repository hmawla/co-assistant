/**
 * @module ai/models
 * @description AI model registry, selection, and switching logic.
 *
 * Responsible for:
 * - Maintaining a list of known/supported AI models
 * - Resolving the currently active model (preferences → env default)
 * - Persisting model selection to the preferences store
 * - Allowing runtime registration of custom models (BYOK)
 */

import type { Logger } from "pino";
import { createChildLogger } from "../core/logger.js";
import { getConfig } from "../core/config.js";
import type { PreferencesRepository } from "../storage/repositories/preferences.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Descriptor for a single AI model known to the registry.
 */
export interface ModelInfo {
  /** Model identifier (e.g., "gpt-4.1") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Brief description */
  description: string;
  /** Provider (e.g., "openai", "anthropic", "github") */
  provider: string;
}

// ---------------------------------------------------------------------------
// Default model catalogue
// ---------------------------------------------------------------------------

/** Built-in models shipped with the application. */
const DEFAULT_MODELS: ModelInfo[] = [
  // OpenAI — Premium (3x)
  { id: "gpt-5", name: "GPT-5", description: "OpenAI GPT-5 (premium, 3x)", provider: "openai" },
  { id: "o3", name: "o3", description: "OpenAI o3 reasoning (premium, 3x)", provider: "openai" },
  // OpenAI — Standard (1x)
  { id: "gpt-4.1", name: "GPT-4.1", description: "OpenAI GPT-4.1 (1x)", provider: "openai" },
  { id: "gpt-4o", name: "GPT-4o", description: "OpenAI GPT-4o multimodal (1x)", provider: "openai" },
  { id: "o4-mini", name: "o4 Mini", description: "OpenAI o4-mini reasoning (1x)", provider: "openai" },
  // OpenAI — Low (0.33x)
  { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "OpenAI GPT-4o Mini (0.33x)", provider: "openai" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", description: "OpenAI GPT-4.1 Mini (0.33x)", provider: "openai" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", description: "OpenAI GPT-5 Mini (0.33x)", provider: "openai" },
  { id: "o3-mini", name: "o3 Mini", description: "OpenAI o3-mini reasoning (0.33x)", provider: "openai" },
  // OpenAI — Nano (0x)
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", description: "OpenAI GPT-4.1 Nano (0x)", provider: "openai" },
  // Anthropic — Premium (3x)
  { id: "claude-opus-4", name: "Claude Opus 4", description: "Anthropic Claude Opus 4 (premium, 3x)", provider: "anthropic" },
  // Anthropic — Standard (1x)
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", description: "Anthropic Claude Sonnet 4 (1x)", provider: "anthropic" },
  // Anthropic — Low (0.33x)
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", description: "Anthropic Claude Haiku 4.5 (0.33x)", provider: "anthropic" },
];

/** Preferences key used to persist the selected model. */
const PREF_KEY = "current_model";

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

/**
 * Central registry of available AI models with preference-backed selection.
 *
 * The registry is initialised with a set of built-in models and can be
 * extended at runtime via {@link addModel}. The currently active model is
 * resolved from the user's persisted preference, falling back to the
 * `DEFAULT_MODEL` environment variable when no preference exists.
 */
export class ModelRegistry {
  private models: ModelInfo[];
  private preferences: PreferencesRepository;
  private logger: Logger;

  /**
   * @param preferences - Repository used to persist the selected model.
   */
  constructor(preferences: PreferencesRepository) {
    this.models = [...DEFAULT_MODELS];
    this.preferences = preferences;
    this.logger = createChildLogger("ai:models");
    this.logger.debug({ count: this.models.length }, "Model registry initialised");
  }

  /**
   * Return every model currently registered (built-in + custom).
   *
   * @returns A shallow copy of the model list.
   */
  getAvailableModels(): ModelInfo[] {
    return [...this.models];
  }

  /**
   * Look up a single model by its identifier.
   *
   * @param modelId - Case-sensitive model identifier.
   * @returns The matching {@link ModelInfo}, or `undefined` when not found.
   */
  getModel(modelId: string): ModelInfo | undefined {
    return this.models.find((m) => m.id === modelId);
  }

  /**
   * Resolve the currently active model identifier.
   *
   * Resolution order:
   * 1. Persisted preference (`current_model` key)
   * 2. `DEFAULT_MODEL` from the environment configuration
   *
   * @returns The model identifier string.
   */
  getCurrentModelId(): string {
    const persisted = this.preferences.get(PREF_KEY);
    if (persisted) {
      this.logger.debug({ modelId: persisted }, "Current model resolved from preferences");
      return persisted;
    }

    try {
      const defaultModel = getConfig().env.DEFAULT_MODEL;
      this.logger.debug({ modelId: defaultModel }, "Current model resolved from env default");
      return defaultModel;
    } catch {
      // Env config may not be available (e.g. CLI without .env) — use hardcoded default
      const fallback = "gpt-4.1";
      this.logger.debug({ modelId: fallback }, "Current model resolved from hardcoded fallback");
      return fallback;
    }
  }

  /**
   * Select a model as the active model and persist the choice.
   *
   * Unknown model IDs are **allowed** (the Copilot SDK may support models
   * not present in our registry) but a warning is logged so operators can
   * spot potential typos.
   *
   * @param modelId - The identifier of the model to activate.
   */
  setCurrentModel(modelId: string): void {
    if (!this.isValidModel(modelId)) {
      this.logger.warn(
        { modelId },
        "Setting model that is not in the registry — it may still be valid for the provider",
      );
    }

    this.preferences.set(PREF_KEY, modelId);
    this.logger.info({ modelId }, "Current model updated");
  }

  /**
   * Check whether a model identifier corresponds to a registered model.
   *
   * @param modelId - The identifier to validate.
   * @returns `true` when the model exists in the registry.
   */
  isValidModel(modelId: string): boolean {
    return this.models.some((m) => m.id === modelId);
  }

  /**
   * Register a custom model at runtime (e.g. for BYOK scenarios).
   *
   * If a model with the same `id` already exists it will be replaced.
   *
   * @param model - The {@link ModelInfo} to add.
   */
  addModel(model: ModelInfo): void {
    const idx = this.models.findIndex((m) => m.id === model.id);
    if (idx !== -1) {
      this.models[idx] = model;
      this.logger.info({ modelId: model.id }, "Existing model replaced in registry");
    } else {
      this.models.push(model);
      this.logger.info({ modelId: model.id }, "Custom model added to registry");
    }
  }

  /**
   * Remove a model from the registry.
   *
   * @param modelId - The identifier of the model to remove.
   * @returns `true` if the model was found and removed, `false` otherwise.
   */
  removeModel(modelId: string): boolean {
    const idx = this.models.findIndex((m) => m.id === modelId);
    if (idx === -1) {
      this.logger.warn({ modelId }, "Attempted to remove unknown model");
      return false;
    }

    this.models.splice(idx, 1);
    this.logger.info({ modelId }, "Model removed from registry");
    return true;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link ModelRegistry} instance wired to the given preferences
 * repository.
 *
 * @param preferences - Repository used to persist model selection.
 * @returns A ready-to-use `ModelRegistry`.
 */
export function createModelRegistry(preferences: PreferencesRepository): ModelRegistry {
  return new ModelRegistry(preferences);
}

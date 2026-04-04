/**
 * @module bot/middleware/logging
 * @description Request logging middleware for Telegram bot interactions.
 *
 * Logs every incoming Telegram update with structured metadata including
 * update type, user ID, a short message preview, and wall-clock processing
 * time. Uses a pino child logger scoped to `"bot:middleware:logging"`.
 */

import type { Context, MiddlewareFn } from "telegraf";
import { createChildLogger } from "../../core/logger.js";

const logger = createChildLogger("bot:middleware:logging");

/**
 * Create Telegraf middleware that logs every incoming update.
 *
 * For each update the middleware records:
 * - `updateType` — the Telegram update type (e.g. `"message"`, `"callback_query"`)
 * - `updateId`   — the numeric update ID
 * - `userId`     — the sender's Telegram user ID (if available)
 * - `preview`    — the first 50 characters of the text payload (if any)
 * - `durationMs` — wall-clock processing time of downstream middleware
 *
 * @returns A Telegraf middleware function.
 */
export function createLoggingMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const start = Date.now();
    const updateId = ctx.update.update_id;
    const updateType = ctx.updateType;
    const userId = ctx.from?.id;

    // Extract a short text preview from the update when available.
    const rawText =
      (ctx.message && "text" in ctx.message ? ctx.message.text : undefined) ??
      (ctx.callbackQuery && "data" in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : undefined);
    const preview = rawText ? rawText.slice(0, 50) : undefined;

    logger.debug(
      { updateId, updateType, userId, preview },
      "Incoming update",
    );

    await next();

    const durationMs = Date.now() - start;
    logger.debug(
      { updateId, updateType, userId, durationMs },
      "Update processed",
    );
  };
}

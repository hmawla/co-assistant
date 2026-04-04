/**
 * @module bot/middleware/auth
 * @description Authentication middleware to restrict bot access to authorized users.
 *
 * Compares the sender's Telegram user ID (`ctx.from.id`) against a single
 * allowed ID. Unauthorized updates are silently dropped — no reply is sent
 * to the user, but the attempt is logged at `warn` level so it can be
 * audited.
 */

import type { Context, MiddlewareFn } from "telegraf";
import { createChildLogger } from "../../core/logger.js";

const logger = createChildLogger("bot:auth");

/**
 * Create Telegraf middleware that restricts access to a single authorized user.
 *
 * If the incoming update has no `ctx.from` (rare, but possible for channel
 * posts) or the user ID does not match `allowedUserId`, the update is
 * silently ignored — `next()` is never called.
 *
 * @param allowedUserId - The Telegram user ID that is permitted to interact
 *   with the bot.
 * @returns A Telegraf middleware function.
 */
export function createAuthMiddleware(
  allowedUserId: number,
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const senderId = ctx.from?.id;

    if (senderId === undefined) {
      logger.warn(
        { updateId: ctx.update.update_id },
        "Update has no sender — dropping",
      );
      return;
    }

    if (senderId !== allowedUserId) {
      const username = ctx.from?.username;
      logger.warn(
        { senderId, username, allowedUserId, updateId: ctx.update.update_id },
        "Unauthorized access attempt — dropping update",
      );
      return;
    }

    await next();
  };
}

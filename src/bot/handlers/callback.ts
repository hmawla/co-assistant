/**
 * @module bot/handlers/callback
 * @description Callback query handler for inline keyboard interactions.
 *
 * Handles callback queries triggered by inline-keyboard buttons. Currently
 * acknowledges every callback so Telegram removes the "loading" spinner.
 * Future plugin UIs can extend this with data-based routing.
 */

import type { Context } from "telegraf";
import { createChildLogger } from "../../core/logger.js";

const logger = createChildLogger("bot:handlers");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the callback query handler.
 *
 * For now the handler simply acknowledges every incoming callback query via
 * `ctx.answerCbQuery()` so Telegram stops showing the loading indicator.
 * The callback data is logged for future routing purposes.
 *
 * @returns An async handler suitable for `bot.on("callback_query", handler)`.
 */
export function createCallbackHandler() {
  return async (ctx: Context): Promise<void> => {
    const data =
      ctx.callbackQuery && "data" in ctx.callbackQuery
        ? ctx.callbackQuery.data
        : undefined;

    logger.debug({ data }, "Received callback query");

    await ctx.answerCbQuery();
  };
}

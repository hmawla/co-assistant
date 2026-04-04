/**
 * @module bot/handlers/message
 * @description Message handler for processing incoming Telegram text messages.
 *
 * Receives user text from the bot layer, forwards it to the AI session,
 * persists both sides of the conversation, and replies via Telegram.
 * Long responses are automatically split to respect Telegram's 4 096-char limit.
 */

import type { Context } from "telegraf";
import type { SessionManager } from "../../ai/session.js";
import type { ConversationRepository } from "../../storage/repositories/conversation.js";
import { createChildLogger } from "../../core/logger.js";

const logger = createChildLogger("bot:handlers");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the message handler factory. */
export interface MessageHandlerDeps {
  /** AI session manager used to send prompts. */
  sessionManager: SessionManager;
  /** Repository for persisting conversation messages. */
  conversationRepo: ConversationRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a message into chunks that fit within Telegram's per-message limit.
 *
 * The function first attempts to split on paragraph boundaries (`\n\n`).
 * If a single paragraph exceeds `maxLength` it falls back to splitting on
 * newline boundaries, and finally to a hard character cut.
 *
 * @param text      - The text to split.
 * @param maxLength - Maximum characters per chunk (default `4096`).
 * @returns An array of non-empty string chunks.
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split on a paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLength);

    // Fall back to a single newline
    if (splitIdx <= 0) {
      splitIdx = remaining.lastIndexOf("\n", maxLength);
    }

    // Hard split as last resort
    if (splitIdx <= 0) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }

  return chunks.filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the message handler function wired to the provided dependencies.
 *
 * The returned handler follows this flow:
 * 1. Send a "typing" indicator so the user knows the bot is working.
 * 2. If all AI sessions are busy, notify the user their message is queued.
 * 3. Persist the user message in conversation history.
 * 4. Forward the prompt to the AI via `sessionManager.sendMessage` — this
 *    acquires a session from the pool so multiple messages process in parallel.
 * 5. Persist the assistant response.
 * 6. Reply **to the user's original message** (splitting long responses as
 *    needed), so each answer threads back to the question that triggered it.
 *
 * @param deps - Injected dependencies ({@link MessageHandlerDeps}).
 * @returns An async handler compatible with `TelegramBot.onMessage`.
 */
export function createMessageHandler(deps: MessageHandlerDeps) {
  const { sessionManager, conversationRepo } = deps;

  return async (ctx: Context, text: string): Promise<void> => {
    // The message ID we'll thread our reply to
    const replyToId = ctx.message?.message_id;
    const replyOpts = replyToId
      ? { reply_parameters: { message_id: replyToId } } as Record<string, unknown>
      : {};

    // 1. Typing indicator
    await ctx.sendChatAction("typing");

    // 2. If all pool sessions are busy, let the user know they're queued
    if (sessionManager.getAvailableCount() === 0) {
      await ctx.reply("⏳ All AI sessions busy — your message is queued.", replyOpts);
    }

    // 3. Store the user message
    conversationRepo.addMessage("user", text);
    logger.debug({ textLength: text.length }, "User message stored");

    // 4. Ensure the AI session pool is active
    if (!sessionManager.isActive()) {
      logger.error("No active AI session — cannot process message");
      await ctx.reply("⚠️ AI session is not active. Please restart the bot.", replyOpts);
      return;
    }

    // Keep sending "typing" while waiting for a session and during AI processing
    const typingInterval = setInterval(() => {
      ctx.sendChatAction("typing").catch(() => {});
    }, 4000);

    // 5. Send to AI — acquires a session from the pool (blocks if all busy)
    try {
      const response = await sessionManager.sendMessage(text);

      if (!response) {
        logger.warn("AI returned an empty response");
        await ctx.reply("The AI returned an empty response. Please try again.", replyOpts);
        return;
      }

      // 6. Persist assistant response
      const model = sessionManager.getCurrentModel();
      conversationRepo.addMessage("assistant", response, model);
      logger.debug(
        { responseLength: response.length, model },
        "Assistant response stored",
      );

      // 7. Reply to the user's specific message — split if necessary
      const chunks = splitMessage(response);
      for (const chunk of chunks) {
        await ctx.reply(chunk, replyOpts);
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Failed to process message through AI");
      await ctx.reply("Sorry, I couldn't process that. Please try again.", replyOpts);
    } finally {
      clearInterval(typingInterval);
    }
  };
}

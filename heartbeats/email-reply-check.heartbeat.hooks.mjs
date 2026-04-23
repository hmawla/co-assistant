/**
 * Hooks for the email-reply-check heartbeat.
 *
 * preAgentCall  — fetches the last 10 inbox threads via the Gmail plugin,
 *                 filters out threads whose last email ID is already in
 *                 processedIds, and threads where the last message was sent
 *                 by the owner; returns the filtered list or null (abort).
 * buildPrompt   — injects the filtered thread list into {{THREADS_TO_PROCESS}}.
 * postAgentCall — marks the last email ID of each processed thread in state;
 *                 strips optional JSON block from the response.
 */

const MY_EMAIL = "you@email.com";

/**
 * Step 1: Pre-fetch inbox threads and filter to only those needing a reply.
 * @param {object} state   - { processedIds: string[], lastRun: string|null }
 *                           processedIds holds last-email IDs (not thread IDs)
 * @param {object} context - { callTool: (pluginId, toolName, args) => Promise, logger }
 */
export async function preAgentCall(state, context) {
  const { callTool, logger } = context;
  const result = await callTool("gmail", "search_threads", {
    query: "in:inbox",
    maxThreads: 10,
  });

  // callTool returns a string on API error
  if (typeof result === "string") {
    logger.warn({ error: result }, "gmail search_threads failed");
    return null;
  }

  const processedSet = new Set(state.processedIds);

  const threadsToProcess = result.threads
    .filter((thread) => {
      const lastMsg = thread.messages[thread.messages.length - 1];
      if (processedSet.has(lastMsg.id)) return false;
      return !lastMsg.from.toLowerCase().includes(MY_EMAIL);
    })
    .map((thread) => {
      const lastMsg = thread.messages[thread.messages.length - 1];
      return {
        threadId: thread.threadId,
        lastEmailId: lastMsg.id,
        subject: thread.subject,
        messageIds: thread.messages.map((m) => m.id),
      };
    });

  if (threadsToProcess.length === 0) {
    logger.debug("No threads need attention — aborting pipeline");
    return null;
  }

  logger.debug({ count: threadsToProcess.length }, "Threads to process");

  return { processedIds: state.processedIds, threadsToProcess };
}

/**
 * Step 2: Inject the filtered thread list into the prompt.
 */
export async function buildPrompt(preData, basePrompt) {
  const list = preData.threadsToProcess
    .map(
      (t) =>
        `- threadId: ${t.threadId}\n  subject: ${t.subject}\n  messageIds: [${t.messageIds.join(", ")}]`,
    )
    .join("\n");
  return basePrompt.replace("{{THREADS_TO_PROCESS}}", list);
}

/**
 * Step 3: Mark all threads that were processed in state; clean response.
 * Uses preData.threadsToProcess (not agent output) for reliable dedup.
 */
export async function postAgentCall(preData, agentResponse) {
  const newIds = preData.threadsToProcess.map((t) => t.lastEmailId);
  const merged = [...new Set([...preData.processedIds, ...newIds])];
  const newState = { processedIds: merged, lastRun: new Date().toISOString() };

  // Strip optional JSON block the agent may output (kept in prompt for safety)
  const clean = agentResponse.replace(/```json[\s\S]*?```/g, "").trim();
  return { newState, response: clean || null };
}

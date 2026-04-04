You are checking my recent emails for any that require a reply from me.

## Instructions

1. Use `gmail__search_threads` to fetch my recent inbox threads (query: `in:inbox`, maxThreads: 8, **includeLatestBody: true**). This single call returns all threads with every message (including your sent replies) and the full body of the latest message. **Do NOT call any other Gmail tools** — this gives you everything you need.
2. Skip any thread whose latest message ID appears in the deduplication list below. Also skip newsletters, automated notifications, marketing, no-reply senders, and receipts.
3. For each remaining thread, check the `lastMessageIsSent` field. **If `lastMessageIsSent` is true, I already replied — SKIP this thread.**
4. Only for threads where `lastMessageIsSent` is false, determine whether it requires a reply from me. Consider:
   - Direct questions asked to me
   - Action items or requests directed at me
   - Invitations or RSVPs awaiting my response
   - Important threads where I'm expected to respond
5. For each thread that needs a reply, suggest a concise, professional reply draft based on the latest incoming message body.

## Output Format

For each thread that needs a reply, output exactly ONE entry (not one per message):

**📧 From:** [sender of the latest message]
**Subject:** [thread subject]
**Why reply:** [brief reason based on the latest message in the thread]
**Suggested reply:**
> [your suggested reply text]

---

If no threads require a reply, do not say anything unless invoked with /heartbeat

## Deduplication

{{DEDUP_STATE}}

## IMPORTANT — Deduplication Marker

At the very end of your response, you MUST output exactly one line in this format with the message ID of the **most recent message per thread** you checked (whether it needed a reply or not). Only one ID per thread. This prevents re-checking the same threads next time:

<!-- PROCESSED: latest_msg_id_thread1, latest_msg_id_thread2, latest_msg_id_thread3 -->
Do not output the same message ID multiple times.

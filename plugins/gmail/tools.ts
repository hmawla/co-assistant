/**
 * @module gmail/tools
 * @description Gmail AI tool definitions for searching, reading, and sending emails.
 *
 * Each tool calls the Gmail REST API directly using `fetch` and the access
 * token obtained via {@link GmailAuth}. Tool handlers never throw — they
 * return user-friendly error messages so the AI model can report failures
 * gracefully.
 */

import { z } from "zod";
import type { Logger } from "pino";
import type { ToolDefinition } from "../../src/plugins/types.js";
import type { GmailAuth } from "./auth.js";

/** Base URL for the Gmail v1 REST API. */
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an `Authorization` header using a fresh access token.
 */
async function authHeaders(auth: GmailAuth): Promise<Record<string, string>> {
  const token = await auth.getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Decode a base64url-encoded string (as returned by the Gmail API) to UTF-8.
 *
 * Gmail encodes message bodies using the URL-safe base64 variant defined in
 * RFC 4648 §5 — i.e. `+` → `-` and `/` → `_`, with no padding.
 */
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Encode a UTF-8 string to base64url (for sending raw RFC 2822 messages).
 */
function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Extract a header value from a Gmail message resource.
 */
function getHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Extract the plain-text body from a Gmail message payload.
 *
 * Gmail messages may be simple (body on the payload itself) or multipart.
 * This function walks the MIME tree looking for `text/plain`, falling back
 * to `text/html` when no plain-text part exists.
 */
function extractBody(payload: Record<string, unknown>): string {
  // Simple (non-multipart) message — body is directly on the payload.
  const body = payload.body as { data?: string; size?: number } | undefined;
  if (body?.data) {
    return decodeBase64Url(body.data);
  }

  // Multipart — walk parts looking for text/plain, then text/html.
  const parts = (payload.parts ?? []) as Array<Record<string, unknown>>;
  let htmlFallback = "";

  for (const part of parts) {
    const mimeType = part.mimeType as string | undefined;
    const partBody = part.body as { data?: string } | undefined;

    if (mimeType === "text/plain" && partBody?.data) {
      return decodeBase64Url(partBody.data);
    }
    if (mimeType === "text/html" && partBody?.data) {
      htmlFallback = decodeBase64Url(partBody.data);
    }

    // Recurse into nested multipart parts.
    if (part.parts) {
      const nested = extractBody(part as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  return htmlFallback || "(no body)";
}

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

/**
 * Create the Gmail tool definitions.
 *
 * @param auth   - A configured {@link GmailAuth} instance for token management.
 * @param logger - Plugin-scoped logger.
 * @returns An array of {@link ToolDefinition} objects for the plugin manager.
 */
export function createGmailTools(auth: GmailAuth, logger: Logger): ToolDefinition[] {
  // -----------------------------------------------------------------------
  // search_emails
  // -----------------------------------------------------------------------
  const searchEmails: ToolDefinition = {
    name: "search_emails",
    description:
      "Search for emails in Gmail using a query string (same syntax as the Gmail search bar)",
    parameters: z.object({
      /** Gmail search query (e.g. "from:alice subject:meeting"). */
      query: z.string().describe("Gmail search query"),
      /** Maximum number of results to return (default 10, max 50). */
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Maximum number of results to return"),
    }),

    handler: async (args) => {
      try {
        const query = args.query as string;
        const maxResults = (args.maxResults as number | undefined) ?? 10;
        logger.debug({ query, maxResults }, "search_emails called");

        // Step 1 — List message IDs matching the query.
        const params = new URLSearchParams({
          q: query,
          maxResults: String(maxResults),
        });
        const listRes = await fetch(`${GMAIL_API}/messages?${params}`, {
          headers: await authHeaders(auth),
        });

        if (!listRes.ok) {
          const errText = await listRes.text();
          logger.error({ status: listRes.status, errText }, "Gmail search failed");
          return `Error searching emails (${listRes.status}): ${errText}`;
        }

        const listData = (await listRes.json()) as {
          messages?: Array<{ id: string; threadId: string }>;
          resultSizeEstimate?: number;
        };

        if (!listData.messages?.length) {
          return "No emails found matching that query.";
        }

        // Step 2 — Fetch each message's metadata (Subject, From, Date, snippet).
        const headers = await authHeaders(auth);
        const results = await Promise.all(
          listData.messages.map(async (msg) => {
            const msgRes = await fetch(
              `${GMAIL_API}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { headers },
            );

            if (!msgRes.ok) {
              return { id: msg.id, error: `Failed to fetch (${msgRes.status})` };
            }

            const msgData = (await msgRes.json()) as {
              id: string;
              snippet: string;
              payload: { headers: Array<{ name: string; value: string }> };
            };

            return {
              id: msgData.id,
              subject: getHeader(msgData.payload.headers, "Subject"),
              from: getHeader(msgData.payload.headers, "From"),
              date: getHeader(msgData.payload.headers, "Date"),
              snippet: msgData.snippet,
            };
          }),
        );

        return {
          resultCount: results.length,
          estimatedTotal: listData.resultSizeEstimate ?? results.length,
          messages: results,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, "search_emails error");
        return `Error searching emails: ${message}`;
      }
    },
  };

  // -----------------------------------------------------------------------
  // read_email
  // -----------------------------------------------------------------------
  const readEmail: ToolDefinition = {
    name: "read_email",
    description: "Read the full content of a specific email by its message ID",
    parameters: z.object({
      /** The Gmail message ID (returned by search_emails). */
      messageId: z.string().describe("Gmail message ID"),
    }),

    handler: async (args) => {
      try {
        const messageId = args.messageId as string;
        logger.debug({ messageId }, "read_email called");

        // Fetch the full message in "full" format to get decoded body parts.
        const res = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, {
          headers: await authHeaders(auth),
        });

        if (!res.ok) {
          const errText = await res.text();
          logger.error({ status: res.status, errText }, "Gmail read failed");
          return `Error reading email (${res.status}): ${errText}`;
        }

        const data = (await res.json()) as {
          id: string;
          threadId: string;
          labelIds: string[];
          snippet: string;
          payload: {
            headers: Array<{ name: string; value: string }>;
            body?: { data?: string };
            parts?: Array<Record<string, unknown>>;
            mimeType?: string;
          };
        };

        const hdrs = data.payload.headers;
        const body = extractBody(data.payload as Record<string, unknown>);

        return {
          id: data.id,
          threadId: data.threadId,
          labels: data.labelIds,
          subject: getHeader(hdrs, "Subject"),
          from: getHeader(hdrs, "From"),
          to: getHeader(hdrs, "To"),
          date: getHeader(hdrs, "Date"),
          body,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, "read_email error");
        return `Error reading email: ${message}`;
      }
    },
  };

  // -----------------------------------------------------------------------
  // send_email
  // -----------------------------------------------------------------------
  const sendEmail: ToolDefinition = {
    name: "send_email",
    description: "Send an email via Gmail",
    parameters: z.object({
      /** Recipient email address. */
      to: z.string().email().describe("Recipient email address"),
      /** Email subject line. */
      subject: z.string().describe("Email subject"),
      /** Plain-text email body. */
      body: z.string().describe("Email body (plain text)"),
    }),

    handler: async (args) => {
      try {
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        logger.debug({ to, subject }, "send_email called");

        // Build an RFC 2822 message and encode it as base64url.
        const rfc2822 = [
          `To: ${to}`,
          `Subject: ${subject}`,
          "Content-Type: text/plain; charset=UTF-8",
          "MIME-Version: 1.0",
          "",
          body,
        ].join("\r\n");

        const raw = encodeBase64Url(rfc2822);

        // POST the raw message to the Gmail send endpoint.
        const res = await fetch(`${GMAIL_API}/messages/send`, {
          method: "POST",
          headers: {
            ...(await authHeaders(auth)),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw }),
        });

        if (!res.ok) {
          const errText = await res.text();
          logger.error({ status: res.status, errText }, "Gmail send failed");
          return `Error sending email (${res.status}): ${errText}`;
        }

        const data = (await res.json()) as { id: string; threadId: string };
        logger.info({ id: data.id, to }, "Email sent successfully");

        return {
          success: true,
          messageId: data.id,
          threadId: data.threadId,
          message: `Email sent successfully to ${to}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, "send_email error");
        return `Error sending email: ${message}`;
      }
    },
  };

  return [searchEmails, readEmail, sendEmail];
}

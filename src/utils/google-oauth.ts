/**
 * @module utils/google-oauth
 * @description Handles the Google OAuth2 authorization code flow using a local HTTP server.
 *
 * Spins up a temporary HTTP server on localhost (random available port), opens
 * the user's browser to Google's consent page, captures the authorization code
 * callback, exchanges it for tokens, then shuts down the server.
 *
 * This replaces the manual "go to OAuth Playground and paste a refresh token"
 * flow with a seamless one-click experience.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google's OAuth2 authorization endpoint (consent screen). */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's OAuth2 token exchange endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Maximum time (ms) to wait for the user to complete the authorization. */
const TIMEOUT_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Per-plugin scopes
// ---------------------------------------------------------------------------

/**
 * OAuth2 scopes required by each Google-based plugin.
 *
 * Keys correspond to plugin IDs.
 */
export const GOOGLE_PLUGIN_SCOPES: Record<string, string[]> = {
  gmail: ["https://mail.google.com/"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar"],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a successful OAuth authorization code flow. */
export interface GoogleOAuthResult {
  /** Long-lived offline refresh token — stored in config.json. */
  refreshToken: string;
  /** Short-lived access token (informational; plugins refresh on their own). */
  accessToken: string;
}

// ---------------------------------------------------------------------------
// HTML responses shown in the user's browser
// ---------------------------------------------------------------------------

/** Success page displayed after a successful authorization. */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorization Successful</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display: flex; justify-content: center; align-items: center;
         height: 100vh; margin: 0; background: #f8f9fa; }
  .card { background: #fff; padding: 2.5rem 3rem; border-radius: 12px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
  h1 { color: #1a73e8; font-size: 1.5rem; }
  p  { color: #5f6368; line-height: 1.6; }
</style></head>
<body><div class="card">
  <h1>✅ Authorization Successful</h1>
  <p>Your Google account has been linked.<br>You can close this tab and return to the terminal.</p>
</div></body></html>`;

/**
 * Build an error page for the browser.
 *
 * @param message - Human-readable error detail.
 */
function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorization Failed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         display: flex; justify-content: center; align-items: center;
         height: 100vh; margin: 0; background: #f8f9fa; }
  .card { background: #fff; padding: 2.5rem 3rem; border-radius: 12px;
          box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; max-width: 420px; }
  h1 { color: #d93025; font-size: 1.5rem; }
  p  { color: #5f6368; line-height: 1.6; }
</style></head>
<body><div class="card">
  <h1>❌ Authorization Failed</h1>
  <p>${message}</p>
  <p>Please check your terminal for details.</p>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Core OAuth flow
// ---------------------------------------------------------------------------

/**
 * Run the full Google OAuth2 authorization code flow using a local HTTP server.
 *
 * **Flow:**
 * 1. Start a temporary HTTP server on `127.0.0.1` with a random available port.
 * 2. Construct the Google consent URL with the given scopes and `access_type=offline`.
 * 3. Open the user's default browser (or print the URL for manual copy).
 * 4. Wait for Google to redirect back to `http://127.0.0.1:<port>` with the auth code.
 * 5. Exchange the authorization code for access + refresh tokens.
 * 6. Shut down the server and return the tokens.
 *
 * **Important:** This requires "Desktop app" (installed) type OAuth credentials
 * from Google Cloud Console, which automatically allow localhost redirects on
 * any port.
 *
 * @param clientId     - Google OAuth2 Client ID.
 * @param clientSecret - Google OAuth2 Client Secret.
 * @param scopes       - OAuth2 scopes to request (e.g. `["https://mail.google.com/"]`).
 * @returns The obtained refresh and access tokens.
 * @throws {Error} If the flow times out, the user denies access, or token exchange fails.
 */
export function performGoogleOAuthFlow(
  clientId: string,
  clientSecret: string,
  scopes: string[],
): Promise<GoogleOAuthResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** Port captured once the server starts listening — avoids null `server.address()` after close. */
    let listenPort = 0;

    // ── Request handler ──────────────────────────────────────────────────
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Ignore requests after the flow has already completed (e.g. favicon)
      if (settled) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }

      const redirectUri = `http://127.0.0.1:${listenPort}`;
      const reqUrl = new URL(req.url || "/", redirectUri);

      // Google passes an error param when the user denies consent
      const error = reqUrl.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml(`Google returned an error: <strong>${error}</strong>`));
        settle(new Error(`Google OAuth error: ${error}`));
        return;
      }

      const code = reqUrl.searchParams.get("code");
      if (!code) {
        // Ignore requests without a code (e.g. favicon, other probes)
        res.writeHead(404);
        res.end();
        return;
      }

      // ── Exchange authorization code for tokens ───────────────────────
      try {
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
        }

        const data = (await tokenRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        };

        if (!data.refresh_token) {
          throw new Error(
            "No refresh token received. Try revoking app access at " +
            "https://myaccount.google.com/permissions and re-running setup.",
          );
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        settle(null, { refreshToken: data.refresh_token, accessToken: data.access_token });
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml("Token exchange failed. Check your terminal."));
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // ── Settle helper (resolves/rejects exactly once) ──────────────────
    function settle(err: Error | null, result?: GoogleOAuthResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(result!);
    }

    // ── Timeout safety net ─────────────────────────────────────────────
    const timer = setTimeout(() => {
      settle(new Error("OAuth authorization timed out after 2 minutes. Please try again."));
    }, TIMEOUT_MS);

    // ── Start the local callback server ────────────────────────────────
    // Port 0 lets the OS pick a random available port
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      listenPort = addr.port;
      const redirectUri = `http://127.0.0.1:${listenPort}`;

      const authUrl = new URL(GOOGLE_AUTH_URL);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes.join(" "));
      authUrl.searchParams.set("access_type", "offline");
      // "consent" forces Google to return a refresh token every time
      authUrl.searchParams.set("prompt", "consent");

      const fullUrl = authUrl.toString();

      console.log("\n  🌐 Opening browser for Google authorization...");
      console.log("  If the browser doesn't open automatically, visit this URL:\n");
      console.log(`  ${fullUrl}\n`);
      console.log("  ⏳ Waiting for authorization (timeout: 2 minutes)...\n");

      openBrowser(fullUrl);
    });

    server.on("error", (err) => {
      settle(new Error(`Failed to start local OAuth server: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Browser launcher
// ---------------------------------------------------------------------------

/**
 * Attempt to open a URL in the user's default browser.
 *
 * Fails silently — the URL is already printed to the console as a fallback.
 *
 * @param url - The URL to open.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";

  exec(`${cmd} "${url}"`, () => {
    // Silently ignore errors — the user can copy the URL from the terminal
  });
}

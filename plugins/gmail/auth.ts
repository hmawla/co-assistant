/**
 * @module gmail/auth
 * @description Google OAuth2 helper for the Gmail plugin.
 *
 * Manages access-token acquisition using an offline refresh token.
 * Uses the built-in `fetch` API (Node 18+) — no external HTTP library required.
 */

/** Google's OAuth2 token endpoint used to exchange a refresh token for an access token. */
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Manages Google OAuth2 tokens for Gmail API access.
 *
 * Holds the long-lived refresh token and transparently obtains short-lived
 * access tokens, caching them until they expire.
 */
export class GmailAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  /** Cached access token from the most recent refresh. */
  private accessToken: string | null = null;

  /** Epoch-millisecond timestamp at which {@link accessToken} expires. */
  private tokenExpiresAt = 0;

  /**
   * @param clientId     - Google OAuth2 Client ID.
   * @param clientSecret - Google OAuth2 Client Secret.
   * @param refreshToken - Long-lived Google OAuth2 Refresh Token.
   */
  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  /**
   * Returns `true` when all three required credentials are non-empty strings.
   */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  /**
   * Obtain a valid access token, refreshing automatically when necessary.
   *
   * The token is cached in memory and reused until 60 seconds before its
   * stated expiry to account for clock skew and network latency.
   *
   * @returns A valid Google OAuth2 access token.
   * @throws {Error} If the token refresh request fails.
   */
  async getAccessToken(): Promise<string> {
    // Return the cached token if it is still valid (with a 60-second buffer).
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to refresh Google access token (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }
}

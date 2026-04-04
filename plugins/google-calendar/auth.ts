/**
 * @module google-calendar/auth
 * @description Google Calendar OAuth2 authentication handler.
 *
 * Manages access-token refresh via the Google OAuth2 token endpoint.
 * Tokens are cached in memory and automatically refreshed when they
 * expire (with a 60-second safety margin).
 */

/** Google OAuth2 token endpoint. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Safety margin (ms) subtracted from `expires_in` to avoid edge-case expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Lightweight Google OAuth2 helper that handles the refresh-token flow.
 *
 * @example
 * ```ts
 * const auth = new CalendarAuth(clientId, clientSecret, refreshToken);
 * const token = await auth.getAccessToken();
 * ```
 */
export class CalendarAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(clientId: string, clientSecret: string, refreshToken: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
  }

  /**
   * Check whether all required credentials have been provided.
   */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  /**
   * Return a valid access token, refreshing it first if necessary.
   *
   * @throws {Error} If credentials are missing or the token exchange fails.
   */
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "CalendarAuth is not configured — client ID, client secret, and refresh token are all required.",
      );
    }

    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to refresh Google access token (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_MARGIN_MS;

    return this.accessToken;
  }
}

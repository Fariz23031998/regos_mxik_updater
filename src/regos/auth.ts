import type { EnvConfig } from "../types.js";
import { errorMessage } from "../utils.js";

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export class RegosAuth {
  private token: TokenState | null = null;

  constructor(private readonly env: EnvConfig) {}

  get useOAuth(): boolean {
    return this.env.useOAuth;
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.env.useOAuth) {
      return null;
    }
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    if (!this.env.clientId || !this.env.clientSecret) {
      throw new Error("OAuth client credentials are not configured for this local integration token.");
    }

    const url = `${this.env.authUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.env.clientId,
      client_secret: this.env.clientSecret,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Regos OAuth token request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error(`Regos OAuth response has no access_token: ${JSON.stringify(data)}`);
    }

    const expiresIn = Number(data.expires_in ?? 3600);
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return this.token.accessToken;
  }

  forget(): void {
    this.token = null;
  }

  static describeError(error: unknown): string {
    return errorMessage(error);
  }
}

import type { EnvConfig } from "../types.js";
import { errorMessage } from "../utils.js";
import { RegosAuth } from "./auth.js";

export class RegosApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string | number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RegosApiError";
  }
}

export interface RegosResponse<T> {
  ok: boolean;
  result: T;
  next_offset?: number | null;
  total?: number | null;
}

interface ErrorResult {
  error?: string | number;
  description?: string;
}

export class RegosClient {
  constructor(
    private readonly env: EnvConfig,
    private readonly auth: RegosAuth,
    private readonly timeoutMs: number,
  ) {}

  async post<T>(endpoint: string, body: unknown): Promise<RegosResponse<T>> {
    try {
      return await this.request<T>(endpoint, body, false);
    } catch (error) {
      if (this.auth.useOAuth && error instanceof RegosApiError && error.status === 401) {
        this.auth.forget();
        return this.request<T>(endpoint, body, true);
      }
      throw error;
    }
  }

  private async request<T>(endpoint: string, body: unknown, isRetry: boolean): Promise<RegosResponse<T>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json;charset=utf-8",
    };
    const accessToken = await this.auth.getAccessToken();
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const url = `${this.env.apiBase}/${this.env.integrationToken}/v1/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });

      if (this.auth.useOAuth && response.status === 401 && !isRetry) {
        throw new RegosApiError("Regos authorization expired", 401, 401, true);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new RegosApiError(
          `Regos API returned HTTP ${response.status}: ${text.slice(0, 500)}`,
          response.status,
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }

      const data = (await response.json()) as RegosResponse<T | ErrorResult>;
      if (!data.ok) {
        const err = (data.result ?? {}) as ErrorResult;
        const code = err.error ?? "Unknown";
        const description = err.description ?? "Unknown error";
        const retryable = Number(code) === 429 || String(description).toLowerCase().includes("timeout");
        throw new RegosApiError(`Regos API error: ${code} - ${description}`, 200, code, retryable);
      }

      return data as RegosResponse<T>;
    } catch (error) {
      if (error instanceof RegosApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RegosApiError(`Regos API request timed out after ${this.timeoutMs}ms`, undefined, "timeout", true);
      }
      throw new RegosApiError(`Regos API request failed: ${errorMessage(error)}`, undefined, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

import { setTimeout as delay } from "node:timers/promises";

export async function sleep(ms: number): Promise<void> {
  if (ms > 0) {
    await delay(ms);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;
    delayMs: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retry = options.shouldRetry ? options.shouldRetry(error) : true;
      if (!retry || attempt === options.retries) {
        throw error;
      }
      options.onRetry?.(error, attempt);
      await sleep(options.delayMs * attempt);
    }
  }
  throw lastError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim() === "";
}

export function asNonEmptyString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text;
}

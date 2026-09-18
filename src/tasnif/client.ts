import type { TasnifMatch } from "../types.js";
import { asNonEmptyString, errorMessage, sleep } from "../utils.js";

const TASNIF_BASE = "https://tasnif.soliq.uz/api/cls-api";

export class TasnifApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TasnifApiError";
  }
}

interface TasnifItem {
  mxikCode?: string | number;
  mxikName?: string;
  name?: string;
  nameRu?: string;
  nameUz?: string;
  brandName?: string;
  attributeName?: string;
  label?: string | number | boolean;
  gtin?: string | number;
  internationalCode?: string | number;
  [key: string]: unknown;
}

interface TasnifParamsResponse {
  success?: boolean;
  code?: number;
  data?: {
    content?: TasnifItem[];
  } | TasnifItem[] | TasnifItem;
  content?: TasnifItem[];
}

function parseLabeled(item: TasnifItem): boolean {
  const candidates = [item.label, item.labeled, item.mark, item.marked, item.isMarked, item.is_labeled];
  for (const value of candidates) {
    if (value === true || value === 1 || value === "1") return true;
    if (typeof value === "string" && value.trim().toLowerCase() === "true") return true;
  }
  return false;
}

function itemName(item: TasnifItem): string | null {
  return (
    asNonEmptyString(item.mxikName) ??
    asNonEmptyString(item.name) ??
    asNonEmptyString(item.nameRu) ??
    asNonEmptyString(item.nameUz) ??
    asNonEmptyString(item.brandName)
  );
}

function toMatch(item: TasnifItem, barcode: string | null): TasnifMatch | null {
  const mxikCode = asNonEmptyString(item.mxikCode);
  if (!mxikCode) return null;
  return {
    mxikCode,
    isLabeled: parseLabeled(item),
    name: itemName(item),
    barcode: barcode ?? asNonEmptyString(item.internationalCode) ?? asNonEmptyString(item.gtin),
  };
}

function extractItems(payload: TasnifParamsResponse): TasnifItem[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === "object" && "content" in payload.data) {
    return Array.isArray(payload.data.content) ? payload.data.content : [];
  }
  if (Array.isArray(payload.content)) return payload.content;
  if (payload.data && typeof payload.data === "object" && "mxikCode" in payload.data) {
    return [payload.data as TasnifItem];
  }
  return [];
}

export class TasnifClient {
  constructor(
    private readonly timeoutMs: number,
    private readonly delayMs: number,
  ) {}

  async lookupByBarcode(gtin: string): Promise<TasnifMatch | null> {
    const payload = await this.get("/mxik/search/by-params", { gtin, size: "20", page: "0", lang: "ru" });
    const items = extractItems(payload);
    for (const item of items) {
      const match = toMatch(item, gtin);
      if (match) return match;
    }
    return null;
  }

  async lookupByMxik(mxikCode: string): Promise<TasnifMatch | null> {
    const payload = await this.get("/mxik/search/by-params", {
      mxikCode,
      size: "20",
      page: "0",
      lang: "ru",
    });
    const items = extractItems(payload);
    for (const item of items) {
      const match = toMatch(item, null);
      if (match) return match;
    }
    return null;
  }

  async lookupProduct(gtins: string[], existingMxik: string | null): Promise<TasnifMatch | null> {
    for (const gtin of gtins) {
      const match = await this.lookupByBarcode(gtin);
      if (match) return match;
    }

    if (existingMxik) {
      return this.lookupByMxik(existingMxik);
    }

    return null;
  }

  private async get(path: string, query: Record<string, string>): Promise<TasnifParamsResponse> {
    const url = new URL(`${TASNIF_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "regos-mxik-updater/1.0",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TasnifApiError(`Tasnif HTTP ${response.status}`, response.status >= 500 || response.status === 429);
      }

      const payload = (await response.json()) as TasnifParamsResponse;
      // Tasnif uses success=false / code=-1 for "no match" on a barcode or MXIK.
      // Treat that as an empty result so remaining barcodes can still be tried.
      if (payload.success === false) {
        return { success: false, code: payload.code, data: { content: [] } };
      }
      return payload;
    } catch (error) {
      if (error instanceof TasnifApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TasnifApiError(`Tasnif request timed out after ${this.timeoutMs}ms`, true);
      }
      throw new TasnifApiError(`Tasnif request failed: ${errorMessage(error)}`, true);
    } finally {
      clearTimeout(timer);
      await sleep(this.delayMs);
    }
  }
}

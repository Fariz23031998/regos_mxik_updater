import type { ProductRow } from "../types.js";

const GTIN_RE = /^\d{8,14}$/;

export function extractGtins(product: Pick<ProductRow, "base_barcode" | "barcode_list">): string[] {
  const raw = [product.base_barcode, product.barcode_list].filter(Boolean).join(" ");
  const tokens = raw.split(/[\s,;|]+/g).map((token) => token.trim()).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const token of tokens) {
    const digits = token.replace(/\D/g, "");
    if (!GTIN_RE.test(digits) || seen.has(digits)) continue;
    seen.add(digits);
    result.push(digits);
  }

  return result;
}

export function isMxikCode(value: string | null | undefined): boolean {
  if (!value) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 15;
}

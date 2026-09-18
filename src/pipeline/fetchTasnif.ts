import type { Logger } from "../logger.js";
import type { ProductRepository } from "../db/products.js";
import type { ProductRow, Settings } from "../types.js";
import { TasnifApiError, TasnifClient } from "../tasnif/client.js";
import { extractGtins } from "../tasnif/barcodes.js";
import { errorMessage, isBlank, withRetry } from "../utils.js";

function shouldSkipWithoutTasnif(product: ProductRow, settings: Settings): boolean {
  const hasIcps = !isBlank(product.icps);
  const needsMxik =
    settings.mxikUpdateMode === "all" || (settings.mxikUpdateMode === "empty_only" && !hasIcps);
  return !needsMxik && !settings.updateIsLabeled;
}

function nextStatusAfterTasnif(product: ProductRow, settings: Settings, found: boolean): "ready" | "skipped" | "not_found" {
  if (!found) return "not_found";
  const hasIcps = !isBlank(product.icps);
  const needsMxik = settings.mxikUpdateMode === "all" || (settings.mxikUpdateMode === "empty_only" && !hasIcps);
  const needsLabel = settings.updateIsLabeled;
  if (!needsMxik && !needsLabel) return "skipped";
  return "ready";
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  async function run(): Promise<void> {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      if (current === undefined) continue;
      await worker(current);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => run());
  await Promise.all(workers);
}

export async function fetchTasnifData(options: {
  tasnif: TasnifClient;
  repo: ProductRepository;
  logger: Logger;
  settings: Settings;
  shouldStop: () => boolean;
  groupIds?: number[];
}): Promise<void> {
  const { tasnif, repo, logger, settings, shouldStop, groupIds } = options;
  logger.info("Looking up MXIK and marking status in Tasnif...");

  while (!shouldStop()) {
    // Only process pending. tasnif_failed stays failed until --retry-failed.
    const pending = repo.getByStatus("pending", 100, groupIds);
    if (pending.length === 0) break;

    await mapWithConcurrency(pending, settings.tasnifConcurrency, async (product) => {
      if (shouldStop()) return;

      if (settings.skipDeleted && product.deleted_mark) {
        repo.markStatus([product.id], "skipped", "Deleted product");
        return;
      }

      if (settings.skipServices && (product.type ?? "").toLowerCase() === "service") {
        repo.markStatus([product.id], "skipped", "Service item");
        return;
      }

      if (shouldSkipWithoutTasnif(product, settings)) {
        repo.markStatus([product.id], "skipped", "Nothing to update for current settings");
        return;
      }

      const gtins = extractGtins(product);
      try {
        const match = await withRetry(() => tasnif.lookupProduct(gtins, product.icps), {
          retries: settings.maxRetries,
          delayMs: settings.tasnifDelayMs || 250,
          shouldRetry: (error) => error instanceof TasnifApiError && error.retryable,
          onRetry: (error, attempt) => {
            logger.warn(`Retrying Tasnif lookup for product ${product.id} (attempt ${attempt}): ${errorMessage(error)}`);
          },
        });

        const status = nextStatusAfterTasnif(product, settings, Boolean(match));
        repo.saveTasnifResult(
          product.id,
          match,
          status,
          match ? null : "No MXIK found in Tasnif for product barcodes / existing ICPS",
        );
        logger.info(
          `Tasnif product ${product.id} (${product.name ?? "unnamed"}): ${status}` +
            (match ? ` mxik=${match.mxikCode} labeled=${match.isLabeled}` : ""),
        );
      } catch (error) {
        repo.saveTasnifResult(product.id, null, "tasnif_failed", errorMessage(error));
        logger.error(`Tasnif lookup failed for product ${product.id}: ${errorMessage(error)}`);
      }
    });
  }

  logger.info("Finished Tasnif lookups.");
}

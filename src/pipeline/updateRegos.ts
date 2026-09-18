import type { Logger } from "../logger.js";
import type { ProductRepository } from "../db/products.js";
import type { ItemEditPayload, RegosItemsApi } from "../regos/items.js";
import type { ProductRow, Settings } from "../types.js";
import { isBlank, errorMessage, withRetry } from "../utils.js";
import { RegosApiError } from "../regos/client.js";

export function buildEditPayload(product: ProductRow, settings: Settings): ItemEditPayload | null {
  if (!product.tasnif_mxik && settings.updateIsLabeled && product.tasnif_is_labeled === null) {
    return null;
  }

  const payload: ItemEditPayload = { id: product.id };
  const hasIcps = !isBlank(product.icps);
  const shouldUpdateIcps =
    Boolean(product.tasnif_mxik) &&
    (settings.mxikUpdateMode === "all" || (settings.mxikUpdateMode === "empty_only" && !hasIcps));

  if (shouldUpdateIcps && product.tasnif_mxik) {
    payload.icps = product.tasnif_mxik;
  }

  if (settings.updateIsLabeled && product.tasnif_is_labeled !== null) {
    payload.is_labeled = product.tasnif_is_labeled === 1;
  }

  const icpsUnchanged = payload.icps === undefined || payload.icps === (product.icps ?? "");
  const labeledUnchanged =
    payload.is_labeled === undefined || payload.is_labeled === (product.is_labeled === 1);
  if (icpsUnchanged && labeledUnchanged) {
    return null;
  }

  return payload;
}

export async function updateProductsInRegos(options: {
  itemsApi: RegosItemsApi;
  repo: ProductRepository;
  logger: Logger;
  settings: Settings;
  shouldStop: () => boolean;
  groupIds?: number[];
}): Promise<void> {
  const { itemsApi, repo, logger, settings, shouldStop, groupIds } = options;
  logger.info("Updating products in Regos from SQLite...");

  while (!shouldStop()) {
    const ready = repo.getByStatus("ready", settings.regosBatchSize, groupIds);
    if (ready.length === 0) break;

    const payloads: ItemEditPayload[] = [];
    for (const product of ready) {
      const payload = buildEditPayload(product, settings);
      if (!payload) {
        repo.markStatus([product.id], "skipped", "Nothing to update for current settings");
        continue;
      }
      payloads.push(payload);
    }

    if (payloads.length === 0) continue;

    try {
      const results = await withRetry(
        () => itemsApi.editBatch(payloads, settings.regosDelayMs),
        {
          retries: settings.maxRetries,
          delayMs: Math.max(500, settings.regosDelayMs),
          shouldRetry: (error) => error instanceof RegosApiError && error.retryable,
          onRetry: (error, attempt) => {
            logger.warn(`Retrying Regos batch update (attempt ${attempt}): ${errorMessage(error)}`);
          },
        },
      );

      const succeeded: number[] = [];
      for (const result of results) {
        if (result.ok) {
          succeeded.push(result.id);
        } else {
          repo.markStatus([result.id], "failed", result.error ?? "Regos Item/Edit failed");
          logger.error(`Regos update failed for product ${result.id}: ${result.error}`);
        }
      }

      if (succeeded.length > 0) {
        repo.markUpdated(succeeded);
        logger.info(`Updated ${succeeded.length} product(s) in Regos: ${succeeded.join(", ")}`);
      }
    } catch (error) {
      // Leave rows as ready so the next run retries them. Stop this pass to avoid a tight retry loop.
      logger.error(`Regos batch request failed; products remain ready for resume: ${errorMessage(error)}`);
      break;
    }
  }

  logger.info("Finished updating products in Regos.");
}

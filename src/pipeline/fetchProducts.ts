import type { Logger } from "../logger.js";
import type { ProductRepository } from "../db/products.js";
import type { RegosItemsApi } from "../regos/items.js";

export async function fetchProductsFromRegos(options: {
  itemsApi: RegosItemsApi;
  repo: ProductRepository;
  logger: Logger;
  pageSize: number;
  delayMs: number;
  groupIds?: number[];
}): Promise<number> {
  const { itemsApi, repo, logger, pageSize, delayMs, groupIds } = options;
  let total = 0;
  let inserted = 0;
  let updated = 0;

  if (groupIds && groupIds.length > 0) {
    logger.info(`Fetching products from Regos for group tree (${groupIds.length} group id(s))...`);
  } else {
    logger.info("Fetching products from Regos...");
  }

  for await (const batch of itemsApi.fetchAllPages({ pageSize, delayMs, groupIds })) {
    const result = repo.upsertFromRegos(batch);

    inserted += result.inserted;
    updated += result.updated;
    total += batch.length;
    logger.info(`Fetched ${batch.length} products (running total ${total}; new ${inserted}, refreshed ${updated})`);
  }

  repo.setMeta("last_fetch_at", new Date().toISOString());
  logger.info(`Finished fetching products from Regos. Total in this run: ${total}`);
  return total;
}

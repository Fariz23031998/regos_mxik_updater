import type { Logger } from "../logger.js";
import type { AppConfig, RegosItem } from "../types.js";
import { errorMessage, withRetry } from "../utils.js";
import { RegosApiError } from "../regos/client.js";
import type { ItemEditPayload, RegosItemsApi } from "../regos/items.js";

function shouldSkipItem(item: RegosItem, settings: AppConfig["settings"]): string | null {
  if (settings.skipDeleted && item.deleted_mark) return "Deleted product";
  if (settings.skipServices && (item.type ?? "").toLowerCase() === "service") return "Service item";
  return null;
}

export async function bulkEditItems(options: {
  itemsApi: RegosItemsApi;
  logger: Logger;
  config: AppConfig;
  groupIds?: number[];
  shouldStop: () => boolean;
  name: string;
  startMessage: string;
  retryMessage: string;
  successMessage: (ids: number[]) => string;
  failMessage: (id: number, error?: string) => string;
  buildPayload: (item: RegosItem) => ItemEditPayload | "same" | null;
}): Promise<void> {
  const { itemsApi, logger, config, groupIds, shouldStop, name } = options;
  const settings = config.settings;

  if (groupIds && groupIds.length > 0) {
    logger.info(`${options.startMessage} for group tree (${groupIds.length} group id(s))...`);
  } else {
    logger.info(`${options.startMessage} for all groups...`);
  }

  let scanned = 0;
  let skippedSame = 0;
  let skippedFilter = 0;
  let updated = 0;
  let failed = 0;
  let pending: ItemEditPayload[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const payloads = pending;
    pending = [];

    const results = await withRetry(
      () => itemsApi.editBatch(payloads, settings.regosDelayMs),
      {
        retries: settings.maxRetries,
        delayMs: Math.max(500, settings.regosDelayMs),
        shouldRetry: (error) => error instanceof RegosApiError && error.retryable,
        onRetry: (error, attempt) => {
          logger.warn(`${options.retryMessage} (attempt ${attempt}): ${errorMessage(error)}`);
        },
      },
    );

    const succeeded: number[] = [];
    for (const result of results) {
      if (result.ok) {
        succeeded.push(result.id);
        updated += 1;
      } else {
        failed += 1;
        logger.error(options.failMessage(result.id, result.error));
      }
    }
    if (succeeded.length > 0) {
      logger.info(options.successMessage(succeeded));
    }
  };

  try {
    for await (const batch of itemsApi.fetchAllPages({
      pageSize: settings.pageSize,
      delayMs: settings.regosDelayMs,
      groupIds,
    })) {
      if (shouldStop()) break;

      for (const item of batch) {
        scanned += 1;
        const skipReason = shouldSkipItem(item, settings);
        if (skipReason) {
          skippedFilter += 1;
          continue;
        }
        if (groupIds && groupIds.length > 0) {
          const itemGroupId = item.group?.id ?? null;
          if (itemGroupId === null || !groupIds.includes(itemGroupId)) {
            skippedFilter += 1;
            continue;
          }
        }
        const payload = options.buildPayload(item);
        if (payload === null) {
          skippedFilter += 1;
          continue;
        }
        if (payload === "same") {
          skippedSame += 1;
          continue;
        }
        pending.push(payload);
        if (pending.length >= settings.regosBatchSize) {
          await flush();
          if (shouldStop()) break;
        }
      }
      if (shouldStop()) break;
    }

    if (!shouldStop()) {
      await flush();
    } else if (pending.length > 0) {
      logger.warn(`Stop requested; ${pending.length} product(s) were not sent in the last ${name} batch.`);
    }
  } catch (error) {
    logger.error(`${name} update stopped: ${errorMessage(error)}`);
    throw error;
  }

  logger.info(
    `Finished ${name} update. scanned=${scanned} updated=${updated} skipped_same=${skippedSame} ` +
      `skipped_filter=${skippedFilter} failed=${failed}`,
  );
}

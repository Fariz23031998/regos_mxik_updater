import type { Logger } from "../logger.js";
import type { AppConfig } from "../types.js";
import type { RegosItemsApi } from "../regos/items.js";
import { bulkEditItems } from "./bulkEdit.js";

function currentIcps(item: { icps?: string | number | null }): string {
  return item.icps === null || item.icps === undefined ? "" : String(item.icps);
}

export async function updateIcpsInRegos(options: {
  itemsApi: RegosItemsApi;
  logger: Logger;
  config: AppConfig;
  icps: string;
  groupIds?: number[];
  shouldStop: () => boolean;
}): Promise<void> {
  const { itemsApi, logger, config, icps, groupIds, shouldStop } = options;

  await bulkEditItems({
    itemsApi,
    logger,
    config,
    groupIds,
    shouldStop,
    name: "ИКПУ",
    startMessage: `Updating ИКПУ to ${icps}`,
    retryMessage: "Retrying ИКПУ batch update",
    successMessage: (ids) => `Set ИКПУ ${icps} on ${ids.length} product(s): ${ids.join(", ")}`,
    failMessage: (id, error) => `ИКПУ update failed for product ${id}: ${error}`,
    buildPayload: (item) => {
      if (currentIcps(item) === icps) return "same";
      return { id: item.id, icps };
    },
  });
}

export async function updateIsLabeledInRegos(options: {
  itemsApi: RegosItemsApi;
  logger: Logger;
  config: AppConfig;
  isLabeled: boolean;
  groupIds?: number[];
  shouldStop: () => boolean;
}): Promise<void> {
  const { itemsApi, logger, config, isLabeled, groupIds, shouldStop } = options;
  const label = isLabeled ? "true" : "false";

  await bulkEditItems({
    itemsApi,
    logger,
    config,
    groupIds,
    shouldStop,
    name: "is_labeled",
    startMessage: `Updating is_labeled to ${label}`,
    retryMessage: "Retrying is_labeled batch update",
    successMessage: (ids) => `Set is_labeled=${label} on ${ids.length} product(s): ${ids.join(", ")}`,
    failMessage: (id, error) => `is_labeled update failed for product ${id}: ${error}`,
    buildPayload: (item) => {
      if (item.is_labeled === isLabeled) return "same";
      return { id: item.id, is_labeled: isLabeled };
    },
  });
}

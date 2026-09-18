import type { Logger } from "../logger.js";
import type { AppConfig, RegosTaxVat } from "../types.js";
import type { RegosItemsApi } from "../regos/items.js";
import { formatVatLabel } from "../regos/vat.js";
import { bulkEditItems } from "./bulkEdit.js";

export async function updateVatInRegos(options: {
  itemsApi: RegosItemsApi;
  logger: Logger;
  config: AppConfig;
  vat: RegosTaxVat;
  groupIds?: number[];
  shouldStop: () => boolean;
}): Promise<void> {
  const { itemsApi, logger, config, vat, groupIds, shouldStop } = options;
  const vatId = vat.id;
  const label = formatVatLabel(vat);

  await bulkEditItems({
    itemsApi,
    logger,
    config,
    groupIds,
    shouldStop,
    name: "VAT",
    startMessage: `Updating VAT to ${label}`,
    retryMessage: "Retrying VAT batch update",
    successMessage: (ids) => `Set VAT ${label} on ${ids.length} product(s): ${ids.join(", ")}`,
    failMessage: (id, error) => `VAT update failed for product ${id}: ${error}`,
    buildPayload: (item) => {
      if (item.vat?.id === vatId) return "same";
      return { id: item.id, vat_id: vatId };
    },
  });
}

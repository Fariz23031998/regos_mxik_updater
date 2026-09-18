import { assertReadyToRun, validateSettings } from "../config.js";
import type { AppConfig } from "../types.js";
import type { Logger } from "../logger.js";
import { ProductRepository } from "../db/products.js";
import { openDatabase } from "../db/database.js";
import { RegosAuth } from "../regos/auth.js";
import { RegosClient } from "../regos/client.js";
import { RegosGroupsApi, resolveGroupIds } from "../regos/groups.js";
import { RegosItemsApi } from "../regos/items.js";
import { TasnifClient } from "../tasnif/client.js";
import { fetchProductsFromRegos } from "./fetchProducts.js";
import { fetchTasnifData } from "./fetchTasnif.js";
import { updateProductsInRegos } from "./updateRegos.js";

export interface RunOptions {
  fetch: boolean;
  tasnif: boolean;
  update: boolean;
}

export async function runPipeline(config: AppConfig, logger: Logger, options: RunOptions): Promise<void> {
  assertReadyToRun(config.env);
  validateSettings(config.settings);
  const db = openDatabase(config.paths.databaseFile);
  const repo = new ProductRepository(db);
  const auth = new RegosAuth(config.env);
  const client = new RegosClient(config.env, auth, config.settings.requestTimeoutMs);
  const itemsApi = new RegosItemsApi(client, config.settings.maxRetries);
  const groupsApi = new RegosGroupsApi(client);
  const tasnif = new TasnifClient(config.settings.requestTimeoutMs, config.settings.tasnifDelayMs);

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    logger.warn("Stop requested. Finishing the current batch, then exiting so the next run can resume.");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    let groupIds: number[] | undefined;
    if (config.settings.groupId) {
      groupIds = await resolveGroupIds(groupsApi, config.settings.groupId, config.settings.includeChildGroups);
      logger.info(
        config.settings.includeChildGroups
          ? `Scoped to Regos group ${config.settings.groupId} including subgroups (${groupIds.length} group id(s))`
          : `Scoped to Regos group ${config.settings.groupId} without subgroups`,
      );
    }

    logger.info(
      `Settings: mxikUpdateMode=${config.settings.mxikUpdateMode}, updateIsLabeled=${config.settings.updateIsLabeled}, ` +
        `groupId=${config.settings.groupId ?? "all"}, ` +
        `includeChildGroups=${config.settings.includeChildGroups}, ` +
        `regosAuth=${config.env.useOAuth ? "oauth" : "local-token"}`,
    );

    if (options.fetch) {
      await fetchProductsFromRegos({
        itemsApi,
        repo,
        logger,
        pageSize: config.settings.pageSize,
        delayMs: config.settings.regosDelayMs,
        groupIds,
      });
      logCounts(repo, logger);
    }

    if (stopping) return;

    if (options.tasnif) {
      await fetchTasnifData({
        tasnif,
        repo,
        logger,
        settings: config.settings,
        shouldStop: () => stopping,
        groupIds,
      });
      logCounts(repo, logger);
    }

    if (stopping) return;

    if (options.update) {
      await updateProductsInRegos({
        itemsApi,
        repo,
        logger,
        settings: config.settings,
        shouldStop: () => stopping,
        groupIds,
      });
      logCounts(repo, logger);
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    db.close();
  }
}

export function logCounts(repo: ProductRepository, logger: Logger): void {
  const counts = repo.countByStatus();
  logger.info(
    `Progress: total=${counts.total} pending=${counts.pending} ready=${counts.ready} ` +
      `updated=${counts.updated} skipped=${counts.skipped} not_found=${counts.not_found} ` +
      `failed=${counts.failed} tasnif_failed=${counts.tasnif_failed}`,
  );
}

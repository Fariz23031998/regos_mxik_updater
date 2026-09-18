import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { assertReadyToRun, loadConfig, parseMxikMode, saveSettingsFile } from "./config.js";
import { Logger } from "./logger.js";
import { openDatabase } from "./db/database.js";
import { ProductRepository } from "./db/products.js";
import { logCounts, runPipeline } from "./pipeline/runner.js";
import { errorMessage } from "./utils.js";
import { RegosAuth } from "./regos/auth.js";
import { RegosClient } from "./regos/client.js";
import { RegosGroupsApi, resolveGroupIds } from "./regos/groups.js";
import { formatVatLabel, RegosVatApi } from "./regos/vat.js";
import { updateVatInRegos } from "./pipeline/updateVat.js";
import { updateIcpsInRegos, updateIsLabeledInRegos } from "./pipeline/updateManual.js";
import { RegosItemsApi } from "./regos/items.js";
import type { AppConfig, MxikUpdateMode, Settings } from "./types.js";

interface CliOptions {
  fetch?: boolean;
  tasnif?: boolean;
  update?: boolean;
  resume?: boolean;
  mode?: string;
  updateLabeled?: string;
  interactive?: boolean;
  retryFailed?: boolean;
  retryNotFound?: boolean;
  resetAll?: boolean;
  group?: string;
}

function parseBoolFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}. Use true or false.`);
}

async function promptSettings(current: Settings): Promise<Partial<Settings>> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log("MXIK update mode:");
    console.log("  1) Update all products");
    console.log("  2) Update only empty MXIK codes");
    console.log("  3) Do not update MXIK (is_labeled only)");
    const modeAnswer = (await rl.question(`Mode [${current.mxikUpdateMode === "all" ? "1" : current.mxikUpdateMode === "none" ? "3" : "2"}]: `)).trim();
    let mxikUpdateMode: MxikUpdateMode = current.mxikUpdateMode;
    if (modeAnswer === "1") mxikUpdateMode = "all";
    if (modeAnswer === "2") mxikUpdateMode = "empty_only";
    if (modeAnswer === "3") mxikUpdateMode = "none";

    const labeledDefault = current.updateIsLabeled ? "y" : "n";
    const labeledAnswer = (await rl.question(`Update is_labeled from Tasnif marking? (y/n) [${labeledDefault}]: `))
      .trim()
      .toLowerCase();
    let updateIsLabeled = current.updateIsLabeled;
    if (["y", "yes"].includes(labeledAnswer)) updateIsLabeled = true;
    if (["n", "no"].includes(labeledAnswer)) updateIsLabeled = false;

    return { mxikUpdateMode, updateIsLabeled };
  } finally {
    rl.close();
  }
}

function resolveSteps(options: CliOptions): { fetch: boolean; tasnif: boolean; update: boolean } {
  const selected = [options.fetch, options.tasnif, options.update].some(Boolean);
  const steps = selected
    ? {
        fetch: Boolean(options.fetch),
        tasnif: Boolean(options.tasnif),
        update: Boolean(options.update),
      }
    : { fetch: true, tasnif: true, update: true };

  // Continue an interrupted full run from SQLite: do not re-download the catalog.
  if (options.resume && steps.fetch && (steps.tasnif || steps.update)) {
    return { ...steps, fetch: false };
  }
  return steps;
}

function parseGroupId(value: string): number {
  const id = Number(value.trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid group id: ${value}. Use a positive integer.`);
  }
  return id;
}

function parseVatId(value: string): number {
  const id = Number(value.trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid VAT id: ${value}. Use a positive integer from TaxVat/Get.`);
  }
  return id;
}

function parseIcps(value: string): string {
  const icps = value.trim();
  if (!icps) {
    throw new Error("ИКПУ (icps) must be a non-empty string.");
  }
  return icps;
}

async function withLiveCatalogUpdate(
  options: { group?: string; stopMessage: string },
  run: (ctx: {
    config: AppConfig;
    logger: Logger;
    client: RegosClient;
    groupIds?: number[];
    shouldStop: () => boolean;
  }) => Promise<void>,
): Promise<void> {
  const overrides: Partial<Settings> = {};
  if (options.group !== undefined) {
    overrides.groupId = parseGroupId(options.group);
  }
  const config = loadConfig(overrides);
  assertReadyToRun(config.env);
  const logger = new Logger(config.paths.logsDir);
  const auth = new RegosAuth(config.env);
  const client = new RegosClient(config.env, auth, config.settings.requestTimeoutMs);

  let groupIds: number[] | undefined;
  if (config.settings.groupId) {
    groupIds = await resolveGroupIds(
      new RegosGroupsApi(client),
      config.settings.groupId,
      config.settings.includeChildGroups,
    );
    logger.info(
      config.settings.includeChildGroups
        ? `Scoped to Regos group ${config.settings.groupId} including subgroups (${groupIds.length} group id(s))`
        : `Scoped to Regos group ${config.settings.groupId} without subgroups`,
    );
  }

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    logger.warn(options.stopMessage);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await run({
      config,
      logger,
      client,
      groupIds,
      shouldStop: () => stopping,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runVatUpdate(options: { vatId: string; group?: string }): Promise<void> {
  const vatId = parseVatId(options.vatId);
  await withLiveCatalogUpdate(
    { group: options.group, stopMessage: "Stop requested. Finishing the current VAT batch, then exiting." },
    async ({ config, logger, client, groupIds, shouldStop }) => {
      const vat = await new RegosVatApi(client).getById(vatId);
      if (!vat) {
        throw new Error(`VAT rate ${vatId} was not found among enabled TaxVat rates.`);
      }
      await updateVatInRegos({
        itemsApi: new RegosItemsApi(client, config.settings.maxRetries),
        logger,
        config,
        vat,
        groupIds,
        shouldStop,
      });
    },
  );
}

async function runIcpsUpdate(options: { icps: string; group?: string }): Promise<void> {
  const icps = parseIcps(options.icps);
  await withLiveCatalogUpdate(
    { group: options.group, stopMessage: "Stop requested. Finishing the current ИКПУ batch, then exiting." },
    async ({ config, logger, client, groupIds, shouldStop }) => {
      await updateIcpsInRegos({
        itemsApi: new RegosItemsApi(client, config.settings.maxRetries),
        logger,
        config,
        icps,
        groupIds,
        shouldStop,
      });
    },
  );
}

async function runLabeledUpdate(options: { labeled: string; group?: string }): Promise<void> {
  const isLabeled = parseBoolFlag(options.labeled);
  await withLiveCatalogUpdate(
    { group: options.group, stopMessage: "Stop requested. Finishing the current is_labeled batch, then exiting." },
    async ({ config, logger, client, groupIds, shouldStop }) => {
      await updateIsLabeledInRegos({
        itemsApi: new RegosItemsApi(client, config.settings.maxRetries),
        logger,
        config,
        isLabeled,
        groupIds,
        shouldStop,
      });
    },
  );
}

async function run(options: CliOptions): Promise<void> {
  const overrides: Partial<Settings> = {};
  if (options.mode) overrides.mxikUpdateMode = parseMxikMode(options.mode);
  if (options.updateLabeled !== undefined) {
    overrides.updateIsLabeled = parseBoolFlag(options.updateLabeled);
  }
  if (options.group !== undefined) {
    overrides.groupId = parseGroupId(options.group);
  }

  const config = loadConfig(overrides);
  const logger = new Logger(config.paths.logsDir);
  const steps = resolveSteps(options);
  if (options.resume && !steps.fetch && (steps.tasnif || steps.update)) {
    logger.info("Resuming unfinished work from SQLite; skipping fetch from Regos.");
  }

  if (options.interactive) {
    const prompted = await promptSettings(config.settings);
    Object.assign(config.settings, prompted);
    saveSettingsFile(config.paths.settingsFile, config.settings);
    logger.info("Saved settings.json");
  }

  const db = openDatabase(config.paths.databaseFile);
  const repo = new ProductRepository(db);

  try {
    let groupIds: number[] | undefined;
    if (config.settings.groupId && (options.retryFailed || options.retryNotFound)) {
      const auth = new RegosAuth(config.env);
      const client = new RegosClient(config.env, auth, config.settings.requestTimeoutMs);
      groupIds = await resolveGroupIds(
        new RegosGroupsApi(client),
        config.settings.groupId,
        config.settings.includeChildGroups,
      );
    }

    if (options.resetAll) {
      const changed = repo.resetAllProgress();
      logger.warn(`Reset progress for ${changed} product(s). They will be processed from Tasnif again.`);
    } else if (options.retryFailed) {
      const changed = repo.resetRetryable(groupIds);
      logger.info(`Queued ${changed} failed product(s) for retry.`);
    }

    if (options.retryNotFound) {
      const ids = repo.getByStatus("not_found", 1_000_000, groupIds).map((row) => row.id);
      repo.markStatus(ids, "pending", null);
      logger.info(`Queued ${ids.length} not_found product(s) for another Tasnif lookup.`);
    }
  } finally {
    db.close();
  }

  await runPipeline(config, logger, steps);
}

const program = new Command();

program
  .name("regos-mxik-updater")
  .description("Update Regos product icps and is_labeled fields from Tasnif")
  .option("--fetch", "Fetch products from Regos into SQLite")
  .option("--tasnif", "Look up MXIK and marking status in Tasnif")
  .option("--update", "Push ready products to Regos")
  .option("--resume", "Continue unfinished Tasnif/Regos work without fetching the catalog again")
  .option("--mode <mode>", "MXIK update mode: all | empty_only | none")
  .option("--update-labeled <bool>", "Update is_labeled from Tasnif: true | false")
  .option("--interactive", "Ask for MXIK mode and is_labeled settings before running")
  .option("--retry-failed", "Retry products that failed Tasnif lookup or Regos update")
  .option("--retry-not-found", "Retry products that were not found in Tasnif")
  .option("--reset-all", "Clear Tasnif data and progress for all products")
  .option("--group <id>", "Limit fetch/Tasnif/Regos update to this Regos item group")
  .action(async (options: CliOptions) => {
    try {
      await run(options);
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show SQLite progress counts")
  .option("--json", "Print machine-readable JSON")
  .action((options: { json?: boolean }) => {
    try {
      const config = loadConfig();
      const db = openDatabase(config.paths.databaseFile);
      try {
        const repo = new ProductRepository(db);
        const counts = repo.countByStatus();
        if (options.json) {
          console.log(
            JSON.stringify({
              settings: config.settings,
              auth: {
                useOAuth: config.env.useOAuth,
                hasToken: Boolean(config.env.integrationToken),
              },
              counts,
            }),
          );
          return;
        }
        const logger = new Logger(config.paths.logsDir);
        logger.info(
          `Settings: mxikUpdateMode=${config.settings.mxikUpdateMode}, updateIsLabeled=${config.settings.updateIsLabeled}`,
        );
        logCounts(repo, logger);
      } finally {
        db.close();
      }
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("groups")
  .description("List or search Regos item groups")
  .option("--json", "Print machine-readable JSON")
  .option("--query <text>", "Search groups by id, name, or path via ItemGroup/Get")
  .action(async (options: { json?: boolean; query?: string }) => {
    try {
      const config = loadConfig();
      assertReadyToRun(config.env);
      const auth = new RegosAuth(config.env);
      const client = new RegosClient(config.env, auth, config.settings.requestTimeoutMs);
      const api = new RegosGroupsApi(client);
      const groups = options.query?.trim() ? await api.search(options.query) : await api.listAll();
      if (options.json) {
        console.log(JSON.stringify({ groups }));
        return;
      }
      for (const group of groups) {
        console.log(`${group.id}\t${group.path || group.name || ""}`);
      }
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("vat-rates")
  .description("List enabled Regos VAT rates")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const config = loadConfig();
      assertReadyToRun(config.env);
      const auth = new RegosAuth(config.env);
      const client = new RegosClient(config.env, auth, config.settings.requestTimeoutMs);
      const rates = await new RegosVatApi(client).listEnabled();
      rates.sort((a, b) => a.id - b.id);
      if (options.json) {
        console.log(JSON.stringify({ rates }));
        return;
      }
      for (const rate of rates) {
        console.log(`${rate.id}\t${formatVatLabel(rate)}`);
      }
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("vat")
  .description("Set VAT rate on products in a group tree or the whole catalog")
  .requiredOption("--vat-id <id>", "Regos TaxVat id to assign")
  .option("--group <id>", "Limit to this Regos item group")
  .action(async (options: { vatId: string; group?: string }) => {
    try {
      const group = options.group ?? (program.opts() as { group?: string }).group;
      await runVatUpdate({ vatId: options.vatId, group });
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("icps")
  .description("Set ИКПУ (icps) on products in a group or the whole catalog")
  .requiredOption("--icps <code>", "ИКПУ / icps value to assign")
  .option("--group <id>", "Limit to this Regos item group")
  .action(async (options: { icps: string; group?: string }) => {
    try {
      const group = options.group ?? (program.opts() as { group?: string }).group;
      await runIcpsUpdate({ icps: options.icps, group });
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("labeled")
  .description("Set is_labeled on products in a group or the whole catalog")
  .requiredOption("--labeled <bool>", "is_labeled value: true | false")
  .option("--group <id>", "Limit to this Regos item group")
  .action(async (options: { labeled: string; group?: string }) => {
    try {
      const group = options.group ?? (program.opts() as { group?: string }).group;
      await runLabeledUpdate({ labeled: options.labeled, group });
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

program
  .command("empty-db")
  .description("Delete all products and progress from the local SQLite database")
  .action(() => {
    try {
      const config = loadConfig();
      const db = openDatabase(config.paths.databaseFile);
      try {
        const repo = new ProductRepository(db);
        const removed = repo.emptyDatabase();
        console.log(`Emptied database. Removed ${removed} product(s).`);
      } finally {
        db.close();
      }
    } catch (error) {
      console.error(errorMessage(error));
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

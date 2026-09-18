import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { AppConfig, EnvConfig, MxikUpdateMode, Settings } from "./types.js";
import { dataRoot, envFilePath, settingsFilePath } from "./paths.js";

const DEFAULT_SETTINGS: Settings = {
  mxikUpdateMode: "empty_only",
  updateIsLabeled: true,
  skipDeleted: true,
  skipServices: true,
  groupId: null,
  includeChildGroups: true,
  pageSize: 1000,
  tasnifDelayMs: 250,
  tasnifConcurrency: 2,
  regosDelayMs: 200,
  regosBatchSize: 20,
  requestTimeoutMs: 30_000,
  maxRetries: 3,
};

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function asGroupId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asMxikMode(value: unknown, fallback: MxikUpdateMode): MxikUpdateMode {
  if (value === "all" || value === "empty_only" || value === "none") return value;
  return fallback;
}

export function parseMxikMode(value: string): MxikUpdateMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all" || normalized === "update-all" || normalized === "update_all") {
    return "all";
  }
  if (
    normalized === "empty_only" ||
    normalized === "empty-only" ||
    normalized === "empty" ||
    normalized === "missing"
  ) {
    return "empty_only";
  }
  if (normalized === "none" || normalized === "skip" || normalized === "off" || normalized === "labeled_only") {
    return "none";
  }
  throw new Error(`Invalid MXIK update mode: ${value}. Use "all", "empty_only", or "none".`);
}

export function validateSettings(settings: Settings): void {
  if (settings.mxikUpdateMode === "none" && !settings.updateIsLabeled) {
    throw new Error("Enable Update is_labeled, or choose an MXIK update mode. Nothing would be written to Regos.");
  }
}

export function loadSettingsFile(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS };
  }

  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Partial<Settings>;
  return {
    mxikUpdateMode: asMxikMode(raw.mxikUpdateMode, DEFAULT_SETTINGS.mxikUpdateMode),
    updateIsLabeled: asBoolean(raw.updateIsLabeled, DEFAULT_SETTINGS.updateIsLabeled),
    skipDeleted: asBoolean(raw.skipDeleted, DEFAULT_SETTINGS.skipDeleted),
    skipServices: asBoolean(raw.skipServices, DEFAULT_SETTINGS.skipServices),
    groupId: asGroupId(raw.groupId),
    includeChildGroups: asBoolean(raw.includeChildGroups, DEFAULT_SETTINGS.includeChildGroups),
    pageSize: asPositiveInt(raw.pageSize, DEFAULT_SETTINGS.pageSize),
    tasnifDelayMs: asNonNegativeInt(raw.tasnifDelayMs, DEFAULT_SETTINGS.tasnifDelayMs),
    tasnifConcurrency: asPositiveInt(raw.tasnifConcurrency, DEFAULT_SETTINGS.tasnifConcurrency),
    regosDelayMs: asNonNegativeInt(raw.regosDelayMs, DEFAULT_SETTINGS.regosDelayMs),
    regosBatchSize: Math.min(50, asPositiveInt(raw.regosBatchSize, DEFAULT_SETTINGS.regosBatchSize)),
    requestTimeoutMs: asPositiveInt(raw.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs),
    maxRetries: asPositiveInt(raw.maxRetries, DEFAULT_SETTINGS.maxRetries),
  };
}

export function saveSettingsFile(settingsPath: string, settings: Settings): void {
  validateSettings(settings);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function loadEnv(): EnvConfig {
  dotenv.config({ path: envFilePath(), override: false });
  const clientId = optionalEnv("REGOS_CLIENT_ID");
  const clientSecret = optionalEnv("REGOS_CLIENT_SECRET");
  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new Error(
      "Set both REGOS_CLIENT_ID and REGOS_CLIENT_SECRET for catalog OAuth, or leave both empty for a local integration token.",
    );
  }

  return {
    integrationToken: optionalEnv("REGOS_INTEGRATION_TOKEN") ?? "",
    clientId,
    clientSecret,
    authUrl: (process.env.REGOS_AUTH_URL?.trim() || "https://auth.regos.uz").replace(/\/+$/, ""),
    apiBase: (process.env.REGOS_API_BASE?.trim() || "https://integration.regos.uz/gateway/out").replace(/\/+$/, ""),
    useOAuth: Boolean(clientId && clientSecret),
  };
}

export function assertReadyToRun(env: EnvConfig): void {
  if (!env.integrationToken) {
    throw new Error("REGOS_INTEGRATION_TOKEN is required. Save it in Connection settings before running.");
  }
}

export function loadConfig(overrides: Partial<Settings> = {}): AppConfig {
  const settingsFile = settingsFilePath();
  const settings = { ...loadSettingsFile(settingsFile), ...overrides };
  const root = dataRoot();

  return {
    env: loadEnv(),
    settings,
    paths: {
      settingsFile,
      databaseFile: path.join(root, "data", "products.db"),
      logsDir: path.join(root, "logs"),
    },
  };
}

export { dataRoot as projectRoot, DEFAULT_SETTINGS };

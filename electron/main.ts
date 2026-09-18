import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { loadSettingsFile, saveSettingsFile } from "../src/config.js";
import { dataRoot, settingsFilePath } from "../src/paths.js";
import { loadSecrets, saveSecrets } from "../src/env-file.js";
import type { Secrets, Settings, StatusCounts } from "../src/types.js";

interface UiState {
  settings: Settings;
  secrets: Secrets;
  counts: StatusCounts;
  running: boolean;
  stopping: boolean;
  hasToken: boolean;
  lastRunArgs: string[] | null;
}

const emptyCounts: StatusCounts = {
  total: 0,
  pending: 0,
  ready: 0,
  skipped: 0,
  not_found: 0,
  updated: 0,
  failed: 0,
  tasnif_failed: 0,
};

let mainWindow: BrowserWindow | null = null;
let child: ChildProcess | null = null;
let stoppingPromise: Promise<void> | null = null;
let lastRunArgs: string[] | null = loadLastRunArgs();

function lastRunFilePath(): string {
  return path.join(dataRoot(), "data", "last-run.json");
}

function loadLastRunArgs(): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastRunFilePath(), "utf8")) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBulkCommand(command: string | undefined): boolean {
  return command === "vat" || command === "icps" || command === "labeled";
}

function rememberMxikRun(args: string[]): void {
  if (isBulkCommand(args[0])) return;
  lastRunArgs = args.filter((arg) => arg !== "--resume");
  fs.mkdirSync(path.dirname(lastRunFilePath()), { recursive: true });
  fs.writeFileSync(lastRunFilePath(), `${JSON.stringify(lastRunArgs)}\n`, "utf8");
}

function send(channel: string, payload?: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function sendRunState(running: boolean, stopping = false): void {
  send("run-state", { running, stopping });
}

function isChildRunning(): boolean {
  return Boolean(child && child.exitCode === null);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.REGOS_INTEGRATION_TOKEN;
  delete env.REGOS_CLIENT_ID;
  delete env.REGOS_CLIENT_SECRET;
  delete env.REGOS_AUTH_URL;
  delete env.REGOS_API_BASE;
  env.ELECTRON_RUN_AS_NODE = "1";
  env.REGOS_DATA_DIR = dataRoot();
  return env;
}

function resourcePath(...parts: string[]): string {
  const fromApp = path.join(app.getAppPath(), ...parts);
  if (fs.existsSync(fromApp)) return fromApp;
  return path.join(dataRoot(), ...parts);
}

function asarUnpackedRoot(): string {
  const appPath = app.getAppPath();
  if (!app.isPackaged) return appPath;
  if (appPath.endsWith(".asar")) {
    return `${appPath}.unpacked`;
  }
  return appPath.replace(`${path.sep}app.asar`, `${path.sep}app.asar.unpacked`);
}

function cliScript(): string {
  const unpacked = path.join(asarUnpackedRoot(), "dist", "src", "index.js");
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(app.getAppPath(), "dist", "src", "index.js");
}

function spawnCli(args: string[]): ChildProcess {
  const env = childEnv();
  const modulesDir = path.join(asarUnpackedRoot(), "node_modules");
  if (fs.existsSync(modulesDir)) {
    env.NODE_PATH = modulesDir;
  }
  return spawn(process.execPath, [cliScript(), ...args], {
    cwd: dataRoot(),
    env,
    windowsHide: true,
  });
}

function runCli(args: string[], onLine?: (line: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnCli(args);

    let stdout = "";
    let stderr = "";
    const handle = (chunk: Buffer, target: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");
      if (target === "stdout") stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line);
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => handle(chunk, "stdout"));
    proc.stderr?.on("data", (chunk: Buffer) => handle(chunk, "stderr"));
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonPayload(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const arrayStart = stdout.indexOf("[");
  const jsonStart = start >= 0 && (arrayStart < 0 || start < arrayStart) ? start : arrayStart;
  if (jsonStart < 0) return null;
  const objectEnd = stdout.lastIndexOf("}");
  const arrayEnd = stdout.lastIndexOf("]");
  const jsonEnd = Math.max(objectEnd, arrayEnd);
  if (jsonEnd < jsonStart) return null;
  return JSON.parse(stdout.slice(jsonStart, jsonEnd + 1));
}

async function readCounts(): Promise<StatusCounts> {
  try {
    const result = await runCli(["status", "--json"]);
    if (result.code !== 0) return emptyCounts;
    const parsed = parseJsonPayload(result.stdout) as { counts?: StatusCounts } | null;
    return parsed?.counts ?? emptyCounts;
  } catch {
    return emptyCounts;
  }
}

async function getState(): Promise<UiState> {
  const settingsPath = settingsFilePath();
  const settings = loadSettingsFile(settingsPath);
  const secrets = loadSecrets();
  return {
    settings,
    secrets,
    counts: await readCounts(),
    running: isChildRunning(),
    stopping: Boolean(stoppingPromise),
    hasToken: Boolean(secrets.integrationToken.trim()),
    lastRunArgs,
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 980,
    minHeight: 740,
    backgroundColor: "#070b16",
    autoHideMenuBar: true,
    title: "Regos ИКПУ",
    webPreferences: {
      preload: resourcePath("electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void mainWindow.loadFile(resourcePath("electron", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function waitForChildExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      proc.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("close", onClose);
  });
}

function forceKill(proc: ChildProcess): void {
  const pid = proc.pid;
  if (process.platform === "win32" && pid) {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  proc.kill("SIGKILL");
}

async function stopChild(): Promise<void> {
  if (stoppingPromise) {
    await stoppingPromise;
    return;
  }

  const proc = child;
  if (!proc || proc.exitCode !== null) {
    child = null;
    return;
  }

  stoppingPromise = (async () => {
    sendRunState(false, true);
    send("log", "Остановка: дожидаюсь окончания текущего пакета...");
    try {
      proc.kill("SIGINT");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }

    const exited = await waitForChildExit(proc, 8_000);
    if (!exited && proc.exitCode === null) {
      send("log", "Процесс не завершился вовремя, принудительная остановка.");
      forceKill(proc);
      await waitForChildExit(proc, 5_000);
    }

    child = null;
    sendRunState(false, false);
  })();

  try {
    await stoppingPromise;
  } finally {
    stoppingPromise = null;
  }
}

ipcMain.handle("get-state", async () => getState());

ipcMain.handle("save-settings", async (_event, settings: Settings) => {
  saveSettingsFile(settingsFilePath(), settings);
  return getState();
});

ipcMain.handle("save-secrets", async (_event, secrets: Secrets) => {
  saveSecrets(secrets);
  return getState();
});

ipcMain.handle("list-groups", async (_event, query?: string) => {
  const args = ["groups", "--json"];
  if (query?.trim()) args.push("--query", query.trim());
  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Не удалось найти группы в Regos.");
  }
  const parsed = parseJsonPayload(result.stdout) as { groups?: unknown } | unknown[] | null;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.groups)) return parsed.groups;
  throw new Error("Не удалось разобрать список групп Regos.");
});

ipcMain.handle("list-vat-rates", async () => {
  const result = await runCli(["vat-rates", "--json"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Не удалось загрузить ставки НДС из Regos.");
  }
  const parsed = parseJsonPayload(result.stdout) as { rates?: unknown } | unknown[] | null;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.rates)) return parsed.rates;
  throw new Error("Не удалось разобрать ставки НДС из Regos.");
});

ipcMain.handle("empty-database", async () => {
  if (isChildRunning()) {
    throw new Error("Остановите текущее обновление, прежде чем очищать базу.");
  }
  const confirmed = await dialog.showMessageBox(mainWindow!, {
    type: "warning",
    buttons: ["Отмена", "Очистить базу"],
    defaultId: 0,
    cancelId: 0,
    title: "Очистить базу",
    message: "Удалить все товары и прогресс из локальной базы SQLite?",
    detail: "Товары в Regos не изменятся. При следующем запуске они загрузятся заново.",
  });
  if (confirmed.response !== 1) {
    return { cancelled: true, ...(await getState()) };
  }
  const result = await runCli(["empty-db"], (line) => send("log", line));
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Не удалось очистить базу.");
  }
  send("log", result.stdout.trim() || "База очищена.");
  return { cancelled: false, ...(await getState()) };
});

function optionValueFromArgs(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function groupIdFromArgs(args: string[]): string | null {
  return optionValueFromArgs(args, "--group");
}

function catalogScopeLabel(groupId: string | null, includeChildGroups: boolean): string {
  if (!groupId) return "весь каталог (все группы)";
  return includeChildGroups ? `группу ${groupId} и её подгруппы` : `только группу ${groupId}`;
}

function startLogLine(command: string | undefined): string {
  if (command === "vat") return "Запущено обновление НДС...";
  if (command === "icps") return "Запущено обновление ИКПУ...";
  if (command === "labeled") return "Запущено обновление is_labeled...";
  return "Запущено обновление...";
}

async function confirmBulkRun(args: string[]): Promise<boolean> {
  const command = args[0];
  if (!isBulkCommand(command)) return true;
  const groupId = groupIdFromArgs(args);
  const includeChildGroups = loadSettingsFile(settingsFilePath()).includeChildGroups;
  const scope = catalogScopeLabel(groupId, includeChildGroups);
  const skipDetail =
    "Товары с этим значением будут пропущены. Удалённые товары и услуги пропускаются, если включены соответствующие параметры. Прогресс поиска Tasnif в SQLite не меняется.";

  const spec =
    command === "vat"
      ? {
          title: "Обновление НДС",
          confirm: "Обновить НДС",
          message: `Назначить ставку НДС ${optionValueFromArgs(args, "--vat-id") ?? "?"} для товаров в ${scope}?`,
        }
      : command === "icps"
        ? {
            title: "Обновление ИКПУ",
            confirm: "Записать ИКПУ",
            message: `Назначить ИКПУ ${optionValueFromArgs(args, "--icps") ?? "?"} для товаров в ${scope}?`,
          }
        : {
            title: "Обновление is_labeled",
            confirm: "Записать is_labeled",
            message: `Назначить is_labeled=${optionValueFromArgs(args, "--labeled") ?? "?"} для товаров в ${scope}?`,
          };
  const confirmed = await dialog.showMessageBox(mainWindow!, {
    type: "warning",
    buttons: ["Отмена", spec.confirm],
    defaultId: 0,
    cancelId: 0,
    title: spec.title,
    message: spec.message,
    detail: skipDetail,
  });
  return confirmed.response === 1;
}

ipcMain.handle("start-run", async (_event, args: string[]) => {
  if (stoppingPromise) {
    await stoppingPromise;
  }
  if (isChildRunning()) {
    throw new Error("Обновление уже выполняется.");
  }
  if (!(await confirmBulkRun(args))) {
    return { running: false, stopping: false, cancelled: true, lastRunArgs };
  }
  child = spawnCli(args);
  rememberMxikRun(args);
  sendRunState(true, false);
  send("log", startLogLine(args[0]));

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) send("log", line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) send("log", line);
    }
  });
  child.on("close", (code) => {
    child = null;
    sendRunState(false, false);
    send("log", `Процесс завершился с кодом ${code ?? 0}.`);
    void getState().then((state) => send("state", state));
  });
  child.on("error", (error) => {
    child = null;
    sendRunState(false, false);
    send("log", `Не удалось запустить: ${error.message}`);
  });

  return { running: true, stopping: false, lastRunArgs };
});

ipcMain.handle("stop-run", async () => {
  await stopChild();
  const state = await getState();
  send("state", state);
  return { running: false, stopping: false };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void stopChild();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopChild();
});

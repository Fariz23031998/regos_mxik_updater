import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function codeRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (path.basename(path.dirname(here)) === "dist") {
    return path.resolve(here, "..", "..");
  }
  return path.resolve(here, "..");
}

function resolveDataRoot(): string {
  const fromEnv = process.env.REGOS_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const portable = process.env.PORTABLE_EXECUTABLE_DIR?.trim();
  if (portable) return path.resolve(portable);
  return codeRoot();
}

export function dataRoot(): string {
  const root = resolveDataRoot();
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  return root;
}

export function settingsFilePath(): string {
  return path.join(dataRoot(), "settings.json");
}

export function envFilePath(): string {
  return path.join(dataRoot(), ".env");
}

export { codeRoot };

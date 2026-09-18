import fs from "node:fs";
import { app } from "electron";

if (app.isPackaged) {
  process.env.REGOS_DATA_DIR ||= process.env.PORTABLE_EXECUTABLE_DIR || app.getPath("userData");
  fs.mkdirSync(process.env.REGOS_DATA_DIR, { recursive: true });
}

await import("./main.js");

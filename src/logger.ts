import fs from "node:fs";
import path from "node:path";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(date = new Date()): string {
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function logFileName(date = new Date()): string {
  return `log-${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}.log`;
}

export class Logger {
  private readonly filePath: string;

  constructor(logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.filePath = path.join(logsDir, logFileName());
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: string, message: string): void {
    const line = `${stamp()} [${level}] ${message}`;
    console.log(line);
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
}

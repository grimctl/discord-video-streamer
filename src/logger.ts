import type { LogLevel } from "./config.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const stamp = new Date().toISOString();
    const payload = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
    const line = `[${stamp}] ${level.toUpperCase()} ${message}${payload}`;

    if (level == "warn") {
      console.warn(line);
      return;
    }

    if (level == "error") {
      console.error(line);
      return;
    }

    console.log(line);
  }
}

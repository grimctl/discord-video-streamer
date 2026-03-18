import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type X264Preset =
  | "ultrafast"
  | "superfast"
  | "veryfast"
  | "faster"
  | "fast"
  | "medium"
  | "slow"
  | "slower"
  | "veryslow"
  | "placebo";

export type AppConfig = {
  token: string;
  displayName: string;
  prefix: string;
  api: {
    enabled: boolean;
    host: string;
    port: number;
  };
  logging: {
    level: LogLevel;
  };
  stream: {
    maxHeight?: number;
    maxFps: number;
    bitrateKbps: number;
    maxBitrateKbps: number;
    audioBitrateKbps: number;
    x264Preset: X264Preset;
    minimizeLatency: boolean;
    startupTimeoutMs: number;
    mediaStallTimeoutMs: number;
    probeTimeoutMs: number;
    networkTimeoutMs: number;
    retryInitialDelayMs: number;
    retryMaxDelayMs: number;
    stableAfterMs: number;
    buffer: {
      startupMs: number;
      targetMs: number;
      lowWaterMs: number;
      resumeMs: number;
    };
    userAgent: string;
  };
};

const DEFAULT_CONFIG: Omit<AppConfig, "token"> = {
  displayName: "bot",
  prefix: "$",
  api: {
    enabled: true,
    host: "127.0.0.1",
    port: 3000,
  },
  logging: {
    level: "info",
  },
  stream: {
    maxHeight: 1080,
    maxFps: 30,
    bitrateKbps: 4500,
    maxBitrateKbps: 6000,
    audioBitrateKbps: 128,
    x264Preset: "veryfast",
    minimizeLatency: false,
    startupTimeoutMs: 20_000,
    mediaStallTimeoutMs: 45_000,
    probeTimeoutMs: 12_000,
    networkTimeoutMs: 30_000,
    retryInitialDelayMs: 1_000,
    retryMaxDelayMs: 15_000,
    stableAfterMs: 300_000,
    buffer: {
      startupMs: 10_000,
      targetMs: 25_000,
      lowWaterMs: 5_000,
      resumeMs: 10_000,
    },
    userAgent: "Mozilla/5.0 (compatible; discord-video-streamer/0.1.0)",
  },
};

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const X264_PRESETS = new Set<X264Preset>([
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
  "placebo",
]);

type JsonObject = Record<string, unknown>;

export async function loadConfig(explicitPath?: string): Promise<{
  config: AppConfig;
  configPath: string;
}> {
  const configPath = await resolveConfigPath(explicitPath);
  const rawContent = await readFile(configPath, "utf8");
  const parsed = parseJsonc(rawContent);

  if (!isObject(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${configPath}`);
  }

  const stream = getObject(parsed, "stream");
  const buffer = getObject(stream, "buffer");
  const logging = getObject(parsed, "logging");
  const api = getObject(parsed, "api");

  const token =
    process.env.DISCORD_TOKEN ??
    getString(parsed, "token", undefined, { required: true });

  const displayName =
    process.env.DISCORD_DISPLAY_NAME ??
    getString(parsed, "displayName", DEFAULT_CONFIG.displayName);

  if (token == "PASTE_DISCORD_USER_TOKEN_HERE") {
    throw new Error(
      `Config file still contains the placeholder token: ${configPath}`,
    );
  }

  const prefix = process.env.COMMAND_PREFIX ?? getString(parsed, "prefix", DEFAULT_CONFIG.prefix);
  const logLevel = normalizeLogLevel(
    process.env.LOG_LEVEL ?? getString(logging, "level", DEFAULT_CONFIG.logging.level),
  );

  const maxHeight = parseOptionalPositiveNumber(
    process.env.STREAM_MAX_HEIGHT ?? getOptionalNumber(stream, "maxHeight", DEFAULT_CONFIG.stream.maxHeight),
    "stream.maxHeight",
  );

  const config: AppConfig = {
    token,
    displayName,
    prefix,
    api: {
      enabled: parseBoolean(
        process.env.API_ENABLED ?? getOptionalBoolean(api, "enabled", DEFAULT_CONFIG.api.enabled),
        "api.enabled",
      ),
      host: process.env.API_HOST ?? getString(api, "host", DEFAULT_CONFIG.api.host),
      port: parseRequiredPositiveNumber(
        process.env.API_PORT ?? getOptionalNumber(api, "port", DEFAULT_CONFIG.api.port),
        "api.port",
      ),
    },
    logging: {
      level: logLevel,
    },
    stream: {
      maxHeight,
      maxFps: parseRequiredPositiveNumber(
        process.env.STREAM_MAX_FPS ?? getOptionalNumber(stream, "maxFps", DEFAULT_CONFIG.stream.maxFps),
        "stream.maxFps",
      ),
      bitrateKbps: parseRequiredPositiveNumber(
        process.env.STREAM_BITRATE_KBPS ?? getOptionalNumber(stream, "bitrateKbps", DEFAULT_CONFIG.stream.bitrateKbps),
        "stream.bitrateKbps",
      ),
      maxBitrateKbps: parseRequiredPositiveNumber(
        process.env.STREAM_MAX_BITRATE_KBPS ?? getOptionalNumber(stream, "maxBitrateKbps", DEFAULT_CONFIG.stream.maxBitrateKbps),
        "stream.maxBitrateKbps",
      ),
      audioBitrateKbps: parseRequiredPositiveNumber(
        process.env.STREAM_AUDIO_BITRATE_KBPS ?? getOptionalNumber(stream, "audioBitrateKbps", DEFAULT_CONFIG.stream.audioBitrateKbps),
        "stream.audioBitrateKbps",
      ),
      x264Preset: normalizeX264Preset(
        getString(stream, "x264Preset", DEFAULT_CONFIG.stream.x264Preset),
      ),
      minimizeLatency: parseBoolean(
        process.env.STREAM_MINIMIZE_LATENCY ?? getOptionalBoolean(stream, "minimizeLatency", DEFAULT_CONFIG.stream.minimizeLatency),
        "stream.minimizeLatency",
      ),
      startupTimeoutMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "startupTimeoutMs", DEFAULT_CONFIG.stream.startupTimeoutMs),
        "stream.startupTimeoutMs",
      ),
      mediaStallTimeoutMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "mediaStallTimeoutMs", DEFAULT_CONFIG.stream.mediaStallTimeoutMs),
        "stream.mediaStallTimeoutMs",
      ),
      probeTimeoutMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "probeTimeoutMs", DEFAULT_CONFIG.stream.probeTimeoutMs),
        "stream.probeTimeoutMs",
      ),
      networkTimeoutMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "networkTimeoutMs", DEFAULT_CONFIG.stream.networkTimeoutMs),
        "stream.networkTimeoutMs",
      ),
      retryInitialDelayMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "retryInitialDelayMs", DEFAULT_CONFIG.stream.retryInitialDelayMs),
        "stream.retryInitialDelayMs",
      ),
      retryMaxDelayMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "retryMaxDelayMs", DEFAULT_CONFIG.stream.retryMaxDelayMs),
        "stream.retryMaxDelayMs",
      ),
      stableAfterMs: parseRequiredPositiveNumber(
        getOptionalNumber(stream, "stableAfterMs", DEFAULT_CONFIG.stream.stableAfterMs),
        "stream.stableAfterMs",
      ),
      buffer: {
        startupMs: parseRequiredPositiveNumber(
          process.env.STREAM_BUFFER_STARTUP_MS ?? getOptionalNumber(buffer, "startupMs", DEFAULT_CONFIG.stream.buffer.startupMs),
          "stream.buffer.startupMs",
        ),
        targetMs: parseRequiredPositiveNumber(
          process.env.STREAM_BUFFER_TARGET_MS ?? getOptionalNumber(buffer, "targetMs", DEFAULT_CONFIG.stream.buffer.targetMs),
          "stream.buffer.targetMs",
        ),
        lowWaterMs: parseRequiredPositiveNumber(
          process.env.STREAM_BUFFER_LOW_WATER_MS ?? getOptionalNumber(buffer, "lowWaterMs", DEFAULT_CONFIG.stream.buffer.lowWaterMs),
          "stream.buffer.lowWaterMs",
        ),
        resumeMs: parseRequiredPositiveNumber(
          process.env.STREAM_BUFFER_RESUME_MS ?? getOptionalNumber(buffer, "resumeMs", DEFAULT_CONFIG.stream.buffer.resumeMs),
          "stream.buffer.resumeMs",
        ),
      },
      userAgent: getString(stream, "userAgent", DEFAULT_CONFIG.stream.userAgent),
    },
  };

  validateBufferConfig(config.stream.buffer);

  return {
    config,
    configPath,
  };
}

async function resolveConfigPath(explicitPath?: string): Promise<string> {
  const candidates = [
    explicitPath,
    process.env.CONFIG_PATH,
    resolve(process.cwd(), "config.jsonc"),
    resolve(process.cwd(), "config/example.jsonc"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return resolve(candidate);
    }
  }

  throw new Error(
    "No config file found. Create config.jsonc from config/example.jsonc or set CONFIG_PATH.",
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value == "object" && value !== null && !Array.isArray(value);
}

function getObject(source: JsonObject, key: string): JsonObject {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (!isObject(value)) {
    throw new Error(`Expected ${key} to be an object`);
  }
  return value;
}

function getString(
  source: JsonObject,
  key: string,
  fallback?: string,
  options: { required?: boolean } = {},
): string {
  const value = source[key];
  if (typeof value == "string") {
    return value;
  }
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (options.required) {
    throw new Error(`Expected ${key} to be a string`);
  }
  if (fallback === undefined) {
    throw new Error(`Expected ${key} to be a string`);
  }
  return fallback;
}

function getOptionalNumber(
  source: JsonObject,
  key: string,
  fallback?: number,
): number | undefined {
  const value = source[key];
  if (typeof value == "number") {
    return value;
  }
  if (typeof value == "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function getOptionalBoolean(
  source: JsonObject,
  key: string,
  fallback?: boolean,
): boolean | undefined {
  const value = source[key];
  if (typeof value == "boolean") {
    return value;
  }
  if (typeof value == "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function parseRequiredPositiveNumber(
  value: number | string | undefined,
  label: string,
): number {
  const parsed = parseOptionalPositiveNumber(value, label);
  if (parsed === undefined) {
    throw new Error(`Expected ${label} to be a positive number`);
  }
  return parsed;
}

function parseOptionalPositiveNumber(
  value: number | string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value == "string" ? Number(value) : value;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected ${label} to be a positive number`);
  }

  return parsed;
}

function parseBoolean(value: boolean | string | undefined, label: string): boolean {
  if (typeof value == "boolean") {
    return value;
  }
  if (typeof value == "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  throw new Error(`Expected ${label} to be a boolean`);
}

function normalizeLogLevel(value: string): LogLevel {
  if (!LOG_LEVELS.has(value as LogLevel)) {
    throw new Error(`Unsupported logging.level: ${value}`);
  }
  return value as LogLevel;
}

function normalizeX264Preset(value: string): X264Preset {
  if (!X264_PRESETS.has(value as X264Preset)) {
    throw new Error(`Unsupported stream.x264Preset: ${value}`);
  }
  return value as X264Preset;
}

function validateBufferConfig(buffer: AppConfig["stream"]["buffer"]): void {
  if (buffer.lowWaterMs >= buffer.resumeMs) {
    throw new Error(
      "stream.buffer.lowWaterMs must be smaller than stream.buffer.resumeMs",
    );
  }

  if (buffer.startupMs < buffer.lowWaterMs) {
    throw new Error(
      "stream.buffer.startupMs must be at least stream.buffer.lowWaterMs",
    );
  }

  if (buffer.targetMs < buffer.resumeMs) {
    throw new Error(
      "stream.buffer.targetMs must be at least stream.buffer.resumeMs",
    );
  }
}

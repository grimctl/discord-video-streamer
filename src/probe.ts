import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

export type StreamProbe = {
  width?: number;
  height?: number;
  fps?: number;
};

type FfprobeResponse = {
  streams?: Array<{
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
  }>;
};

export async function probeStream(
  url: string,
  config: AppConfig,
  logger: Logger,
  signal?: AbortSignal,
): Promise<StreamProbe | undefined> {
  const args = [
    "-v",
    "error",
    ...buildProbeInputArgs(
      url,
      config.stream.userAgent,
      config.stream.networkTimeoutMs,
    ),
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate,r_frame_rate",
    "-of",
    "json",
    url,
  ];

  const child = spawn("ffprobe", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, config.stream.probeTimeoutMs);

  const abortHandler = () => {
    child.kill("SIGTERM");
  };

  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    const exit = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({
          code,
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
        });
      });
    });

    if (timedOut) {
      throw new Error(`ffprobe timed out after ${config.stream.probeTimeoutMs}ms`);
    }

    if (exit.code !== 0) {
      throw new Error(exit.stderr || `ffprobe exited with code ${exit.code}`);
    }

    if (!exit.stdout) {
      return undefined;
    }

    const response = JSON.parse(exit.stdout) as FfprobeResponse;
    const stream = response.streams?.[0];

    if (!stream) {
      return undefined;
    }

    return {
      width: normalizePositiveInteger(stream.width),
      height: normalizePositiveInteger(stream.height),
      fps: parseFrameRate(stream.avg_frame_rate ?? stream.r_frame_rate),
    };
  } catch (error) {
    logger.warn("Stream probe failed; continuing with defaults", {
      url,
      error: formatError(error),
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortHandler);
  }
}

export function buildProbeInputArgs(
  url: string,
  userAgent: string,
  networkTimeoutMs: number,
): string[] {
  return buildBaseInputArgs(url, userAgent, networkTimeoutMs);
}

export function buildStreamInputArgs(
  url: string,
  userAgent: string,
  networkTimeoutMs: number,
): string[] {
  return ["-thread_queue_size", "4096", ...buildBaseInputArgs(url, userAgent, networkTimeoutMs)];
}

function buildBaseInputArgs(
  url: string,
  userAgent: string,
  networkTimeoutMs: number,
): string[] {
  const args: string[] = [];

  if (url.startsWith("http://") || url.startsWith("https://")) {
    args.push(
      "-user_agent",
      userAgent,
      "-rw_timeout",
      String(networkTimeoutMs * 1000),
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_at_eof",
      "1",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_on_http_error",
      "4xx,5xx",
      "-reconnect_delay_max",
      "5",
    );
  }

  return args;
}

function parseFrameRate(value?: string): number | undefined {
  if (!value || value == "0/0") {
    return undefined;
  }

  const [numeratorValue, denominatorValue] = value.split("/");
  const numerator = Number(numeratorValue);
  const denominator = Number(denominatorValue ?? "1");

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return undefined;
  }

  const fps = numerator / denominator;
  if (!Number.isFinite(fps) || fps <= 0) {
    return undefined;
  }

  return fps;
}

function normalizePositiveInteger(value?: number): number | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.round(value);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

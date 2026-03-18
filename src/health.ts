import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";

export const DEFAULT_HEALTH_FILE_PATH =
  process.env.HEALTH_FILE_PATH ?? "/tmp/discord-video-streamer/health.json";
export const DEFAULT_HEALTH_WRITE_INTERVAL_MS = 15_000;
export const DEFAULT_HEALTH_STALE_MS = 90_000;

export type HealthSnapshot = {
  startedAt: string;
  updatedAt: string;
  state: string;
  stateChangedAt: string;
  clientReady: boolean;
  lastError?: string;
  stream?: {
    url: string;
    attempts: number;
    retries: number;
    requestedAt: string;
    runningSince?: string;
    lastMediaAt?: string;
    sourceHeight?: number;
    sourceFps?: number;
    targetHeight?: number;
    targetFps?: number;
    mediaStallTimeoutMs: number;
    voiceTarget: {
      guildId: string;
      guildName: string;
      channelId: string;
      channelName: string;
    };
  };
};

export type HealthEvaluation = {
  ok: boolean;
  reason?: string;
};

export class HealthReporter {
  private writeTimer?: NodeJS.Timeout;
  private writeChain = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly snapshotProvider: () => HealthSnapshot,
    private readonly filePath = DEFAULT_HEALTH_FILE_PATH,
    private readonly intervalMs = DEFAULT_HEALTH_WRITE_INTERVAL_MS,
  ) {}

  start(): void {
    this.publish();
    this.writeTimer = setInterval(() => {
      this.publish();
    }, this.intervalMs);
    this.writeTimer.unref();
  }

  stop(): void {
    if (this.writeTimer) {
      clearInterval(this.writeTimer);
      this.writeTimer = undefined;
    }
  }

  publish(): void {
    const snapshot = this.snapshotProvider();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await writeHealthSnapshot(snapshot, this.filePath);
      })
      .catch((error: unknown) => {
        this.logger.warn("Failed to write health snapshot", {
          error: formatError(error),
          filePath: this.filePath,
        });
      });
  }
}

export async function writeHealthSnapshot(
  snapshot: HealthSnapshot,
  filePath = DEFAULT_HEALTH_FILE_PATH,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = `${filePath}.tmp`;

  await mkdir(directory, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function readHealthSnapshot(
  filePath = DEFAULT_HEALTH_FILE_PATH,
): Promise<HealthSnapshot> {
  return JSON.parse(await readFile(filePath, "utf8")) as HealthSnapshot;
}

export function evaluateHealthSnapshot(
  snapshot: HealthSnapshot,
  options: { nowMs?: number; staleMs?: number } = {},
): HealthEvaluation {
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_HEALTH_STALE_MS;
  const updatedAtMs = Date.parse(snapshot.updatedAt);

  if (!Number.isFinite(updatedAtMs)) {
    return {
      ok: false,
      reason: "health snapshot has an invalid updatedAt timestamp",
    };
  }

  const ageMs = nowMs - updatedAtMs;
  if (ageMs > staleMs) {
    return {
      ok: false,
      reason: `Health snapshot is stale (${ageMs}ms old)`,
    };
  }

  if (snapshot.state === "failed") {
    return {
      ok: false,
      reason: snapshot.lastError ?? "stream session is failed",
    };
  }

  if (snapshot.state === "playing") {
    const lastMediaAtMs = Date.parse(snapshot.stream?.lastMediaAt ?? "");
    const stallTimeoutMs = snapshot.stream?.mediaStallTimeoutMs ?? 45_000;
    const mediaAgeMs = nowMs - lastMediaAtMs;

    if (!Number.isFinite(lastMediaAtMs) || mediaAgeMs > stallTimeoutMs) {
      return {
        ok: false,
        reason: `No media observed for ${mediaAgeMs}ms`,
      };
    }
  }

  return { ok: true };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

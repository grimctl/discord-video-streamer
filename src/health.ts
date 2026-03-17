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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

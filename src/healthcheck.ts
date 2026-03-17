import process from "node:process";
import {
  DEFAULT_HEALTH_FILE_PATH,
  DEFAULT_HEALTH_STALE_MS,
  readHealthSnapshot,
} from "./health.js";

async function main(): Promise<void> {
  const filePath = process.env.HEALTH_FILE_PATH ?? DEFAULT_HEALTH_FILE_PATH;
  const staleMs = getPositiveInteger(
    process.env.HEALTH_STALE_MS,
    DEFAULT_HEALTH_STALE_MS,
  );

  const snapshot = await readHealthSnapshot(filePath);
  const updatedAtMs = Date.parse(snapshot.updatedAt);
  const ageMs = Date.now() - updatedAtMs;

  if (!Number.isFinite(updatedAtMs) || ageMs > staleMs) {
    throw new Error(`Health snapshot is stale (${ageMs}ms old)`);
  }

  if (snapshot.state === "failed") {
    throw new Error(snapshot.lastError ?? "stream session is failed");
  }

  if (snapshot.state === "playing") {
    const lastMediaAtMs = Date.parse(snapshot.stream?.lastMediaAt ?? "");
    const stallTimeoutMs = snapshot.stream?.mediaStallTimeoutMs ?? 45_000;
    const mediaAgeMs = Date.now() - lastMediaAtMs;

    if (!Number.isFinite(lastMediaAtMs) || mediaAgeMs > stallTimeoutMs) {
      throw new Error(`No media observed for ${mediaAgeMs}ms`);
    }
  }
}

function getPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.round(parsed);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

import process from "node:process";
import {
  DEFAULT_HEALTH_FILE_PATH,
  DEFAULT_HEALTH_STALE_MS,
  evaluateHealthSnapshot,
  readHealthSnapshot,
} from "./health.js";

async function main(): Promise<void> {
  const filePath = process.env.HEALTH_FILE_PATH ?? DEFAULT_HEALTH_FILE_PATH;
  const staleMs = getPositiveInteger(
    process.env.HEALTH_STALE_MS,
    DEFAULT_HEALTH_STALE_MS,
  );

  const snapshot = await readHealthSnapshot(filePath);
  const evaluation = evaluateHealthSnapshot(snapshot, { staleMs });

  if (!evaluation.ok) {
    throw new Error(evaluation.reason ?? "healthcheck failed");
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

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";

test("loads buffered playback defaults with low latency disabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "discord-video-streamer-config-"));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const configPath = join(directory, "config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      token: "test-token",
    }),
    "utf8",
  );

  const { config } = await loadConfig(configPath);

  assert.equal(config.stream.minimizeLatency, false);
  assert.deepEqual(config.stream.buffer, {
    startupMs: 10_000,
    targetMs: 25_000,
    lowWaterMs: 5_000,
    resumeMs: 10_000,
  });
});

test("rejects invalid adaptive buffer thresholds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "discord-video-streamer-config-"));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  const configPath = join(directory, "config.jsonc");
  await writeFile(
    configPath,
    JSON.stringify({
      token: "test-token",
      stream: {
        buffer: {
          startupMs: 10_000,
          targetMs: 25_000,
          lowWaterMs: 10_000,
          resumeMs: 5_000,
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    loadConfig(configPath),
    /stream\.buffer\.lowWaterMs must be smaller than stream\.buffer\.resumeMs/,
  );
});

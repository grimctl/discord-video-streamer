import assert from "node:assert/strict";
import test from "node:test";
import {
  PlaybackBufferController,
  type PlaybackBufferSettings,
} from "./buffered-playback.js";
import type { Logger } from "./logger.js";

type TestHarness = {
  controller: PlaybackBufferController;
  logs: Array<{ level: string; message: string }>;
  setAudio(ms: number): void;
  setVideo(ms: number): void;
  getResetCount(): number;
};

const DEFAULT_BUFFER: PlaybackBufferSettings = {
  startupMs: 20_000,
  targetMs: 25_000,
  lowWaterMs: 5_000,
  resumeMs: 10_000,
};

test("starts playback after reaching the startup buffer", async () => {
  const harness = createHarness();

  harness.setVideo(20_000);
  harness.setAudio(20_000);
  harness.controller.handleBufferUpdate();

  await harness.controller.started;
  await harness.controller.waitForPlayback(AbortSignal.timeout(50));

  assert.equal(harness.controller.getSnapshot().state, "playing");
  assert.equal(harness.getResetCount(), 1);
  assert.equal(
    harness.logs.some((entry) => entry.message === "Playback buffer ready; starting Discord playback"),
    true,
  );
});

test("re-buffers below low water and resumes at the resume threshold", async () => {
  const harness = createHarness();

  harness.setVideo(20_000);
  harness.setAudio(20_000);
  harness.controller.handleBufferUpdate();
  await harness.controller.started;

  harness.setVideo(4_000);
  harness.setAudio(4_000);
  harness.controller.handleBufferUpdate();

  assert.equal(harness.controller.getSnapshot().state, "rebuffering");

  harness.setVideo(10_000);
  harness.setAudio(10_000);
  harness.controller.handleBufferUpdate();
  await harness.controller.waitForPlayback(AbortSignal.timeout(50));

  const snapshot = harness.controller.getSnapshot();
  assert.equal(snapshot.state, "playing");
  assert.equal(snapshot.rebufferCount, 1);
  assert.equal(harness.getResetCount(), 2);
});

test("drains remaining media if the source ends before startup completes", async () => {
  const harness = createHarness();

  harness.setVideo(4_000);
  harness.setAudio(4_000);
  harness.controller.markTrackEnded("video");
  harness.controller.markTrackEnded("audio");

  await harness.controller.started;
  await harness.controller.waitForPlayback(AbortSignal.timeout(50));

  const snapshot = harness.controller.getSnapshot();
  assert.equal(snapshot.state, "draining");
  assert.equal(snapshot.sourceEnded, true);
});

function createHarness(
  config: PlaybackBufferSettings = DEFAULT_BUFFER,
): TestHarness {
  const logs: Array<{ level: string; message: string }> = [];
  let audioBufferedMs = 0;
  let resetCount = 0;
  let videoBufferedMs = 0;

  const logger = {
    debug: (message: string) => {
      logs.push({ level: "debug", message });
    },
    error: (message: string) => {
      logs.push({ level: "error", message });
    },
    info: (message: string) => {
      logs.push({ level: "info", message });
    },
    warn: (message: string) => {
      logs.push({ level: "warn", message });
    },
  } as unknown as Logger;

  const controller = new PlaybackBufferController({
    audioEnabled: true,
    config,
    logger,
    getAudioBufferedMs: () => audioBufferedMs,
    getVideoBufferedMs: () => videoBufferedMs,
    resetTiming: () => {
      resetCount += 1;
    },
  });

  return {
    controller,
    logs,
    setAudio: (ms: number) => {
      audioBufferedMs = ms;
    },
    setVideo: (ms: number) => {
      videoBufferedMs = ms;
    },
    getResetCount: () => resetCount,
  };
}

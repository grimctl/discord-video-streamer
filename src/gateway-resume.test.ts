import assert from "node:assert/strict";
import test from "node:test";
import { resumeStreamAfterGatewayRecovery } from "./gateway-resume.js";
import type { Logger } from "./logger.js";
import type { StreamResumeCandidate } from "./stream-session.js";

const CANDIDATE: StreamResumeCandidate = {
  url: "http://example.test/live.ts",
  voiceTarget: {
    guildId: "guild-1",
    guildName: "Guild",
    channelId: "channel-1",
    channelName: "Channel",
  },
};

test("retries failed gateway resume attempts and eventually succeeds", async () => {
  const attempts: Array<Record<string, unknown> | undefined> = [];
  const logs: string[] = [];
  let failuresRemaining = 1;

  const result = await resumeStreamAfterGatewayRecovery({
    candidate: CANDIDATE,
    context: { shardId: 0 },
    event: "shardResume",
    logger: createLogger(logs),
    retryDelayMs: 1,
    session: {
      async resumeFromCandidate(_candidate, context) {
        attempts.push(context);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("temporary gateway race");
        }
      },
    },
  });

  assert.equal(result, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], {
    gatewayRecoveryAttempt: 1,
    gatewayRecoveryEvent: "shardResume",
    shardId: 0,
  });
  assert.deepEqual(attempts[1], {
    gatewayRecoveryAttempt: 2,
    gatewayRecoveryEvent: "shardResume",
    shardId: 0,
  });
  assert.equal(logs.includes("Resumed stream after gateway recovery"), true);
});

test("gives up once the gateway recovery window closes", async () => {
  let attempts = 0;

  const result = await resumeStreamAfterGatewayRecovery({
    candidate: CANDIDATE,
    event: "ready",
    logger: createLogger(),
    retryDelayMs: 1,
    session: {
      async resumeFromCandidate() {
        attempts += 1;
        throw new Error("still reconnecting");
      },
    },
    shouldContinue: () => attempts < 1,
  });

  assert.equal(result, false);
  assert.equal(attempts, 1);
});

function createLogger(messages: string[] = []): Logger {
  return {
    debug: (message: string) => {
      messages.push(message);
    },
    error: (message: string) => {
      messages.push(message);
    },
    info: (message: string) => {
      messages.push(message);
    },
    warn: (message: string) => {
      messages.push(message);
    },
  } as unknown as Logger;
}

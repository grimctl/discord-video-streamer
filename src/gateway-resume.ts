import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "./logger.js";
import type { StreamResumeCandidate } from "./stream-session.js";

export type GatewayResumeSession = {
  resumeFromCandidate(
    candidate: StreamResumeCandidate,
    context?: Record<string, unknown>,
  ): Promise<void>;
};

export type GatewayResumeOptions = {
  candidate: StreamResumeCandidate;
  context?: Record<string, unknown>;
  event: string;
  logger: Logger;
  maxAttempts?: number;
  retryDelayMs?: number;
  session: GatewayResumeSession;
  shouldContinue?: () => boolean;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export async function resumeStreamAfterGatewayRecovery({
  candidate,
  context = {},
  event,
  logger,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  session,
  shouldContinue = () => true,
}: GatewayResumeOptions): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!shouldContinue()) {
      return false;
    }

    logger.info("Attempting automatic stream resume after gateway recovery", {
      attempt,
      event,
      guildId: candidate.voiceTarget.guildId,
      channelId: candidate.voiceTarget.channelId,
      url: candidate.url,
      ...context,
    });

    try {
      await session.resumeFromCandidate(candidate, {
        gatewayRecoveryAttempt: attempt,
        gatewayRecoveryEvent: event,
        ...context,
      });

      logger.info("Resumed stream after gateway recovery", {
        attempt,
        event,
        guildId: candidate.voiceTarget.guildId,
        channelId: candidate.voiceTarget.channelId,
        url: candidate.url,
        ...context,
      });
      return true;
    } catch (error) {
      logger.warn("Automatic stream resume failed after gateway recovery", {
        attempt,
        error: formatError(error),
        event,
        guildId: candidate.voiceTarget.guildId,
        channelId: candidate.voiceTarget.channelId,
        url: candidate.url,
        ...context,
      });

      if (attempt >= maxAttempts) {
        break;
      }

      await delay(retryDelayMs * attempt);
    }
  }

  logger.warn("Giving up automatic stream resume after gateway recovery", {
    attempts: maxAttempts,
    event,
    guildId: candidate.voiceTarget.guildId,
    channelId: candidate.voiceTarget.channelId,
    url: candidate.url,
    ...context,
  });
  return false;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

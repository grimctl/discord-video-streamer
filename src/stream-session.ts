import { setTimeout as delay } from "node:timers/promises";
import {
  Encoders,
  Streamer,
  Utils,
  prepareStream,
} from "@dank074/discord-video-stream";
import { StageChannel, type Client, type Message } from "discord.js-selfbot-v13";
import {
  startBufferedPlayback,
  type BufferedPlaybackHandle,
} from "./buffered-playback.js";
import type { AppConfig } from "./config.js";
import {
  HealthReporter,
  type HealthSnapshot,
} from "./health.js";
import type { Logger } from "./logger.js";
import { buildStreamInputArgs, probeStream } from "./probe.js";

type StreamState = "idle" | "starting" | "playing" | "retrying" | "stopping" | "failed";

export type VoiceTarget = {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
};

type ActiveStream = {
  url: string;
  voiceTarget: VoiceTarget;
  requestedAt: Date;
  runningSince?: Date;
  attempts: number;
  retries: number;
  lastError?: string;
};

type OutputProfile = {
  sourceHeight?: number;
  sourceFps?: number;
  targetHeight?: number;
  targetFps: number;
};

class VoiceSessionInterruptedError extends Error {}

type FfmpegCommandLike = {
  on(event: string, listener: (...args: unknown[]) => void): void;
};

export class StreamSession {
  private readonly streamer: Streamer;
  private readonly encoder: ReturnType<typeof Encoders.software>;
  private readonly startedAt = new Date();
  private readonly healthReporter: HealthReporter;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private state: StreamState = "idle";
  private stateChangedAt = new Date();
  private active?: ActiveStream;
  private abortController?: AbortController;
  private runner?: Promise<void>;
  private lastMediaAt?: Date;
  private outputProfile?: OutputProfile;
  private playback?: BufferedPlaybackHandle;

  constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.streamer = new Streamer(client);
    this.encoder = Encoders.software({
      x264: { preset: this.config.stream.x264Preset },
      x265: { preset: this.config.stream.x264Preset },
    });
    this.healthReporter = new HealthReporter(
      logger,
      () => this.buildHealthSnapshot(),
    );
    this.healthReporter.start();
    this.heartbeatTimer = setInterval(() => {
      this.logHeartbeat();
    }, 60_000);
    this.heartbeatTimer.unref();
  }

  async start(message: Message, url: string): Promise<void> {
    const voiceTarget = await this.resolveVoiceTarget(message);
    await this.startWithVoiceTarget(voiceTarget, url, {
      authorId: message.author.id,
    });
  }

  async startWithIds(guildId: string, channelId: string, url: string): Promise<void> {
    const voiceTarget = this.resolveVoiceTargetFromIds(guildId, channelId);
    await this.startWithVoiceTarget(voiceTarget, url);
  }

  getHealthSnapshot(): HealthSnapshot {
    return this.buildHealthSnapshot();
  }

  private async startWithVoiceTarget(
    voiceTarget: VoiceTarget,
    url: string,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    this.logger.info("Received stream request", {
      guildId: voiceTarget.guildId,
      channelId: voiceTarget.channelId,
      url,
      ...context,
    });

    await this.stop(false);
    await this.joinVoiceTarget(voiceTarget);

    this.lastMediaAt = undefined;
    this.outputProfile = undefined;
    this.active = {
      url,
      voiceTarget,
      requestedAt: new Date(),
      attempts: 0,
      retries: 0,
    };

    this.abortController = new AbortController();
    this.setState("starting", {
      url,
      guildId: voiceTarget.guildId,
      channelId: voiceTarget.channelId,
    });
    this.runner = this.runLoop(this.active, this.abortController.signal).catch(
      (error: unknown) => {
        if (this.abortController?.signal.aborted) {
          return;
        }

        const reason = formatError(error);
        if (this.active) {
          this.active.lastError = reason;
        }

        this.setState("failed", { error: reason, url });
        this.logger.error("Streaming loop crashed", { error: reason, url });
      },
    );
    this.healthReporter.publish();
  }

  async stop(leaveVoice = false): Promise<boolean> {
    const hadActiveStream = Boolean(this.abortController);
    const runner = this.runner;

    if (hadActiveStream) {
      this.setState("stopping");
    }

    this.abortController?.abort();

    if (runner) {
      try {
        await runner;
      } catch {
        // Ignore shutdown errors.
      }
    }

    if (leaveVoice) {
      try {
        this.streamer.leaveVoice();
      } catch (error) {
        this.logger.warn("Failed leaving voice connection", {
          error: formatError(error),
        });
      }
    }

    this.abortController = undefined;
    this.runner = undefined;
    this.lastMediaAt = undefined;
    this.outputProfile = undefined;
    this.playback = undefined;
    this.active = undefined;
    this.setState("idle");
    this.healthReporter.publish();
    return hadActiveStream;
  }

  dispose(): void {
    clearInterval(this.heartbeatTimer);
    this.healthReporter.stop();
  }

  getStatus(): string {
    const lines = [`State: ${this.state}`];

    if (this.active) {
      lines.push(`Voice: ${this.active.voiceTarget.guildName} / ${this.active.voiceTarget.channelName}`);
      lines.push(`URL: ${this.active.url}`);
      lines.push(`Attempts: ${this.active.attempts}`);
      lines.push(`Retries: ${this.active.retries}`);
      if (this.outputProfile?.targetHeight) {
        lines.push(`Target Height: ${this.outputProfile.targetHeight}`);
      }
      lines.push(`Target FPS: ${this.outputProfile?.targetFps ?? this.config.stream.maxFps}`);
      if (this.active.runningSince) {
        lines.push(`Streaming For: ${formatDuration(Date.now() - this.active.runningSince.getTime())}`);
      }
      if (this.lastMediaAt) {
        lines.push(`Last Media: ${formatDuration(Date.now() - this.lastMediaAt.getTime())} ago`);
      }
      const playbackSnapshot = this.playback?.getSnapshot();
      if (playbackSnapshot) {
        lines.push(`Buffer State: ${playbackSnapshot.state}`);
        lines.push(`Buffered: ${formatBufferDuration(playbackSnapshot.bufferedMs)}`);
        lines.push(`Rebuffers: ${playbackSnapshot.rebufferCount}`);
        lines.push(`Buffer Target: ${formatBufferDuration(playbackSnapshot.targetMs)}`);
      }
      const actualVoiceTarget = getCurrentVoiceTarget(this.client);
      if (actualVoiceTarget) {
        lines.push(`Current Voice: ${actualVoiceTarget.guildName} / ${actualVoiceTarget.channelName}`);
      }
      if (this.active.lastError) {
        lines.push(`Last Error: ${this.active.lastError}`);
      }
    } else if (this.streamer.voiceConnection) {
      lines.push(
        `Voice: connected to ${this.streamer.voiceConnection.guildId}/${this.streamer.voiceConnection.channelId}`,
      );
    }

    return lines.join("\n");
  }

  private async runLoop(active: ActiveStream, signal: AbortSignal): Promise<void> {
    let delayMs = this.config.stream.retryInitialDelayMs;

    while (!signal.aborted) {
      active.attempts += 1;
      active.lastError = undefined;
      active.runningSince = undefined;
      this.lastMediaAt = undefined;
      this.playback = undefined;

      const attemptController = new AbortController();
      const attemptSignal = AbortSignal.any([signal, attemptController.signal]);

      const attemptStartedAt = Date.now();
      const probe = await probeStream(active.url, this.config, this.logger, attemptSignal);
      const targetHeight = chooseHeight(probe?.height, this.config.stream.maxHeight);
      const targetFps = chooseFps(probe?.fps, this.config.stream.maxFps);
      this.outputProfile = {
        sourceHeight: probe?.height,
        sourceFps: probe?.fps,
        targetHeight,
        targetFps,
      };

      this.logger.debug("Probed source stream", {
        url: active.url,
        width: probe?.width,
        height: probe?.height,
        fps: probe?.fps,
      });

      this.logger.debug("Selected stream output parameters", {
        url: active.url,
        sourceHeight: probe?.height,
        sourceFps: probe?.fps,
        maxHeight: this.config.stream.maxHeight,
        maxFps: this.config.stream.maxFps,
        targetHeight,
        targetFps,
      });

      this.setState(active.attempts === 1 ? "starting" : "retrying", {
        attempt: active.attempts,
        url: active.url,
      });

      let stopMediaTracking = (): void => undefined;

      try {
        signal.throwIfAborted();
        await this.joinVoiceTarget(active.voiceTarget);

        this.logger.info("Starting stream attempt", {
          attempt: active.attempts,
          url: active.url,
          guildId: active.voiceTarget.guildId,
          channelId: active.voiceTarget.channelId,
          height: targetHeight,
          fps: targetFps,
        });

        const prepared = prepareStream(
          active.url,
          {
            encoder: this.encoder,
            includeAudio: true,
            bitrateAudio: this.config.stream.audioBitrateKbps,
            bitrateVideo: this.config.stream.bitrateKbps,
            bitrateVideoMax: this.config.stream.maxBitrateKbps,
            height: targetHeight,
            frameRate: targetFps,
            minimizeLatency: this.config.stream.minimizeLatency,
            videoCodec: Utils.normalizeVideoCodec("H264"),
            customInputOptions: buildStreamInputArgs(
              active.url,
              this.config.stream.userAgent,
              this.config.stream.networkTimeoutMs,
            ),
          },
          attemptSignal,
        );

        this.attachFfmpegLogging(prepared.command, active.url, active.attempts);
        stopMediaTracking = this.trackMediaActivity(prepared.output);

        const playback = await startBufferedPlayback({
          buffer: this.config.stream.buffer,
          frameRate: targetFps,
          height: targetHeight ?? probe?.height ?? 720,
          input: prepared.output,
          logger: this.logger,
          signal: attemptSignal,
          streamer: this.streamer,
          width: chooseWidth(probe?.width, probe?.height, targetHeight),
        });
        this.playback = playback;
        this.healthReporter.publish();

        const startup = waitForPlaybackStart(
          playback.started,
          this.config.stream.startupTimeoutMs,
          attemptSignal,
        );

        const playing = playback.completed;

        await Promise.race([
          startup,
          playing.then(() => {
            throw new Error("Stream ended before buffered playback reached Discord");
          }),
        ]);

        if (!active.runningSince) {
          active.runningSince = new Date();
        }

        this.setState("playing", {
          attempt: active.attempts,
          url: active.url,
          targetHeight,
          targetFps,
        });
        delayMs = this.config.stream.retryInitialDelayMs;
        await Promise.race([
          playing,
          monitorStreamHealth({
            attemptController,
            attemptSignal,
            client: this.client,
            active,
            getLastMediaAt: () => this.lastMediaAt,
            logger: this.logger,
            mediaStallTimeoutMs: this.config.stream.mediaStallTimeoutMs,
          }),
        ]);
        stopMediaTracking();

        if (signal.aborted) {
          return;
        }

        throw new Error("Source ended unexpectedly");
      } catch (error) {
        attemptController.abort();
        if (signal.aborted) {
          return;
        }

        const reason = formatError(error);

        if (error instanceof VoiceSessionInterruptedError) {
          this.logger.info("Voice session changed; stopping stream and disconnecting", {
            url: active.url,
            reason,
          });
          await this.handleVoiceSessionInterrupted(reason);
          return;
        }

        active.lastError = reason;
        active.retries += 1;
        this.setState("retrying", {
          attempt: active.attempts,
          retry: active.retries,
          error: reason,
        });

        const attemptDurationMs = Date.now() - attemptStartedAt;
        if (attemptDurationMs >= this.config.stream.stableAfterMs) {
          delayMs = this.config.stream.retryInitialDelayMs;
        }

        this.logger.warn("Stream attempt failed; retrying", {
          attempt: active.attempts,
          retry: active.retries,
          attemptDurationMs,
          delayMs,
          error: reason,
          url: active.url,
        });

        await delay(delayMs, undefined, { signal });
        delayMs = Math.min(delayMs * 2, this.config.stream.retryMaxDelayMs);
      } finally {
        stopMediaTracking();
        this.playback = undefined;
        this.healthReporter.publish();
      }
    }
  }

  private async resolveVoiceTarget(message: Message): Promise<VoiceTarget> {
    if (!message.guildId || !message.guild) {
      throw new Error("Send commands from the server where you want to stream");
    }

    const channel = message.member?.voice?.channel ?? message.author.voice?.channel;
    if (!channel) {
      throw new Error("Join the target voice channel before using $play");
    }

    return {
      guildId: message.guildId,
      guildName: message.guild.name,
      channelId: channel.id,
      channelName:
        "name" in channel && typeof channel.name === "string"
          ? channel.name
          : channel.id,
    };
  }

  private resolveVoiceTargetFromIds(guildId: string, channelId: string): VoiceTarget {
    const guild = this.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);

    return {
      guildId,
      guildName: guild?.name ?? guildId,
      channelId,
      channelName:
        channel && "name" in channel && typeof channel.name === "string"
          ? channel.name
          : channelId,
    };
  }

  private async joinVoiceTarget(target: VoiceTarget): Promise<void> {
    const actualVoiceTarget = getCurrentVoiceTarget(this.client);
    const cachedGuildId = this.streamer.voiceConnection?.guildId;
    const cachedChannelId = this.streamer.voiceConnection?.channelId;
    const actualGuildId = actualVoiceTarget?.guildId;
    const actualChannelId = actualVoiceTarget?.channelId;

    const needsJoin =
      cachedGuildId !== target.guildId ||
      cachedChannelId !== target.channelId ||
      actualGuildId !== target.guildId ||
      actualChannelId !== target.channelId;

    if (needsJoin) {
      this.logger.info("Joining voice target", {
        guildId: target.guildId,
        guildName: target.guildName,
        channelId: target.channelId,
        channelName: target.channelName,
        actualGuildId,
        actualChannelId,
        cachedGuildId,
        cachedChannelId,
      });

      if (this.streamer.voiceConnection) {
        try {
          this.streamer.leaveVoice();
        } catch (error) {
          this.logger.warn("Failed leaving stale voice connection", {
            error: formatError(error),
            cachedGuildId,
            cachedChannelId,
          });
        }
      }

      await this.streamer.joinVoice(target.guildId, target.channelId);
    }

    if (this.streamer.client.user?.voice?.channel instanceof StageChannel) {
      await this.streamer.client.user.voice.setSuppressed(false);
    }
  }

  private async handleVoiceSessionInterrupted(reason: string): Promise<void> {
    try {
      if (this.streamer.voiceConnection || getCurrentVoiceTarget(this.client)) {
        this.streamer.leaveVoice();
      }
    } catch (error) {
      this.logger.warn("Failed leaving voice after interruption", {
        error: formatError(error),
      });
    }

    this.abortController = undefined;
    this.runner = undefined;
    this.lastMediaAt = undefined;
    this.outputProfile = undefined;
    this.playback = undefined;
    this.active = undefined;
    this.setState("idle", { reason });
    this.healthReporter.publish();
  }

  private buildHealthSnapshot(): HealthSnapshot {
    return {
      startedAt: this.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      state: this.state,
      stateChangedAt: this.stateChangedAt.toISOString(),
      clientReady: Boolean(this.client.user),
      lastError: this.active?.lastError,
      stream: this.active
        ? {
            url: this.active.url,
            attempts: this.active.attempts,
            retries: this.active.retries,
            requestedAt: this.active.requestedAt.toISOString(),
            runningSince: this.active.runningSince?.toISOString(),
            lastMediaAt: this.lastMediaAt?.toISOString(),
            sourceHeight: this.outputProfile?.sourceHeight,
            sourceFps: this.outputProfile?.sourceFps,
            targetHeight: this.outputProfile?.targetHeight,
            targetFps: this.outputProfile?.targetFps ?? this.config.stream.maxFps,
            mediaStallTimeoutMs: this.config.stream.mediaStallTimeoutMs,
            buffer: this.playback?.getSnapshot(),
            voiceTarget: this.active.voiceTarget,
          }
        : undefined,
    };
  }

  private setState(state: StreamState, context?: Record<string, unknown>): void {
    if (this.state === state) {
      return;
    }

    const previousState = this.state;
    this.state = state;
    this.stateChangedAt = new Date();
    this.logger.info("Stream state changed", {
      previousState,
      state,
      ...context,
    });
    this.healthReporter.publish();
  }

  private trackMediaActivity(stream: NodeJS.ReadableStream): () => void {
    const onData = () => {
      this.lastMediaAt = new Date();
    };

    stream.on("data", onData);
    return () => {
      stream.off("data", onData);
    };
  }

  private attachFfmpegLogging(
    command: FfmpegCommandLike,
    url: string,
    attempt: number,
  ): void {
    command.on("start", (...args: unknown[]) => {
      const [commandLine] = args;
      this.logger.debug("Spawned ffmpeg process", {
        attempt,
        url,
        commandLine: typeof commandLine === "string" ? commandLine : undefined,
      });
    });

    command.on("codecData", (codecData: unknown) => {
      const payload = isCodecData(codecData) ? codecData : undefined;
      this.logger.debug("FFmpeg input codec data", {
        attempt,
        url,
        format: payload?.format,
        video: payload?.video,
        audio: payload?.audio,
      });
    });

    command.on("error", (...args: unknown[]) => {
      const [error, _stdout, stderr] = args;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stderrSummary = summarizeText(typeof stderr === "string" ? stderr : undefined);
      const logMethod = isExpectedFfmpegExit(errorMessage, stderrSummary)
        ? this.logger.debug.bind(this.logger)
        : this.logger.warn.bind(this.logger);

      logMethod("FFmpeg process failed", {
        attempt,
        url,
        error: errorMessage,
        stderr: stderrSummary,
      });
    });

    command.on("end", () => {
      this.logger.debug("FFmpeg process ended", {
        attempt,
        url,
      });
    });
  }

  private logHeartbeat(): void {
    if (!this.active || this.state === "idle") {
      return;
    }

    const actualVoiceTarget = getCurrentVoiceTarget(this.client);

    this.logger.info("Stream heartbeat", {
      state: this.state,
      url: this.active.url,
      attempts: this.active.attempts,
      retries: this.active.retries,
      runningForMs: this.active.runningSince
        ? Date.now() - this.active.runningSince.getTime()
        : undefined,
      lastMediaAgeMs: this.lastMediaAt
        ? Date.now() - this.lastMediaAt.getTime()
        : undefined,
      playbackBuffer: this.playback?.getSnapshot(),
      voiceTarget: this.active.voiceTarget,
      actualVoiceTarget,
      outputProfile: this.outputProfile,
    });
  }
}

async function waitForPlaybackStart(
  started: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

  await Promise.race([
    started,
    delay(timeoutMs, undefined, { signal }).then(() => {
      throw new Error(
        `Playback buffer did not reach startup threshold within ${timeoutMs}ms`,
      );
    }),
  ]);
}

function chooseWidth(
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  targetHeight: number | undefined,
): number {
  if (!sourceWidth || !sourceHeight || !targetHeight) {
    return sourceWidth ?? 1280;
  }

  return Math.max(2, Math.round((sourceWidth * targetHeight) / sourceHeight / 2) * 2);
}

function chooseHeight(sourceHeight?: number, maxHeight?: number): number | undefined {
  if (!maxHeight) {
    return undefined;
  }

  if (!sourceHeight) {
    return maxHeight;
  }

  return Math.min(sourceHeight, maxHeight);
}

function chooseFps(sourceFps: number | undefined, maxFps: number): number {
  if (!sourceFps) {
    return Math.max(1, Math.round(maxFps));
  }
  return Math.max(1, Math.round(Math.min(sourceFps, maxFps)));
}

function monitorStreamHealth({
  attemptController,
  attemptSignal,
  client,
  active,
  getLastMediaAt,
  logger,
  mediaStallTimeoutMs,
}: {
  attemptController: AbortController;
  attemptSignal: AbortSignal;
  client: Client;
  active: ActiveStream;
  getLastMediaAt: () => Date | undefined;
  logger: Logger;
  mediaStallTimeoutMs: number;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const currentVoiceTarget = getCurrentVoiceTarget(client);
      if (!currentVoiceTarget) {
        const reason = `Voice target disconnected from ${active.voiceTarget.channelId}`;
        logger.warn("Voice target disconnected; stopping stream", {
          url: active.url,
          reason,
        });
        cleanup();
        attemptController.abort(new VoiceSessionInterruptedError(reason));
        reject(new VoiceSessionInterruptedError(reason));
        return;
      }

      if (currentVoiceTarget.channelId !== active.voiceTarget.channelId) {
        const reason = `Voice target changed from ${active.voiceTarget.channelId} to ${currentVoiceTarget.channelId}`;
        logger.info("Voice target changed; stopping stream", {
          url: active.url,
          fromGuildId: active.voiceTarget.guildId,
          fromChannelId: active.voiceTarget.channelId,
          fromChannelName: active.voiceTarget.channelName,
          toGuildId: currentVoiceTarget.guildId,
          toChannelId: currentVoiceTarget.channelId,
          toChannelName: currentVoiceTarget.channelName,
        });
        cleanup();
        attemptController.abort(new VoiceSessionInterruptedError(reason));
        reject(new VoiceSessionInterruptedError(reason));
        return;
      }

      const lastMediaAt = getLastMediaAt();
      if (!lastMediaAt) {
        return;
      }

      const mediaAgeMs = Date.now() - lastMediaAt.getTime();
      if (mediaAgeMs > mediaStallTimeoutMs) {
        const reason = `No media observed for ${mediaAgeMs}ms`;
        logger.warn("Media output stalled; restarting stream", {
          url: active.url,
          mediaAgeMs,
          mediaStallTimeoutMs,
        });
        cleanup();
        attemptController.abort(new Error(reason));
        reject(new Error(reason));
      }
    }, 5_000);
    timer.unref();

    const onAbort = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      clearInterval(timer);
      attemptSignal.removeEventListener("abort", onAbort);
    };

    attemptSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `${hours}h ${minutes}m ${remainder}s`;
}

function formatBufferDuration(durationMs: number): string {
  if (durationMs < 10_000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }

  return `${Math.round(durationMs / 1000)}s`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeText(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  return lines.slice(-6).join(" | ");
}

function getCurrentVoiceTarget(client: Client): VoiceTarget | undefined {
  const channel = client.user?.voice?.channel;
  if (!channel || !("guild" in channel) || !channel.guild) {
    return undefined;
  }

  return {
    guildId: channel.guild.id,
    guildName: channel.guild.name,
    channelId: channel.id,
    channelName: "name" in channel && typeof channel.name === "string" ? channel.name : channel.id,
  };
}

function isExpectedFfmpegExit(error: string, stderr?: string): boolean {
  const combined = `${error}\n${stderr ?? ""}`;
  return /signal 15|received signal 15|streaming aborted|killed with signal sigterm/i.test(combined);
}

function isCodecData(
  value: unknown,
): value is { format?: string; video?: string; audio?: string } {
  return typeof value === "object" && value !== null;
}

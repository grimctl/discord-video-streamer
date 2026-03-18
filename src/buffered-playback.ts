import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";
import { demux, type Streamer } from "@dank074/discord-video-stream";
import type { Logger } from "./logger.js";

export type PlaybackBufferSettings = {
  startupMs: number;
  targetMs: number;
  lowWaterMs: number;
  resumeMs: number;
};

export type PlaybackBufferState =
  | "startup"
  | "playing"
  | "rebuffering"
  | "draining"
  | "ended";

export type BufferedPlaybackSnapshot = {
  state: PlaybackBufferState;
  bufferedMs: number;
  videoBufferedMs: number;
  audioBufferedMs?: number;
  startupMs: number;
  targetMs: number;
  lowWaterMs: number;
  resumeMs: number;
  rebufferCount: number;
  sourceEnded: boolean;
};

export type BufferedPlaybackHandle = {
  started: Promise<void>;
  completed: Promise<void>;
  getSnapshot(): BufferedPlaybackSnapshot;
};

type StartBufferedPlaybackOptions = {
  input: Readable;
  streamer: Streamer;
  logger: Logger;
  width: number;
  height: number;
  frameRate: number;
  buffer: PlaybackBufferSettings;
  signal: AbortSignal;
};

type MediaConnectionLike = {
  setSpeaking(speaking: boolean): void;
  setVideoAttributes(enabled: false): void;
  setVideoAttributes(
    enabled: true,
    attr: { width: number; height: number; fps: number },
  ): void;
};

type WebRtcConnLike = {
  sendAudioFrame(frame: Buffer, frametime: number): void;
  sendVideoFrame(frame: Buffer, frametime: number): void;
  setPacketizer(videoCodec: string): void;
  mediaConnection: MediaConnectionLike;
};

type PacketLike = {
  data?: Uint8Array | Buffer | null;
  duration?: bigint | number;
  pts?: bigint | number;
  timeBase?: {
    num: number;
    den: number;
  };
  free(): void;
};

type BufferedPacket = {
  packet: PacketLike;
  durationMs: number;
  ptsMs?: number;
  byteLength: number;
};

type TrackName = "video" | "audio";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

type BufferStateTrackerOptions = {
  audioEnabled: boolean;
  config: PlaybackBufferSettings;
  logger: Logger;
  getAudioBufferedMs(): number | undefined;
  getVideoBufferedMs(): number;
  resetTiming(): void;
};

export class PlaybackBufferController {
  readonly started: Promise<void>;

  private readonly gate = new PlaybackGate();
  private readonly sourceEndedByTrack: Record<TrackName, boolean>;
  private readonly startedDeferred = createDeferred<void>();
  private readonly config: PlaybackBufferSettings;
  private state: PlaybackBufferState = "startup";
  private rebufferCount = 0;
  private sourceEnded = false;
  private startedResolved = false;
  private targetReachedLogged = false;

  constructor(private readonly options: BufferStateTrackerOptions) {
    this.config = validatePlaybackBufferSettings(options.config);
    this.started = this.startedDeferred.promise;
    this.sourceEndedByTrack = {
      video: false,
      audio: !options.audioEnabled,
    };
  }

  getSnapshot(): BufferedPlaybackSnapshot {
    const videoBufferedMs = Math.round(this.options.getVideoBufferedMs());
    const audioBufferedMs = this.options.getAudioBufferedMs();

    return {
      state: this.state,
      bufferedMs: Math.round(this.getBufferedMs()),
      videoBufferedMs,
      audioBufferedMs:
        audioBufferedMs === undefined ? undefined : Math.round(audioBufferedMs),
      startupMs: this.config.startupMs,
      targetMs: this.config.targetMs,
      lowWaterMs: this.config.lowWaterMs,
      resumeMs: this.config.resumeMs,
      rebufferCount: this.rebufferCount,
      sourceEnded: this.sourceEnded,
    };
  }

  async waitForPlayback(signal: AbortSignal): Promise<void> {
    await this.gate.wait(signal);
  }

  handleBufferUpdate(): void {
    const bufferedMs = this.getBufferedMs();

    if (!this.targetReachedLogged && bufferedMs >= this.config.targetMs) {
      this.targetReachedLogged = true;
      this.options.logger.info("Playback buffer reached target cushion", {
        bufferedMs: Math.round(bufferedMs),
        targetBufferMs: this.config.targetMs,
      });
    }

    if (this.sourceEnded) {
      if (bufferedMs > 0) {
        this.enterDraining();
      } else if (!this.startedResolved) {
        this.rejectStarted(
          new Error("Stream ended before the playback buffer could start"),
        );
      }
      return;
    }

    if (!this.startedResolved) {
      if (bufferedMs >= this.config.startupMs) {
        this.enterPlaying("startup");
      }
      return;
    }

    if (this.state === "rebuffering") {
      if (bufferedMs >= this.config.resumeMs) {
        this.enterPlaying("resume");
      }
      return;
    }

    if (this.state === "playing" && bufferedMs < this.config.lowWaterMs) {
      this.enterRebuffering();
    }
  }

  markTrackEnded(track: TrackName): void {
    if (this.sourceEndedByTrack[track]) {
      return;
    }

    this.sourceEndedByTrack[track] = true;
    this.sourceEnded = this.sourceEndedByTrack.video && this.sourceEndedByTrack.audio;
    this.handleBufferUpdate();
  }

  finish(): void {
    this.state = "ended";
    this.gate.open();
  }

  private getBufferedMs(): number {
    const videoBufferedMs = this.options.getVideoBufferedMs();
    const audioBufferedMs = this.options.getAudioBufferedMs();

    if (audioBufferedMs === undefined) {
      return videoBufferedMs;
    }

    return Math.min(videoBufferedMs, audioBufferedMs);
  }

  private enterPlaying(reason: "startup" | "resume"): void {
    const bufferedMs = Math.round(this.getBufferedMs());

    this.options.resetTiming();
    this.state = "playing";
    this.gate.open();

    if (!this.startedResolved) {
      this.startedResolved = true;
      this.startedDeferred.resolve();
      this.options.logger.info("Playback buffer ready; starting Discord playback", {
        bufferedMs,
        startupBufferMs: this.config.startupMs,
        targetBufferMs: this.config.targetMs,
      });
      return;
    }

    this.options.logger.info("Playback buffer refilled; resuming Discord playback", {
      bufferedMs,
      resumeBufferMs: this.config.resumeMs,
      rebufferCount: this.rebufferCount,
      reason,
    });
  }

  private enterRebuffering(): void {
    this.rebufferCount += 1;
    this.state = "rebuffering";
    this.gate.close();
    this.options.logger.warn("Playback buffer dropped below low-water mark; rebuffering", {
      bufferedMs: Math.round(this.getBufferedMs()),
      lowWaterBufferMs: this.config.lowWaterMs,
      resumeBufferMs: this.config.resumeMs,
      rebufferCount: this.rebufferCount,
    });
  }

  private enterDraining(): void {
    if (this.state === "draining" || this.state === "ended") {
      return;
    }

    this.options.resetTiming();
    this.state = "draining";
    this.gate.open();

    if (!this.startedResolved) {
      this.startedResolved = true;
      this.startedDeferred.resolve();
    }

    this.options.logger.info("Source ended; draining buffered playback", {
      bufferedMs: Math.round(this.getBufferedMs()),
    });
  }

  private rejectStarted(error: Error): void {
    if (this.startedResolved) {
      return;
    }

    this.startedResolved = true;
    this.startedDeferred.reject(error);
  }
}

export async function startBufferedPlayback({
  input,
  streamer,
  logger,
  width,
  height,
  frameRate,
  buffer,
  signal,
}: StartBufferedPlaybackOptions): Promise<BufferedPlaybackHandle> {
  const config = validatePlaybackBufferSettings(buffer);
  signal.throwIfAborted();

  const { video, audio } = await demux(input, { format: "nut" });
  signal.throwIfAborted();

  if (!video) {
    throw new Error("No video stream in media");
  }

  const conn = (await streamer.createStream()) as unknown as WebRtcConnLike;
  conn.setPacketizer("H264");
  conn.mediaConnection.setSpeaking(true);
  conn.mediaConnection.setVideoAttributes(true, {
    width: Math.round(width),
    height: Math.round(height),
    fps: Math.round(frameRate),
  });

  const videoQueue = new PacketQueue();
  const audioQueue = audio ? new PacketQueue() : undefined;
  const videoSender = new TimedMediaSender((frame, frametime) => {
    conn.sendVideoFrame(frame, frametime);
  });
  const audioSender = audioQueue
    ? new TimedMediaSender((frame, frametime) => {
        conn.sendAudioFrame(frame, frametime);
      })
    : undefined;
  videoSender.syncStream = audioSender;

  const controller = new PlaybackBufferController({
    audioEnabled: Boolean(audioQueue),
    config,
    logger,
    getAudioBufferedMs: () => audioQueue?.getBufferedMs(),
    getVideoBufferedMs: () => videoQueue.getBufferedMs(),
    resetTiming: () => {
      videoSender.resetTiming();
      audioSender?.resetTiming();
    },
  });
  controller.started.catch(() => undefined);

  const maxTrackBufferedMs = Math.max(
    config.targetMs + config.resumeMs,
    config.resumeMs * 3,
  );

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    videoQueue.clear();
    audioQueue?.clear();
    videoSender.finish();
    audioSender?.finish();

    video.stream.destroy();
    audio?.stream.destroy();

    try {
      streamer.stopStream();
    } catch {
      // Ignore cleanup races from repeated shutdown paths.
    }

    conn.mediaConnection.setSpeaking(false);
    conn.mediaConnection.setVideoAttributes(false);
    controller.finish();
  };

  const bindAbort = (stream: Readable): (() => void) => {
    const onAbort = () => {
      stream.destroy(toError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    return () => {
      signal.removeEventListener("abort", onAbort);
    };
  };

  const videoUnbindAbort = bindAbort(video.stream);
  const audioUnbindAbort = audio ? bindAbort(audio.stream) : undefined;

  const videoInput = consumeTrack({
    controller,
    fallbackDurationMs: Math.max(1, Math.round(1000 / Math.max(frameRate, 1))),
    maxBufferedMs: maxTrackBufferedMs,
    queue: videoQueue,
    signal,
    stream: video.stream,
    track: "video",
  });

  const audioInput = audioQueue && audio
    ? consumeTrack({
        controller,
        fallbackDurationMs: 20,
        maxBufferedMs: maxTrackBufferedMs,
        queue: audioQueue,
        signal,
        stream: audio.stream,
        track: "audio",
      })
    : Promise.resolve();

  const videoPlayback = playbackLoop({
    controller,
    queue: videoQueue,
    sender: videoSender,
    signal,
  });

  const audioPlayback = audioQueue && audioSender
    ? playbackLoop({
        controller,
        queue: audioQueue,
        sender: audioSender,
        signal,
      })
    : Promise.resolve();

  const completed = Promise.all([
    videoInput,
    audioInput,
    videoPlayback,
    audioPlayback,
  ])
    .then(() => undefined)
    .finally(() => {
      videoUnbindAbort();
      audioUnbindAbort?.();
      cleanup();
    });

  completed.catch(() => undefined);

  return {
    started: controller.started,
    completed,
    getSnapshot: () => controller.getSnapshot(),
  };
}

export function validatePlaybackBufferSettings(
  settings: PlaybackBufferSettings,
): PlaybackBufferSettings {
  if (settings.lowWaterMs >= settings.resumeMs) {
    throw new Error(
      "stream.buffer.lowWaterMs must be smaller than stream.buffer.resumeMs",
    );
  }

  if (settings.startupMs < settings.lowWaterMs) {
    throw new Error(
      "stream.buffer.startupMs must be at least stream.buffer.lowWaterMs",
    );
  }

  if (settings.targetMs < settings.resumeMs) {
    throw new Error(
      "stream.buffer.targetMs must be at least stream.buffer.resumeMs",
    );
  }

  return settings;
}

class PacketQueue {
  private bufferedBytes = 0;
  private bufferedMs = 0;
  private ended = false;
  private error?: Error;
  private readonly items: BufferedPacket[] = [];
  private readonly waiters = new Set<Deferred<void>>();

  clear(): void {
    for (const item of this.items.splice(0)) {
      item.packet.free();
    }
    this.bufferedBytes = 0;
    this.bufferedMs = 0;
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(error: Error): void {
    this.error ??= error;
    this.notify();
  }

  getBufferedMs(): number {
    return this.bufferedMs;
  }

  async waitForBufferedMsBelow(maxMs: number, signal: AbortSignal): Promise<void> {
    while (this.bufferedMs > maxMs && !this.ended && !this.error) {
      await this.wait(signal);
    }
  }

  async shift(signal: AbortSignal): Promise<BufferedPacket | undefined> {
    while (true) {
      signal.throwIfAborted();

      const item = this.items.shift();
      if (item) {
        this.bufferedMs = Math.max(0, this.bufferedMs - item.durationMs);
        this.bufferedBytes = Math.max(0, this.bufferedBytes - item.byteLength);
        this.notify();
        return item;
      }

      if (this.error) {
        throw this.error;
      }

      if (this.ended) {
        return undefined;
      }

      await this.wait(signal);
    }
  }

  push(item: BufferedPacket): void {
    this.items.push(item);
    this.bufferedMs += item.durationMs;
    this.bufferedBytes += item.byteLength;
    this.notify();
  }

  private notify(): void {
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    this.waiters.clear();
  }

  private async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const deferred = createDeferred<void>();
    this.waiters.add(deferred);

    const onAbort = () => {
      this.waiters.delete(deferred);
      deferred.reject(toError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await deferred.promise;
    } finally {
      this.waiters.delete(deferred);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

class PlaybackGate {
  private openState = false;
  private readonly waiters = new Set<Deferred<void>>();

  close(): void {
    this.openState = false;
  }

  open(): void {
    if (this.openState) {
      return;
    }

    this.openState = true;
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    this.waiters.clear();
  }

  async wait(signal: AbortSignal): Promise<void> {
    if (this.openState) {
      return;
    }

    const deferred = createDeferred<void>();
    this.waiters.add(deferred);

    const onAbort = () => {
      this.waiters.delete(deferred);
      deferred.reject(toError(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await deferred.promise;
    } finally {
      this.waiters.delete(deferred);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

class TimedMediaSender {
  syncStream?: TimedMediaSender;

  private ended = false;
  private ptsMs?: number;
  private readonly syncToleranceMs = 20;
  private startPtsMs?: number;
  private startTimeMs?: number;

  constructor(
    private readonly sendFrame: (frame: Buffer, frametime: number) => void,
  ) {}

  finish(): void {
    this.ended = true;
    this.syncStream = undefined;
  }

  resetTiming(): void {
    this.startPtsMs = undefined;
    this.startTimeMs = undefined;
  }

  async send(item: BufferedPacket, signal: AbortSignal): Promise<void> {
    try {
      const data = item.packet.data;
      if (!data) {
        return;
      }

      signal.throwIfAborted();
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const frametime = item.durationMs;

      const sendStartedAt = performance.now();
      this.sendFrame(frame, frametime);
      const sendCompletedAt = performance.now();

      this.ptsMs = this.resolvePts(item.ptsMs, frametime);
      this.startTimeMs ??= sendStartedAt;
      this.startPtsMs ??= this.ptsMs;

      if (frametime <= 0) {
        return;
      }

      const sleepMs = Math.max(
        0,
        this.ptsMs - this.startPtsMs + frametime - (sendCompletedAt - this.startTimeMs),
      );

      if (this.isBehind()) {
        this.resetTiming();
        return;
      }

      if (this.isAhead()) {
        do {
          await delay(frametime, undefined, { signal });
        } while (this.isAhead());
        this.resetTiming();
        return;
      }

      if (sleepMs > 0) {
        await delay(sleepMs, undefined, { signal });
      }
    } finally {
      item.packet.free();
    }
  }

  private isAhead(): boolean {
    const delta = this.ptsDelta();
    return delta !== undefined && delta > this.syncToleranceMs;
  }

  private isBehind(): boolean {
    const delta = this.ptsDelta();
    return delta !== undefined && delta < -this.syncToleranceMs;
  }

  private ptsDelta(): number | undefined {
    if (!this.syncStream || this.syncStream.ended) {
      return undefined;
    }

    if (this.ptsMs === undefined || this.syncStream.ptsMs === undefined) {
      return undefined;
    }

    return this.ptsMs - this.syncStream.ptsMs;
  }

  private resolvePts(ptsMs: number | undefined, frametime: number): number {
    if (ptsMs !== undefined) {
      return ptsMs;
    }

    if (this.ptsMs !== undefined) {
      return this.ptsMs + frametime;
    }

    return frametime;
  }
}

async function consumeTrack({
  controller,
  fallbackDurationMs,
  maxBufferedMs,
  queue,
  signal,
  stream,
  track,
}: {
  controller: PlaybackBufferController;
  fallbackDurationMs: number;
  maxBufferedMs: number;
  queue: PacketQueue;
  signal: AbortSignal;
  stream: Readable;
  track: TrackName;
}): Promise<void> {
  try {
    for await (const value of stream) {
      signal.throwIfAborted();

      const item = toBufferedPacket(value, fallbackDurationMs);
      if (!item) {
        continue;
      }

      queue.push(item);
      controller.handleBufferUpdate();
      await queue.waitForBufferedMsBelow(maxBufferedMs, signal);
    }

    queue.end();
    controller.markTrackEnded(track);
  } catch (error) {
    if (signal.aborted) {
      throw toError(signal.reason);
    }

    const normalized = toError(error);
    queue.fail(normalized);
    throw normalized;
  }
}

async function playbackLoop({
  controller,
  queue,
  sender,
  signal,
}: {
  controller: PlaybackBufferController;
  queue: PacketQueue;
  sender: TimedMediaSender;
  signal: AbortSignal;
}): Promise<void> {
  try {
    while (true) {
      await controller.waitForPlayback(signal);
      const item = await queue.shift(signal);
      if (!item) {
        sender.finish();
        return;
      }

      await sender.send(item, signal);
      controller.handleBufferUpdate();
    }
  } finally {
    sender.finish();
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function toBufferedPacket(
  value: unknown,
  fallbackDurationMs: number,
): BufferedPacket | undefined {
  if (!isPacketLike(value)) {
    return undefined;
  }

  const data = value.data;
  if (!data || data.length === 0) {
    value.free();
    return undefined;
  }

  return {
    packet: value,
    durationMs: getPacketDurationMs(value, fallbackDurationMs),
    ptsMs: getPacketPtsMs(value),
    byteLength: data.length,
  };
}

function getPacketDurationMs(packet: PacketLike, fallbackDurationMs: number): number {
  const duration = toMilliseconds(packet.duration, packet.timeBase);
  if (duration === undefined || duration <= 0) {
    return fallbackDurationMs;
  }

  return duration;
}

function getPacketPtsMs(packet: PacketLike): number | undefined {
  return toMilliseconds(packet.pts, packet.timeBase);
}

function toMilliseconds(
  value: bigint | number | undefined,
  timeBase: PacketLike["timeBase"],
): number | undefined {
  if (value === undefined || !timeBase || timeBase.den <= 0 || timeBase.num <= 0) {
    return undefined;
  }

  const numericValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numericValue)) {
    return undefined;
  }

  return (numericValue / timeBase.den) * timeBase.num * 1000;
}

function isPacketLike(value: unknown): value is PacketLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return typeof (value as PacketLike).free === "function";
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

# Discord IPTV Streamer

This is a fresh, stripped-down rewrite focused on one job: take an IPTV stream URL and keep it running in Discord as reliably and smoothly as possible.

It uses `@dank074/discord-video-stream` v6, software H.264 encoding, an adaptive playback buffer, a small local control API, Discord command fallback, source probing, and endless retry with backoff for flaky IPTV feeds.

## What It Does

- Reads commands from any non-bot user in visible channels
- Joins the voice channel you are currently in
- Starts Go Live streaming with `$play <url>`
- Exposes a simple HTTP API for play/stop/disconnect/status control
- Re-encodes to H.264 for Discord compatibility
- Probes source resolution and FPS first so it does not upscale smaller IPTV feeds
- Starts with a small playback cushion, keeps a larger best-effort buffer when possible, and re-buffers cleanly if the cushion runs low
- Retries forever if the source drops or stalls
- Restarts stalled streams and stops cleanly if the voice session is moved or disconnected unexpectedly
- Builds cleanly into a GHCR-publishable Docker image

## Commands

- The HTTP API is the primary control path.
- Discord message commands remain available as a fallback.
- `$play <url>`: stop any current stream and start this IPTV URL
- `$stop`: stop streaming but stay connected to voice
- `$disconnect`: stop streaming and leave voice
- `$status`: show current stream state, retry count, and last error
- `$help`: show command help

## Local Setup

Use `mise` for the runtime tools:

```bash
mise install
cp config/example.jsonc config.jsonc
```

`mise` now pulls a pinned prebuilt BtbN FFmpeg binary instead of compiling FFmpeg from source, so you do not need `nasm` for the tool install path.

Fill in your Discord user token in `config.jsonc`, then install Node dependencies and run the app:

```bash
mise run install
mise run dev
```

Build and run the compiled app:

```bash
mise run build
mise run start
```

Run the local test suite:

```bash
npm test
```

## Config

Start from `config/example.jsonc`.

Important fields:

- `token`: your Discord user token
- `displayName`: global display name to set after login, defaults to `bot`
- `prefix`: message prefix, defaults to `$`
- `api.enabled`: enable the local control API
- `api.host`: API bind address, defaults to `127.0.0.1`
- `api.port`: API port, defaults to `3000`
- `stream.maxHeight`: upper output cap; the app probes first and avoids upscaling
- `stream.maxFps`: caps outgoing FPS for Discord
- `stream.bitrateKbps` and `stream.maxBitrateKbps`: H.264 bitrate targets
- `stream.x264Preset`: software encoder preset, default `veryfast`
- `stream.minimizeLatency`: leave this `false` for IPTV smoothness; turning it on favors faster startup over playback stability
- `stream.buffer.startupMs`: initial playback delay before Discord starts receiving media
- `stream.buffer.targetMs`: best-effort steady cushion for absorbing short source/network hiccups
- `stream.buffer.lowWaterMs` and `stream.buffer.resumeMs`: when to pause for rebuffering and when to resume playback
- `stream.mediaStallTimeoutMs`: restarts streams that go silent without exiting
- `stream.retryInitialDelayMs` and `stream.retryMaxDelayMs`: reconnect backoff

You can also override the basics with env vars like `DISCORD_TOKEN`, `DISCORD_DISPLAY_NAME`, `COMMAND_PREFIX`, `LOG_LEVEL`, `API_ENABLED`, `API_HOST`, and `API_PORT`.

## HTTP API

The app exposes a tiny local API with no authentication. Keep it bound to localhost unless you are deliberately placing it behind a trusted reverse proxy or other network control.

If you run in Docker and want to reach the API from outside the container, set `api.host` to `0.0.0.0` and publish the port explicitly.

Base URL by default:

```bash
http://127.0.0.1:3000
```

Endpoints:

- `GET /healthz` - health summary plus current snapshot
- `GET /status` - current stream snapshot and human-readable status
- `POST /play` - start a stream in a specific guild/channel
- `POST /stop` - stop the stream and stay in voice
- `POST /disconnect` - stop the stream and leave voice

Example `POST /play`:

```bash
curl -X POST http://127.0.0.1:3000/play \
  -H 'content-type: application/json' \
  -d '{
    "url": "http://example.invalid/live/stream.ts",
    "guildId": "695363853516800091",
    "channelId": "1004767134401966091"
  }'
```

Example `POST /stop`:

```bash
curl -X POST http://127.0.0.1:3000/stop
```

Example `POST /disconnect`:

```bash
curl -X POST http://127.0.0.1:3000/disconnect
```

A simple OpenAPI description is available in `openapi.yaml`.

## Docker

Build locally:

```bash
docker build -t discord-video-streamer .
```

Run it with a mounted config:

```bash
docker run -d \
  --name discord-video-streamer \
  --restart unless-stopped \
  -v "$(pwd)/config.jsonc:/app/config.jsonc:ro" \
  discord-video-streamer
```

If you want to reach the control API from outside the container, set `api.host` to `0.0.0.0` and publish the port:

```bash
docker run -d \
  --name discord-video-streamer \
  --restart unless-stopped \
  -p 3000:3000 \
  -v "$(pwd)/config.jsonc:/app/config.jsonc:ro" \
  discord-video-streamer
```

## Long-Run Operation

- Use `logging.level = "info"` for normal operation and switch to `debug` only when investigating feed or voice issues.
- The app applies `displayName` on startup if the current global display name differs.
- The local control API defaults to `127.0.0.1:3000` with no auth; keep it on localhost unless you have an external access-control layer.
- The app writes a health snapshot to `/tmp/discord-video-streamer/health.json`; the container `HEALTHCHECK` reads that file.
- While active, the app logs a periodic `Stream heartbeat` line with state, retries, voice target, and last media age.
- If the Discord gateway reconnects, the active stream is stopped once, API mutations return `503`, and the process exits after 60s if the session does not recover.
- If the Discord session is invalidated or disconnects permanently, the process exits so your supervisor can restart it cleanly.
- `$status` is the quickest manual view of current state, retry count, output target, buffer depth, and last error.
- The adaptive playback buffer starts after `startupMs`, aims for `targetMs` when the source allows it, and re-buffers below `lowWaterMs` until `resumeMs` is available again.
- If Docker reports the container unhealthy, check recent logs for `Media output stalled`, `Voice target changed`, `FFmpeg process failed`, or `Stream attempt failed; retrying`.

The included GitHub workflow publishes the image to `ghcr.io/<owner>/<repo>` on pushes to `main`.

## Notes

- This project uses a selfbot library. That carries Discord account risk.
- Keep `config.jsonc` out of git.
- The Docker image includes a BtbN FFmpeg build because this library needs `ffmpeg` and `ffprobe` available and benefits from a compatible build.

## Credit

- Upstream streaming library: `Discord-RE/Discord-video-stream`
- Reference implementation ideas: `/tmp/Discord-livestream-selfbot`

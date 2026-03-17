# Discord IPTV Streamer

This is a fresh, stripped-down rewrite focused on one job: take `$play <iptv-stream-url>` and keep that stream running in Discord as reliably as possible.

It uses `@dank074/discord-video-stream` v6, software H.264 encoding, automatic voice join, source probing, and endless retry with backoff for flaky IPTV feeds.

## What It Does

- Reads commands from any non-bot user in visible channels
- Joins the voice channel you are currently in
- Starts Go Live streaming with `$play <url>`
- Re-encodes to H.264 for Discord compatibility
- Probes source resolution and FPS first so it does not upscale smaller IPTV feeds
- Retries forever if the source drops or stalls
- Restarts stalled streams and stops cleanly if the voice session is moved or disconnected unexpectedly
- Builds cleanly into a GHCR-publishable Docker image

## Commands

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

## Config

Start from `config/example.jsonc`.

Important fields:

- `token`: your Discord user token
- `prefix`: message prefix, defaults to `$`
- `stream.maxHeight`: upper output cap; the app probes first and avoids upscaling
- `stream.maxFps`: caps outgoing FPS for Discord
- `stream.bitrateKbps` and `stream.maxBitrateKbps`: H.264 bitrate targets
- `stream.x264Preset`: software encoder preset, default `veryfast`
- `stream.mediaStallTimeoutMs`: restarts streams that go silent without exiting
- `stream.retryInitialDelayMs` and `stream.retryMaxDelayMs`: reconnect backoff

You can also override the basics with env vars like `DISCORD_TOKEN`, `COMMAND_PREFIX`, and `LOG_LEVEL`.

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

## Long-Run Operation

- Use `logging.level = "info"` for normal operation and switch to `debug` only when investigating feed or voice issues.
- The app writes a health snapshot to `/tmp/discord-video-streamer/health.json`; the container `HEALTHCHECK` reads that file.
- While active, the app logs a periodic `Stream heartbeat` line with state, retries, voice target, and last media age.
- If the Discord gateway reconnects or the session is invalidated, the active stream is stopped instead of trying to auto-resume a possibly stale voice session.
- `$status` is the quickest manual view of current state, retry count, output target, and last error.
- If Docker reports the container unhealthy, check recent logs for `Media output stalled`, `Voice target changed`, `FFmpeg process failed`, or `Stream attempt failed; retrying`.

The included GitHub workflow publishes the image to `ghcr.io/<owner>/<repo>` on pushes to `main`.

## Notes

- This project uses a selfbot library. That carries Discord account risk.
- Keep `config.jsonc` out of git.
- The Docker image includes a BtbN FFmpeg build because this library needs `ffmpeg` and `ffprobe` available and benefits from a compatible build.

## Credit

- Upstream streaming library: `Discord-RE/Discord-video-stream`
- Reference implementation ideas: `/tmp/Discord-livestream-selfbot`

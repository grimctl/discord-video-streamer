# AGENTS.md

## Purpose
Instructions for coding agents working in this repository.
This repo is intentionally small. Keep changes narrow, explicit, and robust.
Prefer KISS over cleverness. Favor clean stop behavior over fragile recovery.

## Extra Rule Files
At the time this file was written, the repo contains none of the following:
- no `.cursor/rules/`
- no `.cursorrules`
- no `.github/copilot-instructions.md`
If any of those appear later, treat them as additional instructions and keep
this file aligned with them.

## Repo Overview
- Runtime: Node.js 24
- Language: TypeScript with ESM
- Package manager: npm
- Tool bootstrap: `mise`
- Media tools: pinned FFmpeg/FFprobe
- Main entrypoint: `src/index.ts`
- Stream lifecycle: `src/stream-session.ts`
- Config loading: `src/config.ts`
- Probe helpers: `src/probe.ts`
- Adaptive playback buffer: `src/buffered-playback.ts`
- HTTP control API: `src/control-server.ts`
- Logging: `src/logger.ts`
- Health snapshot: `src/health.ts`
- Healthcheck CLI: `src/healthcheck.ts`

## Core Principles
- Keep diffs small and task-focused.
- Preserve the single-process, single-stream design.
- Do not reintroduce removed tooling like pnpm, Biome, pre-commit, or Nix
  unless explicitly requested.
- Prefer explicit state transitions and readable logs.
- Stop cleanly on awkward edge cases instead of layering complex recovery.
- Keep operational behavior deterministic.

## Setup Commands
Install tools: `mise install`
Install deps: `mise run install` or `npm ci`
Create local config: `cp config/example.jsonc config.jsonc`
Never commit `config.jsonc`, Discord tokens, or secret-bearing local files.

## Build / Run / Check Commands
Run from source:
```bash
mise run dev
# or
npm run dev
```
Build:
```bash
mise run build
# or
npm run build
```
Typecheck only: `npm run typecheck`
Main validation command:
```bash
mise run check
# or
npm run check
```
Run tests:
```bash
npm test
```
Run built app: `mise run start` or `npm run start`
Run healthcheck: `npm run healthcheck` or `node build/healthcheck.js`
Build Docker image: `mise run docker:build` or `docker build -t discord-video-streamer .`

## Docker Runtime Command
```bash
docker run -d \
  --name discord-video-streamer \
  --restart unless-stopped \
  -v "$(pwd)/config.jsonc:/app/config.jsonc:ro" \
  discord-video-streamer
```

## CI-Equivalent Smoke Checks
This repo uses the built-in Node test runner for focused unit coverage plus the existing smoke checks.
Use these commands:
```bash
npm run check
npm test
node build/index.js config/example.jsonc
docker run --rm discord-video-streamer:test ffmpeg -version
docker run --rm discord-video-streamer:test ffprobe -version
docker run --rm discord-video-streamer:test node build/index.js config/example.jsonc
```
The placeholder-config startup checks are expected to fail and mention the
placeholder token.

## Single-Test Guidance
Tests compile into `build/**/*.test.js`.
- Run all tests: `npm test`
- Run one compiled test file: `npm run build && node --test build/config.test.js`
- For targeted validation beyond tests, use the smallest relevant command:
  - `npm run typecheck`
  - `node build/index.js config/example.jsonc`
  - `node build/healthcheck.js` with a prepared health snapshot

## Source Map
- `src/index.ts`: startup, Discord client wiring, commands, gateway handling
- `src/control-server.ts`: local HTTP API for play/stop/disconnect/status
- `src/stream-session.ts`: retries, voice handling, stream state, heartbeat
- `src/config.ts`: config defaults, validation, env overrides
- `src/buffered-playback.ts`: adaptive packet buffer, playback gating, rebuffering
- `src/probe.ts`: ffprobe and ffmpeg input options
- `src/logger.ts`: structured console logger
- `src/health.ts`: health snapshot write/read helpers
- `src/healthcheck.ts`: Docker/container healthcheck CLI
- `config/example.jsonc`: documented config template

## Formatting Rules
- Use 2-space indentation.
- Use double quotes.
- Use semicolons consistently.
- Keep line length reasonable; wrap long calls and object literals clearly.
- Prefer ASCII unless an existing file already uses Unicode meaningfully.
- Add comments only when they explain a non-obvious operational constraint.

## Import Rules
- Group imports in this order:
  1. Node built-ins
  2. third-party packages
  3. local modules
- Use `import type` for type-only imports where appropriate.
- For local TypeScript imports, include the `.js` extension.
- Remove unused imports.

## Type Rules
- Preserve `strict` TypeScript.
- Preserve `noUncheckedIndexedAccess` compatibility.
- Add explicit types for exported functions and important helpers.
- Prefer narrow types and small helper types over `any`.
- Use `unknown` for caught errors and normalize them before logging.
- Avoid non-null assertions unless there is no reasonable alternative.

## Naming Conventions
- Classes and types: `PascalCase`
- Functions, methods, variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` only for true constants
- Config keys: stable, readable, JSON-friendly names
- Prefer operationally descriptive names like `mediaStallTimeoutMs`

## Error Handling
- Throw `Error` with actionable messages.
- Fail fast on invalid config and unrecoverable runtime states.
- Use `try`/`catch`/`finally` around cleanup-sensitive code.
- Swallow errors only during cleanup and only intentionally.
- Prefer clean stop/disconnect behavior over partial recovery complexity.

## Logging and Observability
- Use `src/logger.ts`; avoid ad hoc console noise.
- Keep logs structured: message plus context object.
- Use `info` for startup, command handling, state changes, retries, and major
  gateway/voice events.
- Use `debug` for probe results, ffmpeg command lines, codec data, and expected
  SIGTERM exits.
- Use `warn` for degraded but recoverable conditions.
- Use `error` for unrecoverable conditions.
- Do not add a metrics stack or HTTP admin service unless explicitly requested.

## Stream Lifecycle Expectations
- One active stream at a time.
- Preserve the single-session model.
- When editing lifecycle code, consider startup timeout, media stall timeout,
  retry backoff, voice disconnect behavior, and gateway reconnect behavior.
- If behavior becomes ambiguous, stopping cleanly is usually the right choice.

## Config Rules
- Keep `src/config.ts`, `config/example.jsonc`, `README.md`, and `openapi.yaml` aligned.
- If config shape changes, update all three in the same change.
- Preserve existing env overrides unless intentionally removing them.
- Keep defaults suitable for long-running operation.

## Docker / CI Rules
- Keep `Dockerfile`, `.github/workflows/ci.yml`, and
  `.github/workflows/docker-publish.yml` aligned.
- Preserve FFmpeg/FFprobe smoke checks unless replacing them with something
  equally useful.
- Preserve the lightweight health snapshot + healthcheck model unless an
  explicit ops change is requested.

## Dependency Rules
- Be conservative with new dependencies.
- Prefer the Node standard library when practical.
- Do not casually replace the core Discord or streaming dependencies.
- If adding a package, explain why existing code or built-ins were insufficient.

## Documentation Rules
Update `README.md` when changing install flow, runtime commands, config keys,
Docker behavior, health behavior, or long-run operational semantics.

## Avoid
- Reintroducing deleted legacy modules
- Reintroducing removed local tooling by default
- Multi-stream orchestration
- Hidden auto-resume behavior that obscures stale voice state
- Secret-bearing config in git
- Large refactors that do not clearly improve robustness

# AGENTS.md

## Purpose

Guidance for coding agents working in this repository.

This repo is intentionally small. Keep changes minimal, operationally safe, and
easy to reason about. Prefer robustness and long-term maintainability over new
features or abstraction.

## Repository Snapshot

- Runtime: Node.js 24
- Language: TypeScript with ESM (`"type": "module"`)
- Package manager: npm
- Tool bootstrap: `mise`
- Media tools: pinned FFmpeg/FFprobe
- Main entrypoint: `src/index.ts`
- Stream lifecycle: `src/stream-session.ts`
- Config loading: `src/config.ts`
- Probe helpers: `src/probe.ts`
- Health snapshot: `src/health.ts`
- Healthcheck entrypoint: `src/healthcheck.ts`

## Additional Agent Rule Files

At the time this file was created, this repository does not contain any of the
following rule sources:

- no `.cursor/rules/`
- no `.cursorrules`
- no `.github/copilot-instructions.md`

If any of those files appear later, treat them as additional instructions and
keep this file aligned with them.

## Core Principles

- Keep diffs narrow and task-focused.
- Preserve the single-process, single-stream design.
- Do not reintroduce removed tooling like pre-commit, pnpm, Biome, or Nix
  unless explicitly requested.
- Favor explicit state transitions and clear logs over hidden automation.
- Prefer simple operational behavior over clever recovery logic.
- If a voice or session edge case is messy, stopping cleanly is often better
  than adding fragile self-healing behavior.

## Setup Commands

Install toolchain with `mise`:

```bash
mise install
```

Install Node dependencies:

```bash
mise run install
# or
npm ci
```

Create a local config file:

```bash
cp config/example.jsonc config.jsonc
```

Never commit `config.jsonc` or real Discord tokens.

## Build / Run / Check Commands

Run from source:

```bash
mise run dev
# or
npm run dev
```

Build TypeScript:

```bash
mise run build
# or
npm run build
```

Typecheck only:

```bash
npm run typecheck
```

Run the main validation command:

```bash
mise run check
# or
npm run check
```

Run the built app:

```bash
mise run start
# or
npm run start
```

Run the healthcheck entrypoint:

```bash
npm run healthcheck
# or
node build/healthcheck.js
```

## Docker Commands

Build image locally:

```bash
mise run docker:build
# or
docker build -t discord-video-streamer .
```

Run long-term with restart policy:

```bash
docker run -d \
  --name discord-video-streamer \
  --restart unless-stopped \
  -v "$(pwd)/config.jsonc:/app/config.jsonc:ro" \
  discord-video-streamer
```

## CI-Equivalent Smoke Checks

The repository has no unit test framework right now. The closest equivalents to
tests are smoke checks.

Main smoke command:

```bash
npm run check
```

Startup validation using placeholder config (expected failure mentioning the
placeholder token):

```bash
node build/index.js config/example.jsonc
```

Container smoke checks:

```bash
docker run --rm discord-video-streamer:test ffmpeg -version
docker run --rm discord-video-streamer:test ffprobe -version
docker run --rm discord-video-streamer:test node build/index.js config/example.jsonc
```

## Single-Test Guidance

There is currently no `npm test`, no Jest/Vitest, and no per-test runner.

- Do not assume a hidden test framework exists.
- There is no true "single test" command yet.
- For targeted validation, run the smallest relevant smoke command:
  - `npm run typecheck`
  - `node build/index.js config/example.jsonc`
  - `node build/healthcheck.js` with a prepared health snapshot

If a real test framework is added later, update this file with commands for:

- all tests
- watch mode
- a single test file
- a single test case

## Code Layout

- `src/index.ts`: process startup, Discord client, commands, gateway handling
- `src/stream-session.ts`: stream lifecycle, retries, voice handling, heartbeat
- `src/config.ts`: config defaults, validation, env overrides
- `src/probe.ts`: ffprobe and ffmpeg input option helpers
- `src/logger.ts`: structured console logger
- `src/health.ts`: health snapshot write/read helpers
- `src/healthcheck.ts`: healthcheck CLI
- `config/example.jsonc`: documented config template

## Formatting Rules

- Use 2-space indentation.
- Use double quotes.
- Use semicolons consistently.
- Keep functions readable rather than compressed.
- Wrap long calls and objects similarly to existing source files.
- Prefer ASCII unless the file already contains Unicode that should be kept.
- Avoid adding comments unless they explain a non-obvious operational detail.

## Import Rules

- Group imports in this order:
  1. Node built-ins
  2. third-party packages
  3. local modules
- Use `import type` when only importing types.
- For local TypeScript imports, include the `.js` extension in source files.
- Remove unused imports; do not leave dead import clutter.

## TypeScript Rules

- Preserve `strict` TypeScript.
- Preserve `noUncheckedIndexedAccess` compatibility.
- Add explicit types for exported functions and important helpers.
- Prefer narrow object types and unions over `any`.
- Use `unknown` for caught errors and normalize with helper functions.
- Avoid non-null assertions unless there is no reasonable alternative.
- Keep public runtime state explicit instead of inferred through side effects.

## Naming Conventions

- Classes and types: `PascalCase`
- Functions, methods, variables: `camelCase`
- Constants: use `UPPER_SNAKE_CASE` only for true constants
- Config keys should remain human-readable and stable
- Use names that describe behavior, e.g. `mediaStallTimeoutMs`,
  `retryInitialDelayMs`, `buildHealthSnapshot`

## Error Handling

- Throw `Error` with actionable messages.
- Fail fast on invalid config or unrecoverable runtime states.
- Use `try`/`catch`/`finally` around stream, process, and voice cleanup paths.
- Swallow errors only during cleanup and only intentionally.
- Convert unknown errors with a local `formatError()` helper before logging.
- Prefer clean stop/disconnect behavior over complicated partial recovery.

## Logging and Observability

- Use the logger wrapper, not ad hoc `console.log` statements.
- Keep logs structured: message plus JSON context object.
- Use `info` for major lifecycle events:
  - startup
  - command handling
  - state transitions
  - stream attempts
  - gateway/session changes
- Use `debug` for noisy internals:
  - probe results
  - ffmpeg command lines
  - codec data
  - expected SIGTERM exits
- Use `warn` for degraded but recoverable conditions.
- Use `error` for unrecoverable conditions.
- Do not add a metrics stack or HTTP admin service unless explicitly requested.

## Config Rules

- Keep `src/config.ts`, `config/example.jsonc`, and `README.md` aligned.
- If config shape changes, update all three in the same change.
- Maintain sensible defaults for long-running operation.
- Preserve env overrides where they already exist.

## Stream Lifecycle Rules

- This app supports one active stream at a time.
- Preserve the single active session model.
- When editing lifecycle code, consider:
  - startup timeout
  - media stall timeout
  - retry backoff
  - voice disconnect behavior
  - gateway reconnect behavior
- If behavior becomes ambiguous, prefer stopping cleanly over retry loops.

## Dependency Rules

- Be conservative with new dependencies.
- Prefer the Node standard library when practical.
- Do not casually swap out the core Discord or streaming dependencies.
- If you add a package, document why built-ins or current helpers were not
  sufficient.

## CI / Release Expectations

- Keep `.github/workflows/ci.yml` aligned with real repo commands.
- Keep `.github/workflows/docker-publish.yml` aligned with Docker behavior.
- If runtime behavior changes, preserve the smoke checks unless replacing them
  with something equally useful.
- Do not remove FFmpeg/FFprobe validation without replacement.

## Documentation Expectations

Update `README.md` when changing any of the following:

- install flow
- run commands
- config keys
- Docker behavior
- health behavior
- long-run operational semantics

## Avoid

- Reintroducing deleted legacy modules
- Reintroducing pre-commit or other removed local tooling by default
- Multi-stream orchestration or background worker complexity
- Auto-resume behavior that hides stale Discord voice state
- Secret files or token-bearing config in git
- Large refactors that do not clearly improve robustness

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.7] - 2026-04-27

### Fixed

- **`claude_code.session_name` is now per-session, not collector-wide.** Previously every span shared the tmux session name captured when the *collector* first spawned — so traces from a session started 2 days later still showed a long-deleted tmux name. Cause: the collector is a long-lived process; `process.env.TMUX_PANE` is frozen at its spawn time. Fix: the hook-client (which forks per-event in the user's *live* shell) now captures session_name + tmux/pane/window via a new `_aiobs.context` envelope on every hook event, and the collector treats those values as authoritative. Sets `claude_code.tmux.window` and `claude_code.tmux.pane` for the same reason.
- **Subagent traces can now be correlated to a parent session** via `claude_code.parent_session_id` and `claude_code.parent_agent_name`, populated when the spawning orchestrator (e.g. an `omc team` worker) sets `CLAUDE_PARENT_SESSION_ID` / `CLAUDE_PARENT_AGENT_NAME` in the child process env. Filter or group by these in Sentry to see all traces a single Task / orchestrator produced.

### Added

- **Plugin errors now appear in your own Sentry project.** Uncaught exceptions in the collector and dispatch failures in the hook handler are forwarded via `Sentry.captureException` with tag `claude_code.plugin_error: true`, so "no traces showing up" is debuggable directly in the Sentry **Issues** view of the same project the DSN points at — no log files required. Implemented in `src/sentry-errors.ts` (`reportPluginError`, `reportPluginMessage`, `installGlobalHandlers`).
- **Per-turn rollups on `gen_ai.invoke_agent` spans** for "which turns are tool-heavy / spawned subagents" queries: `claude_code.turn.tool_count`, `claude_code.turn.subagent_count`, `claude_code.turn.tools_used` (comma-joined names).
- **Per-tool duration**: `gen_ai.tool.duration_ms` on every `gen_ai.execute_tool` span (Pre→Post wall-clock).
- **Cross-platform doctor**: `scripts/doctor.mjs` (Node, runs natively on Windows PowerShell, macOS, Linux, WSL). The legacy `scripts/doctor.sh` is now a thin `exec node` wrapper so existing `bash scripts/doctor.sh` invocations keep working.
- **Two slash commands** shipped under `commands/`:
  - `/aiobs-test` — runs the doctor + smoke test, with a triage table mapping common failures to fixes.
  - `/aiobs-setup` — one-line alias that invokes the existing setup wizard skill, for users who prefer slash-command discoverability.

### Changed

- **`SessionRecord` shape** in the collector: `pendingTools` map values are now `{ span, startedAt, toolName }` (was `Span`), enabling the new per-tool duration attribute. Internal API; only `src/server.ts` consumes it.
- **`HookEvent` types** carry an optional `_aiobs?: { context?: AiobsClientContext }` envelope. Old collectors (pre-0.1.7) safely ignore the unknown field; old hook-clients sending no envelope continue to work — the collector falls back to its own `detectContext` snapshot.

## [0.1.6] - 2026-04-26

### Changed

- **Setup skill (`set up Sentry monitoring`) now self-cleans the legacy upstream install.** Before prompting for a DSN, the skill detects leftovers from `sergical/claude-code-sentry-monitor` (installed-plugins manifest entry, a process listening on port 19876, and `~/.cache/claude-code-sentry-monitor/`), asks once, and on confirmation kills the upstream collector and wipes its cache. It also evicts a stale `claude-code-ai-observability` collector PID so the new install starts fresh. PowerShell equivalents are included for native Windows.
- **Setup skill now runs `scripts/doctor.sh` automatically** at the end (instead of just suggesting it) and reports `OK` / `NOT OK: collector not running` / `NOT OK: no DSN configured` with a context-appropriate next step. On native Windows the skill falls back to an inline `/health` probe via `node -e fetch(...)`.
- **README migration guide collapsed to four slash commands + one skill invocation.** The previous five-step bash-and-slash mix is replaced by `/plugin marketplace remove sergical` → `/plugin uninstall claude-code-sentry-monitor` → `/plugin marketplace add Joshkop/claude-code-ai-observability` → `/plugin install claude-code-ai-observability` → say "set up Sentry monitoring". The skill handles the rest. A "Windows" subsection documents the native-Windows tradeoff (runtime works; bundled bash doctor needs WSL/Git Bash).

### Notes

- No runtime / collector / hook code changed — `scripts/*.js` is identical to v0.1.5. Version bump is a UX-only release.

## [0.1.5] - 2026-04-26

### Fixed

- **"Tokens Used" widget on Sentry's AI Agents dashboard now populates.** Each per-turn `gen_ai.invoke_agent` transaction now contains a synthetic `gen_ai.chat` child span that carries the per-turn token aggregate. Sentry's dashboard widget filters specifically by `op=gen_ai.chat`; placing token attributes on the `invoke_agent` root alone made the per-span detail view show the tokens (and made Sentry compute server-side `gen_ai.cost.*` from them) but left the dashboard's per-conversation rollup blank. The chat child carries `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` / `input_tokens.cached` / `input_tokens.cache_write`, plus `gen_ai.conversation.id`, `gen_ai.request.model`, and `gen_ai.response.model` for filter parity. The `invoke_agent` root keeps `conversation.cost_estimate_usd` as the cost rollup; tokens are no longer duplicated on the root (they live on the chat child only).

### Changed

- **`closeTurnSpan` signature.** Now requires the Sentry namespace as its first argument and accepts `turnStartTime` + `sessionId` on `CloseTurnInput` so the chat child can span the same window as its parent and inherit the conversation id. Internal API; only the collector calls it.
- **`SessionRecord.currentTurnStart`.** New field tracking the Unix-seconds start time of the active turn. Set in `handleUserPrompt`, consumed by `closeTurnSpan`, cleared on close.

## [0.1.4] - 2026-04-26

### Changed

- **Sentry-recognized cost attribute.** Per-turn USD cost is now emitted as a single `conversation.cost_estimate_usd` rollup on the `gen_ai.invoke_agent` turn span (the attribute name used by Sentry's manual-monitoring example). The previous `gen_ai.usage.cost.input_tokens` / `cost.output_tokens` / `cost.total_tokens` attrs were custom to this plugin — Sentry's SDK constants and dashboard widgets do not recognize them, and Sentry computes its own server-side totals from the standard token attrs. They are removed; the rollup is the only published cost attribute now.
- **`gen_ai.usage.input_tokens.cache_creation` renamed to `gen_ai.usage.input_tokens.cache_write`** to match Sentry-Python's `GEN_AI_USAGE_INPUT_TOKENS_CACHE_WRITE` constant. The previous name was neither the Sentry nor the OTel canonical form.
- **`gen_ai.provider.name` added** alongside the legacy `gen_ai.system` attribute. Sentry's newer SDKs prefer `provider.name`; we dual-emit so older versions continue to work.

### Added

- **`gen_ai.conversation.id` on every turn span**, set to the Claude Code session ID. This is the OTel-spec attribute that Sentry's AI Agents list uses for cross-turn grouping; it complements the existing `claude_code.session_id` plugin tag.
- **`gen_ai.tool.call.id` on tool spans**, set to Claude Code's `tool_use_id`. Lets Sentry correlate the model's tool-call request to the resulting `gen_ai.execute_tool` span; previously the spans had no shared identifier.
- **`gen_ai.tool.type = "function"`** on tool spans (Sentry-recognized).
- **`Sentry.setUser({ username, id })`** at collector startup, derived from `os.userInfo()`. Populates Sentry's first-class user filter so traces split cleanly per developer on shared hosts. Email and IP are not collected.
- **`service.name = "claude-code-ai-observability"` and `service.version`** auto-tags. `service.name` is Sentry's first-class service field; `service.version` carries the plugin version so trace filters can pin to a specific release.
- **More resource attrs for filtering**: `host.arch`, `os.version`, `process.runtime.name = "node"`, `process.runtime.version`, `process.executable.path`. All emitted as searchable span tags.

### Fixed

- **CHANGELOG correction.** The v0.1.0 entry below claimed "Correct `gen_ai.chat` operation on turn spans" — that was never implemented. Turn spans have always used `gen_ai.invoke_agent`, which is correct (a Claude Code turn is one agent invocation, not a single chat completion). The bullet has been struck through; nothing in the runtime changed because of this fix.
- **CHANGELOG correction.** The v0.1.0 cost attribute names listed in the "USD cost calculation" bullet (`gen_ai.usage.cost.*`) were not Sentry conventions. The bullet has been updated to reflect the v0.1.4 attribute name (`conversation.cost_estimate_usd`).

## [0.1.3] - 2026-04-25

### Fixed

- **Bounded eviction retry (no more livelock).** `ensureServerRunning` is now an iterative loop capped at 3 attempts instead of recursing on stale-lock contention. Under N concurrent session starts with a stale lock-holder, peers fall through to passive wait rather than ping-ponging `releaseLock` / `tryAcquireLock`.
- **PID-reuse-safe kill.** Before `SIGTERM` and again before the `SIGKILL` escalation, `killStaleCollector` re-confirms the target PID still owns the collector port via `findListenerPid`. If ownership has shifted (kernel recycled the PID to an unrelated process), the kill is aborted with a stderr notice.
- **Squatting non-collectors no longer get re-spawned-over.** `probeHealth` now distinguishes "legacy collector" (plain `ok`) from "port held by a stranger" (200 OK with a non-recognized body). The hook client warns once and bails instead of looping on `EADDRINUSE`.
- **Stricter health shape.** `probeHealth` requires `ok: true` in a parsed JSON health response; random `{evil: true}` bodies are treated as occupied.
- **Collector timers scoped to `listening`.** `setInterval` installs for flush + stale-session reaper now fire from the `listening` handler, and the `EADDRINUSE` branch cleans up the PID file defensively — no more phantom timers or stray PID file if `server.listen` fails.
- **Full PID-file shape check.** `readPidFile` validates `pid`, `port`, `version`, and `startedAt` types before returning — partial / malformed lock files no longer crash the eviction path.
- **Subagent-only sessions survive the reaper.** `handlePreTool` / `handlePostTool` bump `lastEventAt` explicitly so a session that spends its 30+ min in subagent-tool work isn't harvested mid-flight.

### Added

- **Cross-user cross-talk guard.** `/health` now includes `uid`; the hook client rejects a collector whose `uid` doesn't match the invoking user, preventing two users on a shared host from cross-wiring each other's Sentry DSNs.
- **`scripts/doctor.sh`.** A diagnostic helper that prints plugin version, installed-plugin info, `/health` JSON, PID file contents, listening process, DSN config path (without leaking the DSN), recent hook & collector errors, and relevant env vars — ending with a one-line `OK` / `NOT OK` summary.
- **README Troubleshooting section.** Five common failure modes with doctor-driven diagnosis and exact fix commands (stale collector, silent hooks, port collision, missing DSN, stale session after upgrade).
- **`hook.err.log` rotation.** Capped at 1 MiB with a single `.1` rollover so a misconfigured plugin can't fill `~/.cache`.
- **Test coverage for v0.1.2 paths.** New suites: `tests/server-endpoints.test.ts` (JSON `/health` + `/version` + PID file lifecycle), `tests/server-stale-session.test.ts` (exported `isStaleSession` predicate), `tests/hook-client-units.test.ts` (`probeHealth` legacy fallback, JSON strictness, occupied-port detection, `readPidFile` shape validation). Total suite now 121 tests.

## [0.1.2] - 2026-04-25

### Fixed

- **Stale collectors no longer block new sessions.** A long-lived collector (e.g. one started manually for testing, or surviving across plugin upgrades) used to satisfy the `/health` probe forever, so `ensureServerRunning` never spawned a fresh one. New tmux/CLI sessions appeared to "lose" Sentry data even though the plugin was installed. The hook client now compares the collector's reported version against the plugin version and replaces mismatched or legacy collectors. PID is sourced from the new JSON `/health` response, falling back to a `collector.pid` file, falling back to OS-level listener lookup (`lsof` / `ss` / `fuser`).
- **`hook.sh` no longer swallows errors.** stderr from the hook client is appended to `~/.cache/claude-code-ai-observability/hook.err.log` instead of `/dev/null`. Port collisions, eviction notices, and crashes now leave a trail.
- **Listen failures surface clearly.** The collector logs `EADDRINUSE` (and any other listen error) to stderr and exits with code 2 instead of hanging, so a manual `node scripts/index.js --serve …` attempt that races a running collector is obvious.

### Added

- **Identity-aware `/health` endpoint.** `GET /health` now returns JSON `{ ok, pid, port, version, startedAt, sessions }` instead of plain `"ok"`. A new `GET /version` endpoint exposes the same version field.
- **Collector PID file.** On startup, the collector writes `~/.cache/claude-code-ai-observability/collector.pid` with `{ pid, port, version, startedAt }`; it is removed on graceful shutdown.
- **Periodic Sentry flush + stale-session reaper.** Every 30 s the collector flushes the Sentry transport and reaps any session that hasn't received an event in 30 minutes (closing its current turn span and pending tool spans). Previously, sessions whose `SessionEnd` hook never fired (e.g. tmux pane killed) left a turn open until the collector was restarted.

## [0.1.1] - 2026-04-25

### Fixed

- **Plugin installs now actually run hooks.** `scripts/*.js` / `scripts/*.map` were previously `.gitignored`, so fresh git-clone installs via the marketplace shipped without `hook-client.js` / `index.js` / `server.js` etc. `hook.sh` silently no-op'd and no events reached the collector. The compiled JS is now tracked in git, with a CI drift guard (`scripts/*.js`) that fails the build if generated files go stale relative to `src/`.

### Added

- **Per-turn root transactions for realtime trace visibility.** Each conversation turn now opens its own `gen_ai.invoke_agent` root transaction in realtime mode instead of batching everything under a single session-level root. Improves Sentry trace navigation and makes per-turn span aggregation match the batch-mode contract.

## [0.1.0] - 2026-04-24

### Added

- **Realtime-only collector** — dropped batch mode; all events are processed immediately via a local HTTP server that Claude Code hooks POST to.
- ~~**Correct `gen_ai.chat` operation** on turn spans (upstream used `gen_ai.request`); Sentry's "Tokens Used" dashboard widget requires `gen_ai.chat` to aggregate correctly.~~ *(Corrected in v0.1.4: this was never implemented and the description was wrong. Turn spans use `gen_ai.invoke_agent` — the correct op for a per-turn agent invocation.)*
- **Per-turn token attributes** on `gen_ai.invoke_agent` turn spans: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.usage.input_tokens.cached` — extracted live from the session transcript at each turn boundary.
- **Subagent spans**: Task-tool invocations produce nested `gen_ai.invoke_agent` spans with `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name` set from `subagent_type`, and proper open/close lifecycle tied to `PreToolUse`/`PostToolUse` events.
- **USD cost calculation** per turn using a built-in price table for Opus/Sonnet/Haiku, with cached input priced at the `cacheRead` rate and an env-overridable price table (`CLAUDE_AIOBS_PRICE_OVERRIDES`). *(v0.1.4: cost is published as a single `conversation.cost_estimate_usd` rollup on the turn span; v0.1.0–v0.1.3 emitted custom `gen_ai.usage.cost.*` attrs that no Sentry widget consumed.)*
- **Rich auto-tagging** on every span: `claude_code.session_id/session_name/version`, `vcs.repository.name/url`, `vcs.ref.head.name/revision`, `host.name`, `os.type`, `process.cwd`, `process.pid` — all detected non-blocking and cached once per session with graceful degradation when git/tmux are absent.
- **`PreCompact` and `Stop` hook support** — events are accepted and handled as no-ops so hooks never fail on these event types.
- **WSL2-safe health probes** — hook client uses `AbortSignal.timeout(500)` to avoid hanging on silently-dropped ports in WSL2 environments.
- **Tool error instrumentation** (`applyToolError`, `captureBreadcrumb`) sets Sentry span status and breadcrumbs on tool failures.
- **Vitest unit test suite** covering transcript extraction, cost math, span attribute contract, config loading + env overrides, context auto-tagger smoke, and subagent lifecycle.
- **End-to-end smoke test** (`scripts/smoke-test.sh`) that starts a live collector, drives a synthetic 2-turn session with Bash and Task tool events, and verifies all POSTs return `{}`.

### Changed

- Forked from [sergical/claude-code-sentry-monitor](https://github.com/sergical/claude-code-sentry-monitor) — plugin slug renamed to `claude-code-ai-observability`; upstream remote preserved for optional PR-back.
- Config file path changed to `~/.config/claude-code/sentry-monitor.json` (`.jsonc` also supported with comment stripping).
- **Default collector port `19877`** (was `19876` in initial scaffold; clashes with upstream plugin's prod port). Override via `SENTRY_COLLECTOR_PORT`.
- **Cost calculator now bills `cache_creation_input_tokens` at the `cacheCreation` rate** (was previously billed at the plain `input` rate, under-pricing cache writes). Three-bucket pricing: raw input, cache-creation, cache-read each get their own rate.
- **`prices` field in the config file is now wired through** `ResolvedPluginConfig` and the price-table loader (was silently dropped). Documented precedence: defaults < env override < `prices` in config < direct API override.
- **Tool output is sanitized**: `gen_ai.tool.output` now passes through `serialize()` (key-based + value-pattern redaction) before reaching Sentry, instead of being attached verbatim. Bash output / file reads no longer leak secrets like API keys, Bearer tokens, JWTs, or credentials in URLs to span attributes.
- **Unified secret redactor**: the three previously-divergent redact lists in `serialize.ts`, `subagent.ts`, and `errors.ts` are consolidated into a single exported `scrubString` in `serialize.ts`. New patterns added: `Bearer`, `Basic`, `password=`/`token=`/`secret=` assignments, URI userinfo (`proto://user:pass@host`), Stripe `sk_live_`/`rk_live_`, modern GitHub tokens (`ghu_`/`ghs_`).

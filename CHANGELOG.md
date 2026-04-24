# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-04-24

### Added

- **Realtime-only collector** — dropped batch mode; all events are processed immediately via a local HTTP server that Claude Code hooks POST to.
- **Correct `gen_ai.chat` operation** on turn spans (upstream used `gen_ai.request`); Sentry's "Tokens Used" dashboard widget requires `gen_ai.chat` to aggregate correctly.
- **Per-turn token attributes** on `gen_ai.chat` spans: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.usage.input_tokens.cached` — extracted live from the session transcript at each turn boundary.
- **Subagent spans**: Task-tool invocations produce nested `gen_ai.invoke_agent` spans with `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name` set from `subagent_type`, and proper open/close lifecycle tied to `PreToolUse`/`PostToolUse` events.
- **USD cost calculation** per turn and session total (`gen_ai.usage.cost.input_tokens`, `cost.output_tokens`, `cost.total_tokens`) using a built-in price table for Opus/Sonnet/Haiku, with cached input priced at the `cacheRead` rate and an env-overridable price table (`CLAUDE_AIOBS_PRICE_OVERRIDES`).
- **Rich auto-tagging** on every span: `claude_code.session_id/session_name/version`, `vcs.repository.name/url`, `vcs.ref.head.name/revision`, `host.name`, `os.type`, `process.cwd`, `process.pid` — all detected non-blocking and cached once per session with graceful degradation when git/tmux are absent.
- **`PreCompact` and `Stop` hook support** — events are accepted and handled as no-ops so hooks never fail on these event types.
- **WSL2-safe health probes** — hook client uses `AbortSignal.timeout(500)` to avoid hanging on silently-dropped ports in WSL2 environments.
- **Tool error instrumentation** (`applyToolError`, `captureBreadcrumb`) sets Sentry span status and breadcrumbs on tool failures.
- **Vitest unit test suite** covering transcript extraction, cost math, span attribute contract, config loading + env overrides, context auto-tagger smoke, and subagent lifecycle.
- **End-to-end smoke test** (`scripts/smoke-test.sh`) that starts a live collector, drives a synthetic 2-turn session with Bash and Task tool events, and verifies all POSTs return `{}`.

### Changed

- Forked from [sergical/claude-code-sentry-monitor](https://github.com/sergical/claude-code-sentry-monitor) — plugin slug renamed to `claude-code-ai-observability`; upstream remote preserved for optional PR-back.
- Config file path changed to `~/.config/claude-code/sentry-monitor.json` (`.jsonc` also supported with comment stripping).

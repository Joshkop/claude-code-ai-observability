<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# src

## Purpose
TypeScript source for the observability plugin. Splits cleanly between the **hook client** (short-lived process spawned per Claude Code hook event) and the **collector server** (long-lived child process that owns the Sentry SDK and translates hook events into spans). Build output lands as sibling `.js` files in `scripts/`.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Collector entrypoint. Loads `@sentry/node`, calls `Sentry.init`, sets the OS user, starts the HTTP server. |
| `server.ts` | HTTP collector — accepts hook events on a local port, opens/closes turn transactions, emits tool/subagent spans, manages the PID file and stale-session eviction. |
| `hook-client.ts` | Hook-side process — reads stdin event JSON, probes the collector via `/health` (`AbortSignal.timeout(500)`), spawns the collector if absent, forwards the event. |
| `config.ts` | Loads `~/.config/claude-code/sentry-monitor.json` (+ `.jsonc`), merges env overrides (`CLAUDE_SENTRY_*`, `SENTRY_*`), applies defaults via `resolveDefaults`. |
| `context.ts` | Detects auto-tag context: session id/name, git remote/branch/sha, host/os/user, runtime, plugin version. All probes are non-blocking and cached per session. |
| `cost.ts` | Per-turn USD cost calculation. Built-in price table + `CLAUDE_AIOBS_PRICE_OVERRIDES` env / config `prices` overrides. Prices in USD per million tokens. |
| `errors.ts` | Tool-error capture — tags spans, records breadcrumbs, sets span status. |
| `plugin-meta.ts` | Constants: `CACHE_DIR`, `PID_FILE`, `PLUGIN_VERSION`, types `CollectorPidFile` / `CollectorHealth`. |
| `serialize.ts` | Truncates and stringifies span attributes to `maxAttributeLength`. |
| `spans.ts` | Sentry span helpers: `openTurnTransaction`, `closeTurnSpan`, `createToolSpan`. Implements the `gen_ai.invoke_agent` / `gen_ai.execute_tool` schema. |
| `subagent.ts` | Tracks Task-tool invocations, attaches nested `gen_ai.invoke_agent` subagent spans with `gen_ai.agent.name = subagent_type`. |
| `transcript.ts` | Parses the Claude Code transcript JSONL to extract per-turn token counts (input/output/total/cached/cache_write) and response model. |
| `types.ts` | Shared types for hook events (`SessionStartEvent`, `UserPromptSubmitEvent`, `PreToolUseEvent`, `PostToolUseEvent`, `SessionEndEvent`), config, auto-tags. |

## For AI Agents

### Working In This Directory
- Edits here require `npm run build` to take effect — the runtime loads compiled `scripts/*.js`.
- Keep imports using `.js` extensions (NodeNext ESM resolution) even for `.ts` siblings.
- Hot path is `hook-client.ts` → `server.ts`. The hook client must stay fast (sub-second) and never block Claude Code; the 500 ms health-probe timeout is load-bearing on WSL2.
- Per-turn semantics live in `spans.ts` + `server.ts`: a turn opens at `UserPromptSubmit` and closes at the next `UserPromptSubmit` or `SessionEnd`.

### Testing Requirements
- Every module has a sibling test in `tests/` (e.g. `cost.ts` ↔ `tests/cost.test.ts`). Add tests there when changing behavior.
- Type changes: run `tsc --noEmit` (or `npm run ci`).

### Common Patterns
- Defensive try/catch around all OS-level probes (`os.userInfo`, git, tmux) — degrade by omission, never throw into a hook.
- Sentry attributes follow OTel `gen_ai.*` namespaces; cross-reference attribute names against the README's "Auto-tag reference" / "gen_ai span attributes" tables before renaming.

## Dependencies

### Internal
- Compiled output consumed by `scripts/hook.sh` (which invokes `scripts/hook-client.js`).

### External
- `@sentry/node` — span/transaction APIs.
- Node built-ins: `node:http`, `node:fs`, `node:child_process`, `node:os`, `node:url`.

<!-- MANUAL: -->

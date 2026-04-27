<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# tests

## Purpose
Vitest suites mirroring the `src/` module layout. Each `*.test.ts` exercises one module; `server-*.test.ts` files split server coverage into endpoint behavior, lifecycle (start/stop/PID file), and stale-session eviction.

## Key Files
| File | Description |
|------|-------------|
| `config.test.ts` | Config file + env-var precedence, `.jsonc` parsing, defaults. |
| `context.test.ts` | Auto-tag detection (session id, git, host, os, user). |
| `cost.test.ts` | USD cost math, price-table override precedence. |
| `hook-client-units.test.ts` | Hook-client unit logic — health probe, spawn fallback, event forwarding. |
| `serialize.test.ts` | Attribute truncation / JSON serialization. |
| `server-endpoints.test.ts` | HTTP endpoint behavior (`/health`, event ingest). |
| `server-lifecycle.test.ts` | Collector start/stop, PID file write/cleanup. |
| `server-stale-session.test.ts` | Eviction when a previous collector left a stale PID or version mismatch. |
| `spans.test.ts` | Turn transaction + tool span shape, `gen_ai.*` attribute emission. |
| `subagent.test.ts` | Task-tool nested subagent span tracking. |
| `transcript.test.ts` | Per-turn token extraction from transcript JSONL. |

## For AI Agents

### Working In This Directory
- Test runner: `vitest` (no watch in CI). Use `npm test` to run all, `npx vitest run <file>` for a single suite.
- Tests import directly from `../src/*.ts` — no build step required to test.
- When adding a feature in `src/`, add the matching test here. Naming: `<src-module>.test.ts`.
- Server tests use ephemeral ports / temp dirs — never hard-code `19877` or `~/.cache/...`.

### Testing Requirements
- All tests must pass under `npm run ci` before release.

## Dependencies

### Internal
- `../src/*.ts` — modules under test.

### External
- `vitest` — test runner + assertions.

<!-- MANUAL: -->

<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# claude-code-ai-observability

## Purpose
Claude Code plugin that instruments sessions as realtime Sentry traces. Each user turn becomes a `gen_ai.invoke_agent` root transaction with per-turn token counts, USD cost, tool spans, subagent spans, and rich auto-tagging (session/git/host/OS). Forked from `sergical/claude-code-sentry-monitor`.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Root package — depends on `@sentry/node`, devDeps `vitest`/`typescript`. `postinstall` installs `scripts/` deps. |
| `tsconfig.json` | TypeScript config — compiles `src/` to `scripts/` as ES modules. |
| `README.md` | User-facing docs: install, config schema, env overrides, auto-tag reference, troubleshooting. |
| `CHANGELOG.md` | Per-version release notes. |
| `ATTRIBUTION.md` | Upstream fork credit. |
| `LICENSE` | MIT. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | TypeScript source — collector server, hook client, span/cost/transcript logic (see `src/AGENTS.md`). |
| `scripts/` | Compiled JS output + bash entrypoints (`hook.sh`, `doctor.sh`, `smoke-test.sh`) (see `scripts/AGENTS.md`). |
| `hooks/` | Claude Code hook registration manifest (see `hooks/AGENTS.md`). |
| `tests/` | Vitest suites mirroring `src/` modules (see `tests/AGENTS.md`). |
| `skills/` | Bundled setup skill invoked by users (see `skills/AGENTS.md`). |
| `.claude-plugin/` | Plugin manifest + marketplace metadata (see `.claude-plugin/AGENTS.md`). |
| `.github/` | CI workflows. |
| `.omc/` | Local oh-my-claudecode state — not part of the published plugin. |

## For AI Agents

### Working In This Directory
- Source of truth is `src/*.ts`. The compiled `scripts/*.js` siblings are build artifacts produced by `npm run build` (`tsc -p tsconfig.json`). Do **not** hand-edit JS in `scripts/` — edit the matching `.ts` and rebuild.
- `scripts/hook.sh`, `scripts/doctor.sh`, `scripts/smoke-test.sh`, `scripts/package.json`, `scripts/package-lock.json` are NOT generated — they are real source files committed in `scripts/`.
- The plugin is loaded from `${CLAUDE_PLUGIN_ROOT}` at session start; restart Claude Code after upgrades.

### Testing Requirements
- `npm test` — vitest run (no watch).
- `npm run build` — typecheck + emit JS.
- `npm run smoke` — end-to-end smoke test against a running collector.
- `npm run ci` — typecheck (`tsc --noEmit`) + tests + smoke. Run before release.

### Common Patterns
- ES modules (`"type": "module"`); imports use `.js` extensions even from `.ts` files.
- `@sentry/node` is loaded via `createRequire` in `src/index.ts` so the collector child process resolves it from `scripts/node_modules/`.
- All hook errors are swallowed and appended to `~/.cache/claude-code-ai-observability/hook.err.log` rather than crashing Claude Code.

## Dependencies

### External
- `@sentry/node` ^9 — runtime tracing SDK
- `typescript` ^5.8, `vitest` ^3 — dev only

<!-- MANUAL: -->

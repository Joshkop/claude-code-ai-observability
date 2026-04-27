<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# scripts

## Purpose
Runtime entrypoint directory. Mixes **hand-authored bash/JSON** (the user-facing entry surface) with **compiled JS output** from `src/` (the actual logic). Claude Code hooks invoke `hook.sh` from here; the postinstall step installs `@sentry/node` into this directory's `node_modules` so the spawned collector can resolve it.

## Key Files
| File | Description |
|------|-------------|
| `hook.sh` | **Source.** Bash entrypoint registered in `hooks/hooks.json`. Rotates `hook.err.log` past 1 MiB, lazy-installs deps on first run, pipes stdin event JSON into `node hook-client.js`. |
| `doctor.sh` | **Source.** Diagnostic CLI — probes collector health, checks DSN config, surfaces recent errors and stale PIDs. |
| `smoke-test.sh` | **Source.** End-to-end smoke harness used by `npm run smoke` / `npm run ci`. |
| `package.json` | **Source.** Declares `@sentry/node` runtime dep for the collector child process. |
| `package-lock.json` | **Source.** Committed lockfile for the runtime dep. |
| `hook-client.js` | Compiled from `src/hook-client.ts`. |
| `server.js` | Compiled from `src/server.ts`. |
| `index.js` | Compiled from `src/index.ts` — collector entrypoint spawned by the hook client. |
| `config.js` / `context.js` / `cost.js` / `errors.js` / `plugin-meta.js` / `serialize.js` / `spans.js` / `subagent.js` / `transcript.js` / `types.js` | Compiled from matching `src/*.ts`. |

## For AI Agents

### Working In This Directory
- **Do not edit `*.js` files here.** They are TypeScript build output. Edit `src/<name>.ts` and run `npm run build`.
- The `*.sh` files and `package.json` / `package-lock.json` ARE source — edit them in place.
- `hook.sh` runs once per Claude Code hook event; keep it minimal and POSIX bash. Heavy logic belongs in the Node process.
- The collector loads `@sentry/node` via `createRequire` against `scripts/node_modules/` — that's why this directory has its own `package.json`.

### Testing Requirements
- After editing `hook.sh` / `doctor.sh` / `smoke-test.sh`, run `npm run smoke`.
- `shellcheck` is recommended but not enforced.

### Common Patterns
- All bash uses `set -euo pipefail` and rotates/appends to `~/.cache/claude-code-ai-observability/*.log`.
- Errors are tolerated (`|| true`) so a failing hook never blocks Claude Code.

## Dependencies

### Internal
- Logic in `../src/` — compiled into this directory.

### External
- `@sentry/node` (installed into `scripts/node_modules/` via the root `postinstall`).

<!-- MANUAL: -->

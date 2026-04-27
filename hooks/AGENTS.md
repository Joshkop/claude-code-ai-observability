<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# hooks

## Purpose
Claude Code hook registration manifest. Wires every supported hook event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `PreCompact`, `Stop`) to `${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh`.

## Key Files
| File | Description |
|------|-------------|
| `hooks.json` | Hook registration. All events run async with 5 s timeout except `SessionStart` (10 s, allows collector spawn) and `SessionEnd` (60 s sync, allows final flush to Sentry). |

## For AI Agents

### Working In This Directory
- The single hook script (`scripts/hook.sh`) handles every event — dispatch happens inside the Node hook client based on the event JSON, not via separate bash scripts. Adding a new event type means adding it here AND teaching `src/server.ts` to handle it.
- `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code at load time and is captured per session — users must restart their session after a plugin upgrade.
- `SessionEnd` is intentionally **synchronous** so Sentry has time to flush in-flight spans before the process exits.

### Testing Requirements
- Manual: install the plugin, run a Claude Code session, confirm hooks fire (check `hook.err.log` for the absence of errors).

## Dependencies

### Internal
- `../scripts/hook.sh` — the dispatched command.

<!-- MANUAL: -->

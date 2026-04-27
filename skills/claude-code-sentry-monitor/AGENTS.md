<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# claude-code-sentry-monitor

## Purpose
Interactive setup wizard skill. Triggered by phrases like "set up Sentry monitoring" or "instrument Claude Code". Detects and cleans up any legacy `sergical/claude-code-sentry-monitor` install, prompts for DSN + preferences, writes the global config to `~/.config/claude-code/sentry-monitor.json`, and runs `scripts/doctor.sh` to verify.

## Key Files
| File | Description |
|------|-------------|
| `SKILL.md` | Skill prompt with frontmatter (name/description/triggers) and the step-by-step wizard instructions Claude follows. |

## For AI Agents

### Working In This Directory
- Config lives at `~/.config/claude-code/sentry-monitor.json` (machine-global, not per-project).
- Migration cleanup must kill any leftover collector on port 19876 (upstream's port — current plugin uses 19877) and wipe `~/.cache/claude-code-sentry-monitor/`.
- The wizard is destructive on the legacy directory only; never touch `~/.cache/claude-code-ai-observability/` (current plugin's cache).

## Dependencies

### Internal
- `../../scripts/doctor.sh` — runs at the end of the wizard.

<!-- MANUAL: -->

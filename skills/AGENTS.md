<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-04-27 | Updated: 2026-04-27 -->

# skills

## Purpose
Bundled Claude Code skills shipped with the plugin. Currently houses one interactive setup wizard.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `claude-code-sentry-monitor/` | Setup wizard skill — collects DSN, writes `~/.config/claude-code/sentry-monitor.json`, runs the doctor (see `claude-code-sentry-monitor/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Skills are markdown files with frontmatter; Claude Code auto-discovers them when the plugin is installed.
- The skill `name`, `description`, and trigger phrases in `SKILL.md` are how users invoke it ("set up Sentry monitoring").

<!-- MANUAL: -->

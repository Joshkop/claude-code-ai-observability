# claude-code-ai-observability

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Plugin for Claude Code](https://img.shields.io/badge/claude--code-plugin-blueviolet)](https://github.com/anthropics/claude-code)

Comprehensive AI Agent Observability plugin for Claude Code. Sends realtime OpenTelemetry-style traces to Sentry: each user turn (UserPromptSubmit → next prompt or SessionEnd) becomes its own `gen_ai.invoke_agent` root transaction with per-turn token counts and USD cost, each tool call a `gen_ai.execute_tool` child span, and Task-tool invocations nested `gen_ai.invoke_agent` subagent spans. Turns from the same session are correlated by the `claude_code.session_id` tag — filter or group by it in Sentry to aggregate session totals. Auto-tags every trace with session, git, host, and OS context so you get actionable observability out of the box with no configuration beyond a DSN.

## What it adds over upstream

- Per-turn root transactions: every UserPromptSubmit opens a fresh `gen_ai.invoke_agent` transaction, so traces appear in Sentry within seconds of a turn finishing instead of waiting for the whole session to end.
- Per-turn token attributes (`gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `input_tokens.cached`) extracted from the live transcript and attached directly to the turn transaction.
- Subagent spans: Task-tool invocations produce nested `gen_ai.invoke_agent` spans with `gen_ai.agent.name` set from `subagent_type`.
- USD cost calculation per turn (`gen_ai.usage.cost.*`) with env-overridable price table.
- Rich auto-tagging on every span: session ID/name, git branch/SHA/remote URL, hostname, OS, cwd, PID.
- `PreCompact` and `Stop` hooks handled gracefully (no-op, no crash).
- WSL2-safe health probes: the hook client uses `AbortSignal.timeout(500)` to avoid hanging on silently-dropped ports.

## Install

### Claude Code plugin marketplace

```
/plugin marketplace add Joshkop/claude-code-ai-observability
/plugin install claude-code-ai-observability
```

### Manual install

```bash
git clone https://github.com/Joshkop/claude-code-ai-observability
cd claude-code-ai-observability
npm install
```

Then register the hooks in your Claude Code settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart":     [{ "command": "node /path/to/scripts/hook.sh SessionStart" }],
    "UserPromptSubmit": [{ "command": "node /path/to/scripts/hook.sh UserPromptSubmit" }],
    "PreToolUse":       [{ "command": "node /path/to/scripts/hook.sh PreToolUse" }],
    "PostToolUse":      [{ "command": "node /path/to/scripts/hook.sh PostToolUse" }],
    "SessionEnd":       [{ "command": "node /path/to/scripts/hook.sh SessionEnd" }]
  }
}
```

## Configuration

Create `~/.config/claude-code/sentry-monitor.json` (or `.jsonc` for comments):

```json
{
  "dsn": "https://<key>@o<org>.ingest.sentry.io/<project>",
  "environment": "local",
  "tracesSampleRate": 1.0,
  "recordInputs": true,
  "recordOutputs": false,
  "maxAttributeLength": 12000,
  "tags": {
    "team": "my-team"
  }
}
```

### Config schema

| Field | Type | Default | Description |
|---|---|---|---|
| `dsn` | string | **required** | Sentry DSN for your project |
| `environment` | string | — | Sentry environment tag (e.g. `"local"`, `"production"`) |
| `release` | string | — | Sentry release tag |
| `tracesSampleRate` | number | `1.0` | OTel sample rate (0–1) |
| `debug` | boolean | `false` | Enable Sentry SDK debug logging |
| `recordInputs` | boolean | `true` | Attach user prompt text to `gen_ai.request.messages` span attribute |
| `recordOutputs` | boolean | `true` | Attach assistant response text to `gen_ai.response.text` span attribute |
| `maxAttributeLength` | number | `12000` | Truncate span attribute values to this many characters |
| `tags` | object | `{}` | Extra key/value string tags applied to every span |

## Environment variable overrides

All env vars take precedence over the config file.

| Variable | Overrides |
|---|---|
| `CLAUDE_SENTRY_DSN` | `dsn` |
| `SENTRY_DSN` | `dsn` (lower priority than `CLAUDE_SENTRY_DSN`) |
| `CLAUDE_SENTRY_ENVIRONMENT` | `environment` |
| `SENTRY_ENVIRONMENT` | `environment` (lower priority) |
| `CLAUDE_SENTRY_RELEASE` | `release` |
| `SENTRY_RELEASE` | `release` (lower priority) |
| `CLAUDE_SENTRY_TRACES_SAMPLE_RATE` | `tracesSampleRate` |
| `CLAUDE_SENTRY_DEBUG` | `debug` |
| `CLAUDE_SENTRY_RECORD_INPUTS` | `recordInputs` |
| `CLAUDE_SENTRY_RECORD_OUTPUTS` | `recordOutputs` |
| `CLAUDE_SENTRY_MAX_ATTRIBUTE_LENGTH` | `maxAttributeLength` |
| `CLAUDE_SENTRY_TAGS` | Merges into `tags` (format: `key1:val1,key2:val2`) |
| `CLAUDE_SENTRY_CONFIG` | Path to config file (overrides default search) |
| `SENTRY_COLLECTOR_PORT` | Port the local collector listens on (default `19877`) |
| `CLAUDE_AIOBS_PRICE_OVERRIDES` | JSON price table merged over defaults (see Cost section) |

## Auto-tag reference

These attributes are applied to every per-turn root transaction and inherited by its child tool spans. Filter or group by `claude_code.session_id` in Sentry to aggregate across all turns of a session.

| Attribute | Source |
|---|---|
| `claude_code.session_id` | Hook event `session_id` field |
| `claude_code.session_name` | `CLAUDE_SESSION_NAME` env → tmux `display-message -p "#S"` → screen `$STY` |
| `claude_code.version` | `CLAUDE_CODE_VERSION` env → `claude --version` |
| `vcs.repository.name` | Derived from `git remote get-url origin` |
| `vcs.repository.url` | `git remote get-url origin` (SSH URLs normalised to HTTPS) |
| `vcs.ref.head.name` | `git rev-parse --abbrev-ref HEAD` |
| `vcs.ref.head.revision` | `git rev-parse --short=12 HEAD` |
| `host.name` | `os.hostname()` |
| `os.type` | `os.platform()` |
| `process.cwd` | `process.cwd()` |
| `process.pid` | `process.pid` |

All detections are non-blocking and cached once per session. Missing tools (git, tmux) degrade gracefully — the attribute is simply omitted.

## Cost calculation

Per-turn USD cost is calculated from the transcript token counts using a built-in price table (Opus, Sonnet, Haiku) and attached to each turn transaction as `gen_ai.usage.cost.*`. Session totals are aggregated in Sentry by grouping on `claude_code.session_id`. The three input buckets are priced separately:
- raw input tokens at the `input` rate,
- `cache_creation_input_tokens` at the `cacheCreation` rate,
- `cache_read_input_tokens` at the `cacheRead` rate.

To add or override model prices, set `CLAUDE_AIOBS_PRICE_OVERRIDES` (env) **or** `prices` in your config file:

```bash
export CLAUDE_AIOBS_PRICE_OVERRIDES='{"my-custom-model":{"input":3,"cacheCreation":3.75,"cacheRead":0.3,"output":15}}'
```

```jsonc
{
  "dsn": "...",
  "prices": {
    "my-custom-model": {"input":3,"cacheCreation":3.75,"cacheRead":0.3,"output":15}
  }
}
```

Prices are in USD per million tokens. Precedence: built-in defaults < env override < `prices` in config file < direct API overrides.

## Sentry dashboard setup

See the official [Sentry AI Agents monitoring docs](https://docs.sentry.io/product/insights/agents/) for dashboard setup.

The **"Tokens Used"** widget in the AI Agents view aggregates `gen_ai.usage.*` attributes across `gen_ai.invoke_agent` spans. This plugin emits all token attributes (`gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `input_tokens.cached`) on every per-turn `gen_ai.invoke_agent` transaction, and tags each one with `claude_code.session_id` so you can filter or group by session.

## Troubleshooting

**No traces appearing in Sentry**
- Check the collector is running: `curl http://localhost:19877/health` should return `ok`.
- Verify your DSN is set correctly in the config file or `CLAUDE_SENTRY_DSN`.
- Enable debug logging: set `"debug": true` in config or `CLAUDE_SENTRY_DEBUG=true`.

**WSL2 port conflict**
- The default port `19877` may collide with another process in WSL2.
- Set `SENTRY_COLLECTOR_PORT=<free-port>` in your shell profile and the hooks will use it.

**Hook timeout / Claude hangs briefly**
- The hook client uses `AbortSignal.timeout(500)` on all health probes, so a silently-dropped port will abort within 500 ms instead of hanging through the OS TCP timeout.
- If hooks are consistently slow, ensure the collector process started (`SessionStart` hook must fire first).

## Attribution

Forked from [sergical/claude-code-sentry-monitor](https://github.com/sergical/claude-code-sentry-monitor) (MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md).

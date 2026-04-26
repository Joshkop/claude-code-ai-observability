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

These attributes are applied to every per-turn root transaction and inherited by its child tool spans. Filter or group by `gen_ai.conversation.id` (or `claude_code.session_id`) in Sentry to aggregate across all turns of a session; filter by `user.username`, `service.version`, `vcs.ref.head.name`, or `host.name` to slice traces by developer, plugin version, branch, or machine.

| Attribute | Source |
|---|---|
| `claude_code.session_id` | Hook event `session_id` field |
| `claude_code.session_name` | `CLAUDE_SESSION_NAME` env → tmux `display-message -p "#S"` → screen `$STY` |
| `claude_code.version` | `CLAUDE_CODE_VERSION` env → `claude --version` |
| `gen_ai.conversation.id` | Same as `claude_code.session_id` — OTel-spec name Sentry's AI Agents list groups by |
| `vcs.repository.name` | Derived from `git remote get-url origin` |
| `vcs.repository.url` | `git remote get-url origin` (SSH URLs normalised to HTTPS) |
| `vcs.ref.head.name` | `git rev-parse --abbrev-ref HEAD` |
| `vcs.ref.head.revision` | `git rev-parse --short=12 HEAD` |
| `service.name` | Hard-coded `claude-code-ai-observability` |
| `service.version` | Plugin version from `.claude-plugin/plugin.json` |
| `host.name` | `os.hostname()` |
| `host.arch` | `os.arch()` |
| `os.type` | `os.platform()` |
| `os.version` | `os.release()` |
| `user.username` | `os.userInfo().username` (also set on Sentry's first-class user scope via `Sentry.setUser`) |
| `user.id` | `os.userInfo().uid` (numeric uid, stringified) |
| `process.cwd` | `process.cwd()` |
| `process.pid` | `process.pid` |
| `process.runtime.name` | Hard-coded `node` |
| `process.runtime.version` | `process.version` |
| `process.executable.path` | `process.execPath` |

All detections are non-blocking and cached once per session. Missing tools (git, tmux) and sandboxes without uid mappings degrade gracefully — the attribute is simply omitted.

### gen_ai span attributes

Per-turn `gen_ai.invoke_agent` transactions also carry these Sentry-recognized AI attributes:

| Attribute | Notes |
|---|---|
| `gen_ai.operation.name` | `invoke_agent` on turn spans, `execute_tool` on tool spans |
| `gen_ai.provider.name` | `anthropic` (Sentry's preferred attribute; `gen_ai.system` is dual-emitted for older SDKs) |
| `gen_ai.agent.name` | `claude-code` on turn spans; `subagent_type` on subagent spans |
| `gen_ai.request.model` | Model from the `SessionStart` hook |
| `gen_ai.response.model` | Model from the assistant turn in the transcript |
| `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` | Per-turn from the transcript |
| `gen_ai.usage.input_tokens.cached` | Anthropic cache-read tokens (Sentry's `GEN_AI_USAGE_INPUT_TOKENS_CACHED`) |
| `gen_ai.usage.input_tokens.cache_write` | Anthropic cache-write tokens (Sentry's `GEN_AI_USAGE_INPUT_TOKENS_CACHE_WRITE`) |
| `conversation.cost_estimate_usd` | Per-turn USD cost rollup (Sentry manual-monitoring example pattern) |
| `gen_ai.tool.name` / `gen_ai.tool.type` / `gen_ai.tool.call.id` | On `gen_ai.execute_tool` spans; `tool.call.id` is Claude Code's `tool_use_id` |

## Cost calculation

Per-turn USD cost is calculated from the transcript token counts using a built-in price table (Opus, Sonnet, Haiku) and attached to each turn transaction as `conversation.cost_estimate_usd` — a single rollup attribute that matches Sentry's manual-monitoring example. Session totals are aggregated in Sentry by grouping on `gen_ai.conversation.id` (or the equivalent `claude_code.session_id`). The three input buckets are priced separately:
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

Run `bash scripts/doctor.sh` to diagnose common issues. It probes the collector, checks your DSN config, and reports recent errors.

**No data in new sessions / stale collector squatting on port**

Symptom: Traces don't appear, or you see "collector not running" in the doctor output.

Diagnosis: Run `bash scripts/doctor.sh` and check "Collector Status" and "Recent Collector Errors". If you see a stale PID or address-already-in-use error, the old collector process is still listening.

Fix: Kill the old process by PID (shown in doctor output or `~/.cache/claude-code-ai-observability/collector.pid`), then start a new Claude session. The hook will respawn the collector automatically.

```bash
bash scripts/doctor.sh
kill $(cat ~/.cache/claude-code-ai-observability/collector.pid 2>/dev/null) 2>/dev/null || true
```

Note: v0.1.2+ automatically evicts stale collectors via version-mismatch detection; older versions did not.

**Hooks silently fail / no traces appearing**

Symptom: Claude sessions start but no trace events reach Sentry.

Diagnosis: Check hook errors and collector logs.

```bash
tail -20 ~/.cache/claude-code-ai-observability/hook.err.log
tail -20 ~/.cache/claude-code-ai-observability/collector.err.log
```

Common causes: DSN not set, collector crashed, port collision, or network issue reaching Sentry. Run `bash scripts/doctor.sh` for the full diagnostic.

**Port collision (EADDRINUSE)**

Symptom: Collector fails to start, logs show "address already in use" at port 19877.

Diagnosis: Another process is using the default port. Run `bash scripts/doctor.sh` and check "Listening Process".

Fix: Set a different port in your shell profile or `~/.claude/settings.json`:

```bash
export SENTRY_COLLECTOR_PORT=19878
```

Or via settings.json:

```json
{
  "env": {
    "SENTRY_COLLECTOR_PORT": "19878"
  }
}
```

**DSN not configured**

Symptom: Doctor output shows "no DSN configured".

Diagnosis: The plugin cannot find your Sentry credentials.

Fix: Create a config file at `~/.config/claude-code/sentry-monitor.json`:

```json
{
  "dsn": "https://<key>@o<org>.ingest.sentry.io/<project>",
  "tracesSampleRate": 1
}
```

Or set the env var: `export CLAUDE_SENTRY_DSN=https://...`

**Plugin upgraded but old behavior persists**

Symptom: You upgraded the plugin but traces still look different, or old log messages appear.

Diagnosis: `CLAUDE_PLUGIN_ROOT` is captured at session start and doesn't auto-reload.

Fix: Close your terminal and open a new Claude session. The hook will load the new plugin code.

```bash
# Old session (restart it)
exit

# New terminal
claude
```

## Attribution

Forked from [sergical/claude-code-sentry-monitor](https://github.com/sergical/claude-code-sentry-monitor) (MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md).

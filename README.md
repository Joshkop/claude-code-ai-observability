# claude-code-ai-observability

Comprehensive AI Agent Observability plugin for Claude Code. Sends realtime OpenTelemetry traces to Sentry with per-turn token counts, USD cost, subagent spans, error instrumentation, and rich auto-tagging (session / git / host).

## What this is

This plugin hooks into Claude Code's hook system to emit structured Sentry traces for every session. Each session becomes a root `gen_ai.invoke_agent` transaction; each user turn becomes a `gen_ai.chat` span with token and cost attributes; each tool call becomes a `gen_ai.execute_tool` span. Subagent invocations (Task tool) are represented as nested `gen_ai.invoke_agent` spans.

Forked from [sergical/claude-code-sentry-monitor](https://github.com/sergical/claude-code-sentry-monitor) (MIT). See [ATTRIBUTION.md](./ATTRIBUTION.md).

## Install

Add to your Claude Code marketplace config:

```
/plugin marketplace add Joshkop/claude-code-ai-observability
/plugin install claude-code-ai-observability
```

Dependencies auto-install on first hook invocation.

## Configuration

Create `~/.config/claude-code/sentry-monitor.json`:

```json
{
  "dsn": "https://<key>@o<org>.ingest.sentry.io/<project>",
  "environment": "local",
  "tracesSampleRate": 1.0,
  "recordInputs": true,
  "recordOutputs": false
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `dsn` | string | required | Sentry DSN |
| `environment` | string | — | Sentry environment tag |
| `tracesSampleRate` | number | `1.0` | OTel sample rate (0–1) |
| `recordInputs` | boolean | `true` | Attach user prompt text to spans |
| `recordOutputs` | boolean | `true` | Attach assistant response text to spans |
| `maxAttributeLength` | number | `12000` | Truncate span attribute values |

Environment variable overrides: `CLAUDE_SENTRY_DSN`, `CLAUDE_SENTRY_MODE`, `CLAUDE_AIOBS_PRICE_OVERRIDES`.

## Sentry AI Agent Monitoring docs

https://develop.sentry.dev/sdk/telemetry/traces/modules/ai-agents/

## Troubleshooting

_Detailed troubleshooting and advanced configuration will be added in a future update._

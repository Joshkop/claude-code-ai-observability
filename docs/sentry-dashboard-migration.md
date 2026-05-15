# Sentry Dashboard Migration — v0.2.0

v0.2.0 corrects two long-standing inaccuracies **in place** (no parallel
`_v2` attributes). Existing dashboards keep working but show **shifted,
now-correct** numbers. Rebuild cost/token panels using the queries below.

## What changed (behavior)

- **C1 — turn segmentation.** Per-turn token/cost is no longer mis-sliced by
  tool-result user lines. Per-turn totals differ from pre-0.2.0; session
  totals are unchanged in aggregate but correctly distributed.
- **C2 — token semantics.** `gen_ai.usage.input_tokens` is now **non-cached
  input only**. Cache read/write are reported separately:
  - `gen_ai.usage.input_tokens` = non-cached input
  - `gen_ai.usage.input_tokens.cached` = cache-read
  - `gen_ai.usage.input_tokens.cache_write` = cache-creation
  - `gen_ai.usage.total_tokens` = sum of all four buckets
  Sentry's server-side cost + "Tokens Used" widget no longer double-count.

## Updated queries / widgets

| Panel | Old | New |
|-------|-----|-----|
| Tokens Used | `sum(gen_ai.usage.input_tokens)` on `op:gen_ai.chat` (cache double-counted) | same query — value now excludes cache; add `gen_ai.usage.input_tokens.cached` + `.cache_write` series for the full picture |
| Cost (plugin) | `sum(conversation.cost_estimate_usd)` on `op:gen_ai.invoke_agent` | unchanged query; now correct per turn |
| Unpriced models | n/a | `has:claude_code.cost.unpriced_model` → group by `claude_code.cost.unpriced_model` |
| Parse degraded | n/a | `has:claude_code.transcript.parse_degraded` (alert if > 0) |
| Synthesized sessions | n/a | `has:claude_code.session.synthesized` |

## New attributes (additive — no breakage)

- N1: `gen_ai.tool.mcp.server`, `gen_ai.tool.mcp.name`, `claude_code.tool.source`
- N2: `claude_code.skill.name`, `claude_code.skill.plugin`,
  `claude_code.command.name`, `claude_code.command.plugin`
- N3: `claude_code.subagent.source` (`built-in|user|project|plugin:<name>|unknown`),
  `claude_code.subagent.source_inferred`, `claude_code.subagent.name`,
  `claude_code.subagent.description`, `claude_code.subagent.depth`,
  `claude_code.subagent.duration_ms`, `claude_code.subagent.error`
- N4: `claude_code.permission_mode`, `claude_code.agent_name`,
  `claude_code.entrypoint`
- R3/R4: `claude_code.dropped_since_last`,
  `claude_code.collector.heartbeat` (+ `claude_code.collector.sessions_active`,
  `claude_code.collector.uptime_s`, `claude_code.collector.version`,
  `claude_code.collector.dropped_total`)

Filter `claude_code.subagent.source_inferred:true` to discount best-effort
plugin attribution.

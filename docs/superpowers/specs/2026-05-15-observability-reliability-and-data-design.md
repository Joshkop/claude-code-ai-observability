# Observability Reliability & Data Design

**Date:** 2026-05-15
**Status:** Approved (pending spec review)
**Scope:** Correctness fixes + reliability hardening + new data dimensions, one spec, one release.

## Problem

The `claude-code-ai-observability` plugin streams per-turn `gen_ai.invoke_agent`
transactions to Sentry. Investigation surfaced concrete defects and gaps:

1. **Per-turn token/cost misattribution (severe).** `extractPerTurnTokens`
   starts a new turn on *every* `type:"user"` transcript line. In Claude Code
   transcripts, tool results are user-role messages, so one prompt with N tool
   calls yields many phantom turns. The collector increments `turnIndex` once
   per `UserPromptSubmit` then reads `turns[turnIndex]` — the two indexes drift.
   Measured: one real transcript had 148 user lines, ~18 real prompts, 130
   `tool_result`. Per-turn tokens and USD cost are attributed to the wrong slice.
2. **Cost silently zero on model mismatch.** `computeCost` requires an exact
   price-table key. Any model string not exactly matching → cost `0`, no signal.
3. **Token semantics vs Sentry schema.** `inputTokens` is emitted as raw +
   cache-read + cache-write summed, while `input_tokens.cached` is *also*
   emitted. Sentry's server-side cost and "Tokens Used" widget double-count.
4. **Cross-session subagent misattribution.** `findActiveSubagentSpan` ignores
   `session_id` and returns the most recent wrapper from a collector-global map.
   Two concurrent sessions cross-wire tool nesting.
5. **Parallel-subagent transcript matching is heuristic.** Sidechain usage is
   matched by mtime + `agentType`. N same-type subagents in parallel (the common
   dispatch pattern) get mis-assigned.
6. **Per-session git/cwd inaccuracy.** `detectContext` runs git in the
   collector's `process.cwd()`. Worktree/multi-repo sessions get the wrong
   branch/repo. The correct `cwd`/`gitBranch` is per-line in the transcript and
   in the hook payload.
7. **Fire-and-forget delivery.** 500ms timeout, no retry, no buffer. Dropped
   events vanish silently. If `SessionStart` is missed, whole turns are dropped
   because `sessions.get()` misses and the handlers `return`.
8. **No plugin/MCP/skill/command attribution.** Usage analytics impossible.

## Goals

Co-equal: accurate cost attribution, agent/plugin usage analytics, and
self-reliability. One spec, one release, internally sequenced
correctness → reliability → new data.

## Architecture (Approach C — Hybrid)

Hooks remain the realtime trigger + timing + delivery layer. A new
`transcript-reader` module becomes the single authority for turn segmentation,
token aggregation, and sidechain isolation. `server.ts` shrinks to: own
sessions, react to hooks, request the current turn's numbers at turn-close,
emit spans. It no longer does token math or positional indexing.

```
hook-client ──events──▶ collector (server.ts)
                              │  triggers + timing + delivery only
                              ▼
                     transcript-reader.ts   ◀── turn segmentation,
                              │                  token aggregation,
                              │                  sidechain isolation
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          cost.ts        attribution.ts    spans.ts
        (model match)   (plugin/mcp/skill)  (emit)
```

`transcript.ts`'s `extractPerTurnTokens` and the positional indexing in
`server.ts` are replaced by `transcript-reader`. `extractSidechainUsage` is
retained but moved/owned by `transcript-reader`.

## Correctness fixes

### C1 — Turn segmentation & alignment

A real-turn boundary is: `type:"user"` **AND** message content is **not** a
`tool_result` block **AND** `isSidechain !== true`. Each real user line carries
a `promptId`; `transcript-reader` keys turns by `promptId`. The collector
correlates its open turn to the transcript turn by `promptId` from the
`UserPromptSubmit` payload; fallback is ordinal **among real turns** (never
among all `type:"user"` lines). Eliminates the index drift in defect #1.

### C2 — Token semantics vs Sentry schema

Emit Sentry's expected shape:

- `gen_ai.usage.input_tokens` = **non-cached input only**
- `gen_ai.usage.input_tokens.cached` = cache-read tokens
- `gen_ai.usage.input_tokens.cache_write` = cache-creation tokens
- `gen_ai.usage.output_tokens` = output tokens as-is
- `gen_ai.usage.total_tokens` = sum of all four buckets

Internal cost math keeps the three input buckets explicit (already does).
This is a **behavior change**: existing dashboards' token/cost values shift to
correct values. Documented in CHANGELOG + README migration note.

### C3 — Cost model matching

Resolution order: exact key → normalized prefix match (strip trailing date
suffix, e.g. `claude-opus-4-7-20260101` → `claude-opus-4-7`) → family heuristic
(`*opus*` / `*sonnet*` / `*haiku*` map to the corresponding default entry) →
unpriced. When unpriced: cost stays `0` **and** the turn span gets
`claude_code.cost.unpriced_model = <model string>` so it is queryable.

### C4 — Per-session git/cwd accuracy

Derive the session `cwd` from the hook event (`_aiobs.context.cwd`, also per
transcript line). Run git detection against the **session's** cwd, not
`process.cwd()`. Cache keyed by `session_id`, not per collector process.

### C5 — Parallel-subagent matching

Correlate a sidechain transcript to its `Task`/`Agent` invocation by matching
the subagent `.meta.json` `name` + `description` against the captured tool_input
(`description` / `prompt`) at PreToolUse. mtime and `agentType` become
tiebreakers only. Removes mis-assignment when N same-type agents run parallel.

### C6 — Soft-fail transcript parsing

`transcript-reader` validates the JSONL shape it depends on (`promptId`,
`isSidechain`, `tool_result` content, `.meta.json` keys, metadata line types).
On an unrecognized/incompatible shape it does **not** silently emit wrong
numbers: it falls back to the legacy positional behavior and sets
`claude_code.transcript.parse_degraded = true` on affected turn spans (with a
breadcrumb naming the failing expectation). Makes Claude Code JSONL format
drift visible instead of silently corrupting accuracy.

## Reliability (Best-effort++)

### R1 — Retry-once + longer timeout

`sendHookEvent` retries once on failure/timeout; per-attempt timeout raised
500ms → 1000ms. The detached hook process performs the retry; Claude Code is
never blocked.

### R2 — Lazy session creation

`handleUserPrompt` / `handlePreTool` / `handlePostTool` no longer `return`
silently on a `sessions.get()` miss. They lazily construct a minimal
`SessionRecord` from the event (`session_id`, `transcript_path`, `cwd`) and set
`claude_code.session.synthesized = true` on resulting spans so synthesized
sessions are distinguishable. Eliminates whole-session blackouts when
`SessionStart` is missed or the collector spawns mid-session.

### R3 — Dropped-event self-metric

When both POST attempts fail, the hook-client increments a counter file under
`CACHE_DIR`. The pending count is piggybacked on the next successful event as
`_aiobs.dropped_since_last`. The collector emits it as a span attribute and a
breadcrumb. Loss becomes observable.

### R4 — Collector self-health to Sentry

On the existing flush tick, the collector emits a low-volume
`claude_code.collector.heartbeat` span carrying `sessions_active`, `uptime_s`,
`version`, `dropped_total`. Complements the existing `claude_code.plugin_error`
path; answers "is it running / how lossy" from Sentry alone.

No durable spool, no ack protocol — out of scope per the chosen guarantee level.

## New data dimensions

Split by what Claude Code actually exposes (verified against real transcripts
and hook payloads on 2026-05-15).

### N1 — MCP server attribution (reliable)

Tool names `mcp__<server>__<tool>` parse to:
`gen_ai.tool.mcp.server`, `gen_ai.tool.mcp.name`,
`claude_code.tool.source = "mcp"`. Applied on every tool span.

### N2 — Skill & slash-command attribution (reliable when namespaced)

The `Skill` tool input carries the skill name; a namespaced name
(`plugin:skill`) yields `claude_code.skill.name` + `claude_code.skill.plugin`.
Slash commands in the `UserPromptSubmit` prompt (`/[plugin:]command`) parse to
`claude_code.command.name` + `claude_code.command.plugin` on the turn span.
Bare/un-namespaced → plugin attribute omitted (not guessed).

### N3 — Subagent telemetry + source-class

Per-subagent wrapper span gains: `gen_ai.agent.name` (type),
`claude_code.subagent.name`, `claude_code.subagent.description` (from
`.meta.json`), tool count, duration, error flag, model, and
`claude_code.subagent.depth` (nesting level), plus parent linkage.
`claude_code.subagent.source = built-in | user | project | plugin:<name> |
unknown`. Derivation order:

1. Namespace in `subagent_type` / agent name (`plugin:agent`), if present.
2. **Best-effort path inference:** resolve the agent definition file and test
   whether it lives under a known plugin directory
   (`~/.claude/plugins/**/<plugin>/agents/`, project `.claude/agents/`, user
   `~/.claude/agents/`). The matched plugin/scope sets `source`.
3. Otherwise `unknown`.

When inference is used the span also carries
`claude_code.subagent.source_inferred = true` so heuristic values are
distinguishable from authoritative ones. Inference is explicitly best-effort:
it may yield `unknown` or, rarely, a wrong plugin on non-standard layouts —
the `source_inferred` flag exists precisely so consumers can discount it.

### N4 — Cheap session dimensions

From transcript metadata lines: `claude_code.permission_mode` (e.g.
`bypassPermissions`), `claude_code.agent_name` (session's own agent name),
`claude_code.entrypoint`. Tagged on the turn span.

### N5 — Per-session subagent isolation + nested parenting

Active subagents are keyed per `session_id` (fixes defect #4). A nested
subagent wrapper parents to its enclosing subagent wrapper for that session,
not unconditionally to the turn span.

## Testing strategy

TDD: every correctness fix gets a failing test encoding the bug first.

- **`transcript-reader.test.ts`** (new) — fixtures: many-`tool_result` turn,
  sidechain-mixed file, `promptId`-keyed multi-turn, parallel same-type
  subagents. Asserts turn count = real prompts and tokens land on the right
  turn. Primary regression gate for defect #1.
- **`cost.test.ts`** — extend: exact, date-suffixed prefix, family heuristic,
  unpriced → `unpriced_model` set + `0` cost.
- **`attribution.test.ts`** (new) — `mcp__a__b` parse; namespaced vs bare
  skill/command; subagent source-class incl. `unknown` path.
- **`subagent.test.ts`** — extend: parallel same-type matching via
  name/description; per-session isolation (two sessions, no cross-nest);
  nested depth.
- **`hook-client-units.test.ts`** — retry-once (fetch fail→ok); dropped-counter
  round-trip.
- **`server-*.test.ts`** — lazy-session synthesis sets
  `session.synthesized`; heartbeat emission.
- **token-semantics** assertion — emitted `input_tokens` excludes
  cached/cache-write; `total_tokens` = full sum.
- **C6 soft-fail** — malformed/unknown JSONL fixture → legacy fallback engaged
  + `transcript.parse_degraded` set; well-formed fixture → flag absent.
- **attribution.test.ts** also covers best-effort plugin path inference:
  agent file under a plugin dir → `source = plugin:<name>` +
  `source_inferred = true`; non-standard layout → `unknown`.

## Rollout & back-compat

- **Behavior change callout:** C1 + C2 change the numbers existing dashboards
  show (corrected, but shifted). Values are corrected **in place** (no
  parallel `_v2` attributes). CHANGELOG gets an explicit note; README gets a
  migration paragraph. Minor version bump.
- **Dashboard migration guide** (new deliverable):
  `docs/sentry-dashboard-migration.md` — the corrected attribute semantics,
  updated Sentry queries/widget definitions for cost & token panels, and the
  new attributes (N1–N5) so dashboards can be rebuilt quickly post-upgrade.
- **Additive** (N1–N5, R3–R4) — no dashboard breakage.
- **Single release**, sequenced internally correctness → reliability → new
  data, each layer independently revertable by commit.
- **No config schema changes.**

## Out of scope

Durable spool / ack-based delivery; OTLP or non-Sentry export; historical
backfill of corrected numbers; config UI; a prompt-recording toggle;
**authoritative** subagent→plugin attribution (Claude Code exposes no such
field — only best-effort path inference per N3, flagged `source_inferred`).

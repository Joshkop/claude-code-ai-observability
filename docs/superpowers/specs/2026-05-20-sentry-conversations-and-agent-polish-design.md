# Sentry Conversations + Agent Naming/Cost/Sampling Polish

**Date:** 2026-05-20
**Status:** Draft (pending user review)
**Scope:** Adopt Sentry's new Conversations feature end-to-end and close the
remaining gaps surfaced by `docs.sentry.io/ai/monitoring/agents/{naming,costs,sampling}`.
One spec, one release.

## Problem

Sentry shipped the **Conversations** view, which groups spans by the
`gen_ai.conversation.id` attribute and surfaces per-conversation cost, LLM
call count, tool count, first user message, and most recent assistant
response. The `claude-code-ai-observability` collector already emits
`gen_ai.conversation.id` on the turn root and its synthesized chat child,
but several adjacent spans are missing the attribute, and a few naming /
cost details flagged in Sentry's docs are not yet in the pipeline.

Concrete gaps:

1. **Conversation ID missing on subagent + tool spans.** `createSubagentSpan`
   (`src/subagent.ts:77`), the synthesized subagent chat-child
   (`attachChatChild`, `src/subagent.ts:269`), and `createToolSpan`
   (`src/spans.ts:164`) never set `gen_ai.conversation.id`. Sentry's
   Conversations view groups by that attribute, so per-conversation rollups
   omit nested work.
2. **`gen_ai.agent.name` missing on chat children.** The Sentry naming doc
   notes that without an agent name on a span, that span cannot be filtered,
   grouped, or alerted on per agent. Today only the `invoke_agent` wrappers
   carry it; the chat children that hold the token rollup do not.
3. **Reasoning tokens not emitted.** Sentry's cost formula refines output
   cost when `gen_ai.usage.output_tokens.reasoning` is present. Anthropic's
   `message.usage` does not split thinking tokens out of `output_tokens`, so
   the value is currently absent for all extended-thinking runs.
4. **README has no sampling guidance.** Sentry's sampling doc explicitly
   warns against lowering trace sample rates for AI traces (head-based
   sampling drops the entire trace, including all LLM/tool/handoff spans).
   The plugin defaults to `tracesSampleRate: 1.0` but does not say why, so
   users may reflexively lower it.

## Goals

- Every span in a turn's call tree carries `gen_ai.conversation.id` so the
  Conversations view groups the full tree under one row.
- Chat children carry `gen_ai.agent.name` mirroring their parent
  `invoke_agent` wrapper (`claude-code` at top level, `<subagent_type>`
  under subagents).
- When a turn used extended thinking, emit an estimated
  `gen_ai.usage.output_tokens.reasoning` so Sentry's cost panel applies the
  reasoning rate. Always pair the estimate with a flag attribute so it is
  never confused with provider-reported numbers.
- README documents the 100% sampling recommendation with rationale.

## Non-Goals

- **Conversation identity strategy.** We keep `sessionId` as the
  conversation key. Resumed sessions remain a known limitation (each resume
  surfaces as a new Conversation row). Out of scope this release.
- **No new config surface.** No new env vars, no new fields in
  `ResolvedPluginConfig`.
- **No per-API-call chat spans.** We keep the one-synthesized-chat-per-turn
  rollup pattern documented in `src/spans.ts:82-87`. Hook-level
  instrumentation cannot observe individual API calls.
- **No backfill** of historical traces.

## Design

### Conversation ID propagation

The same `sessionId` value already used at the turn root is threaded into
every span the collector creates within that turn:

```
UserPromptSubmit (server.ts)
  └─ openTurnTransaction(sessionId)              [conversation.id today]
      ├─ closeTurnSpan → chat child              [conversation.id today; + agent.name NEW; + reasoning NEW]
      ├─ createToolSpan(sessionId)               [conversation.id NEW]
      └─ createSubagentSpan(event.session_id)    [conversation.id NEW]
          └─ attachChatChild                     [conversation.id NEW; agent.name NEW; reasoning NEW]
```

Implementation:

- `src/spans.ts` `createToolSpan`: add a required `sessionId: string`
  parameter and write `gen_ai.conversation.id` into the attributes block.
- `src/server.ts`: call site at line 317 already has `ctx.session_id` in
  scope; pass it through.
- `src/subagent.ts` `createSubagentSpan`: write
  `gen_ai.conversation.id = event.session_id` into the attributes block.
- `src/subagent.ts` `attachChatChild` and `ActiveSubagent`: carry
  `sessionId` from the PreToolUse event so the synthesized chat child
  emits it on PostToolUse.

### Agent name on chat children

- Turn chat child (`closeTurnSpan`): always set
  `gen_ai.agent.name = "claude-code"`.
- Subagent chat child (`attachChatChild`): set
  `gen_ai.agent.name = entry.subagentType` (falls back to the literal
  `"subagent"` when the Task tool input omits a subagent type, matching
  the wrapper's existing behavior).

### Reasoning-token estimation

Anthropic's `message.usage` does not break out thinking tokens —
`output_tokens` already includes them. We estimate from thinking block
content and emit additively:

```
for block in message.content:
  if block.type == "thinking":
    reasoningTokens += ceil(len(block.thinking ?? "") / 4)
```

Rules:

- Only emit `gen_ai.usage.output_tokens.reasoning` when `reasoningTokens > 0`.
- When emitted, always also set
  `claude_code.reasoning_tokens.estimated = true`.
- **Do not subtract** reasoning from `output_tokens`. Anthropic's value
  already includes thinking; Sentry's formula subtracts internally:
  `(output_tokens - reasoning_tokens) * output_rate + reasoning_tokens * reasoning_rate`.
  Subtracting on our side would double-count. This mirrors the existing
  invariant in [[sentry-input-tokens-includes-cached]] that we never
  subtract cache buckets from `input_tokens`.

Implementation:

- `src/transcript.ts`:
  - Add `reasoningTokens?: number` and `reasoningEstimated?: boolean` to
    `TurnTokens` and the sidechain usage type.
  - In `extractPerTurnTokens` and `aggregateSidechainUsage`, while
    iterating assistant messages, scan `message.content[]` for entries
    whose `type === "thinking"`; sum `Math.ceil(text.length / 4)`.
- `src/spans.ts` `closeTurnSpan`: when `tokens.reasoningTokens` set, write
  both attributes on the chat child.
- `src/subagent.ts` `attachChatChild`: same pattern using the sidechain
  usage.

### Sampling documentation

Add a short "Sampling" subsection to README under existing configuration
docs. Content: state that the plugin defaults to `tracesSampleRate: 1.0`,
explain that Sentry uses head-based sampling so dropping a trace drops
every nested LLM/tool/handoff span with it, cite the docs link, and note
that LLM API costs typically dwarf the cost of ingesting the trace.

## Edge Cases

1. **Resumed sessions.** sessionId changes on resume → multiple
   Conversation rows in Sentry. Documented as a known limitation in
   README; revisit in a later release if users hit it.
2. **Thinking block without text.** `len(undefined ?? "") === 0` → no
   emission. Safe.
3. **Subagent chat child where `entry.subagentType` is the fallback
   `"subagent"`.** We still emit the name — Sentry treats any string as a
   valid agent name and grouping by `"subagent"` is more useful than no
   name.
4. **Tool span with no parent (forceTransaction path,
   `src/spans.ts:163`).** Still requires `sessionId`. The call site in
   `src/server.ts` always has it; new parameter is required, no fallback.
5. **Reasoning tokens on a turn whose transcript has not yet flushed.**
   Existing token extraction returns `undefined`/zero defensively; the new
   attribute simply is not emitted that turn. No special handling.

## Testing

Unit (`tests/`):

- `transcript.test.ts`: fixture with assistant message containing a
  `thinking` block of known length → assert estimated reasoning token
  count and `reasoningEstimated === true`. Fixture without thinking →
  `reasoningTokens` undefined.
- `spans.test.ts` (extend): assert `createToolSpan` carries
  `gen_ai.conversation.id`; assert `closeTurnSpan` chat child carries
  `gen_ai.conversation.id`, `gen_ai.agent.name = "claude-code"`, and the
  reasoning attribute pair when `tokens.reasoningTokens > 0`.
- `subagent.test.ts`: assert `createSubagentSpan` and the synthesized chat
  child both carry `gen_ai.conversation.id`; chat child carries
  `gen_ai.agent.name = subagentType`.

Smoke (`scripts/smoke-test.sh`): no changes required — the existing
end-to-end exercise already drives every code path touched here, and the
new attributes ride along on the spans it inspects.

Manual verification (after merge, against a live Sentry project):

1. Run a Claude Code turn that uses a tool, spawns a Task subagent, and
   uses extended thinking.
2. Sentry → AI Agents → Conversations: confirm one row groups the full
   session including subagent and tool spans.
3. Filter chat spans by `gen_ai.agent.name`: confirm both `claude-code`
   and the subagent type are queryable.
4. Confirm the cost panel reflects the reasoning rate for the
   thinking-enabled turn (compare against a turn with no thinking).

## Rollout

Single release. Version bump `0.1.10 → 0.1.11`. CHANGELOG entry covering:

- `gen_ai.conversation.id` now propagated to subagent and tool spans
  (Sentry Conversations view).
- `gen_ai.agent.name` mirrored onto synthesized chat children.
- Estimated `gen_ai.usage.output_tokens.reasoning` emitted for
  extended-thinking turns, flagged via
  `claude_code.reasoning_tokens.estimated`.
- README: new Sampling section documenting the 100% default and rationale.

## Risk

- **Low:** attribute additions are non-destructive. Downstream Sentry
  queries unaware of new attrs ignore them.
- **Low–moderate:** reasoning-token estimate accuracy. Mitigated by the
  `claude_code.reasoning_tokens.estimated=true` flag so cost-discrepancy
  investigations surface the heuristic immediately.
- **None:** sampling change is documentation-only.

## Reversibility

Each item is independent and revertable by removing the attribute write
(or, for reasoning estimation, the extraction block in `transcript.ts`).
No persisted state, no schema migrations.

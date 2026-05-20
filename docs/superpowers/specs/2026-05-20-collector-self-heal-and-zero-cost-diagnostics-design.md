# Collector Self-Heal + Zero-Cost Diagnostics

**Date:** 2026-05-20
**Status:** Draft (pending user review)
**Scope:** Two related observability gaps in `claude-code-ai-observability` —
mid-session collector staleness after `/plugin update`, and chat spans
emitting zero tokens for some real turns. One spec, one release (0.2.3).

## Problem

Two distinct UX/correctness gaps surfaced after 0.2.2 shipped:

1. **Mid-session collector staleness.** `ensureServerRunning`
   (`src/hook-client.ts:293`) already implements version-self-heal:
   it probes `/health`, compares `info.version` to `PLUGIN_VERSION`, and on
   mismatch acquires an advisory lock, kills the stale collector
   (`killStaleCollector` with reason `"version mismatch"`), and spawns
   a fresh one. **However it is only called on `SessionStart`**
   (`src/hook-client.ts:405-408`). If a user runs `/plugin update`
   mid-session, every hook dispatched until the next cold start still
   hits the stale collector — the very situation observed in this repo
   today, where the v0.2.2 traces showed v0.2.1 behavior for tool spans.

2. **Zero-token chat spans.** `closeCurrentTurn` (`src/server.ts:191`)
   defaults all token fields to zero, then calls
   `readTranscript(record.transcriptPath)` and `selectTurn` to fill in
   the real numbers. When `selectTurn` returns `null` or returns a turn
   whose `inputTokens + outputTokens === 0`, the zero defaults survive
   and the synthesized `gen_ai.chat` child publishes
   `input_tokens=0, output_tokens=0`. Live Sentry data shows multiple
   recent traces in this state, including long-running turns where
   tokens clearly were not zero in reality. Root cause is unknown but
   the suspected mechanism is ordinal drift between the collector's
   `record.turnIndex` and the transcript's real-turn ordering, possibly
   combined with late transcript flush on busy turns.

## Goals

- After `/plugin update`, the next hook event on any open session
  triggers a version-self-heal — no user intervention, no slash command.
- Every chat span where tokens fell back to zero carries a diagnostic
  attribute identifying *why* the fallback happened, so we can quantify
  the cause distribution in Sentry queries.
- The most likely single cause of zero tokens (late transcript flush) is
  mitigated with a bounded once-only retry.

## Non-Goals

- **No new config surface.** No new env vars, no new fields in
  `ResolvedPluginConfig`.
- **No persisted turn↔promptId map.** A future improvement, but out of
  scope. Compaction-driven misses remain visible via the diagnostic
  attribute.
- **No subagent-specific zero-cost work.** Subagent chat children flow
  through the same `attachChatChild` path; if the fix helps there it
  rides along. No dedicated subagent token-extraction changes.
- **No backfill** of historical traces.

## Design

### A. Self-heal on every hook event

`src/hook-client.ts` `main()` (lines 396-410): hoist
`loadConfigJson()` and `ensureServerRunning(port, configJson)` out of
the `SessionStart` branch and call them unconditionally before
`sendHookEvent`. The existing `isHealthyMatch` short-circuit
(`src/hook-client.ts:300-302`) makes the steady-state cost a single
HTTP probe on loopback (~1-2 ms).

When `killStaleCollector` is invoked, the subsequent `spawnCollector`
(`src/hook-client.ts:243`) passes `AIOBS_RESPAWNED_FROM=<oldVersion>`
in the child's `env`. The new collector reads this from `process.env`
at startup (`src/index.ts`), stores it in a module-local var
`respawnedFromVersion` with `respawnedFromExpiry = Date.now() + 60_000`,
and `applyTags` (`src/spans.ts:9`) adds the attribute
`claude_code.collector.respawned_from_version = <oldVersion>` to every
span until the expiry passes. After 60 s the tag stops being applied
so it does not persist for hours.

This gives an in-Sentry signal that a self-heal happened, without
requiring users to read collector logs.

### B. Zero-cost diagnostics

`src/transcript-reader.ts` `selectTurn` (line 203): change return type
from `RealTurn | null` to
`{ turn: RealTurn | null; matchedBy: "prompt_id" | "ordinal" | "none" }`.
Existing callers in `src/server.ts:214` and any internal tests update
to the new shape.

`src/server.ts` `closeCurrentTurn` derives a single status string
per call:

- `transcript_missing` — `record.transcriptPath` empty or file unreadable
- `no_matching_turn` — `selectTurn().turn === null`
- `matched_by_prompt_id` — matched on `record.currentPromptId`
- `matched_by_ordinal` — matched by `record.turnIndex` fallback
- `turn_had_no_usage` — matched but `inputTokens + outputTokens === 0`
  (and the retry below did not change that)
- `ok` — tokens > 0 on first read
- `ok|matched_after_retry` — tokens > 0 only on the second read (see C)

`src/spans.ts` `CloseTurnInput`: add `tokenExtractionStatus?: string`.
`closeTurnSpan` writes `claude_code.token_extraction.status = <status>`
on the chat child when set. Omitted when undefined to preserve
backwards-compat on unchanged callers.

### C. Late-flush retry

In `closeCurrentTurn`, after the first `selectTurn`, if the matched
turn exists but `inputTokens + outputTokens === 0`:

1. `await new Promise(r => setTimeout(r, 200))`
2. Re-run `readTranscript(record.transcriptPath)` and `selectTurn`.
3. If the second read produces a turn with non-zero tokens, replace
   `tokens` with the new value and set the status to
   `ok|matched_after_retry`.
4. Otherwise leave status as `turn_had_no_usage`.

The retry is bounded to once per close. We do not retry on
`transcript_missing` — that is a different failure mode (genuinely
unflushed or wrong path), not a flush race.

Hypothesis: Claude Code's transcript flush sometimes lags by tens of
milliseconds past the next `UserPromptSubmit`. A 200 ms wait is short
enough to be invisible in trace timing but long enough to let the
flush catch up.

## Edge Cases

1. **Multiple hook-client processes racing to respawn.** Already
   handled by the advisory lock at `src/hook-client.ts:202`. Only one
   process kills + spawns; others passively wait for healthy.
2. **New collector crashes immediately after spawn.** `spawnCollector`
   (`src/hook-client.ts:263-268`) already times out after 2 s and
   returns. The next hook re-enters the lock and tries again. Existing
   behavior.
3. **Retry sleep blocking the hook handler.** `closeCurrentTurn` runs
   inside the collector, which handles each `/hook` POST in an async
   handler. A 200 ms `await` inside one close does not block other
   in-flight hook events on the collector.
4. **User aborts a turn before assistant responds.** Transcript has a
   user line but no assistant message. Retry will not change that.
   Status remains `turn_had_no_usage`; the attribute now documents why
   the chat span shows 0 — correct behavior.
5. **`/compact` mid-session** prunes the transcript. Ordinal lookup
   misses → status = `no_matching_turn`. No retry (different failure
   mode). Logged via the attribute so we can quantify how often this
   happens.
6. **`AIOBS_RESPAWNED_FROM` leaks across unrelated restarts.** The
   60 s expiry ensures the tag only appears on spans created soon
   after the respawn.
7. **Steady-state probe cost.** ~1 loopback HTTP roundtrip added per
   hook event. Measured ≪ 5 ms; hooks already do 1 POST per event, so
   the wall-clock per hook goes from ~3 ms to ~5 ms. Acceptable.

## Testing

Unit (TDD per change):

- `tests/hook-client-units.test.ts`:
  - `ensureServerRunning is called on a non-SessionStart event` — drive
    `main()` with a `PreToolUse` JSON on stdin, stub
    `ensureServerRunning`, assert one invocation.
  - `spawnCollector passes AIOBS_RESPAWNED_FROM env on stale-collector
    replacement` — stub `spawn`, assert `env.AIOBS_RESPAWNED_FROM`
    equals the previous health-reported version.

- `tests/server-lifecycle.test.ts`:
  - `chat span carries token_extraction.status=transcript_missing` when
    `record.transcriptPath` is empty.
  - `chat span carries status=matched_by_ordinal` when `promptId`
    absent but ordinal matches a real turn.
  - `chat span carries status=no_matching_turn` when transcript exists
    but has no real turns.
  - `chat span carries status=turn_had_no_usage` when matched turn has
    zero usage and the second read also has zero usage.
  - `chat span carries status="ok|matched_after_retry"` when the
    second read returns a turn with non-zero usage.

- `tests/spans.test.ts`:
  - `closeTurnSpan emits claude_code.token_extraction.status when
    CloseTurnInput.tokenExtractionStatus is set`.
  - `closeTurnSpan omits the attribute when tokenExtractionStatus is
    undefined`.

Smoke (`scripts/smoke-test.sh`): no changes required.

Manual verification (post-merge, against live Sentry):

1. Merge PR, then `/plugin update` → confirm a `gen_ai.chat` span in
   the next session carries
   `claude_code.collector.respawned_from_version=0.2.2`.
2. Query Sentry: `sum(count) by claude_code.token_extraction.status`
   over 24 h. Confirm `ok` dominates; record the distribution of the
   non-`ok` categories for the follow-up investigation.
3. Compare a "type fast and submit again" workflow (likely to provoke
   the late-flush race) against a relaxed workflow. Look for
   `ok|matched_after_retry` appearing only on the fast workflow.

## Rollout

Single release. Version bump `0.2.2 → 0.2.3` in all three files:

- `package.json`
- `.claude-plugin/plugin.json` (release workflow keys off this)
- `.claude-plugin/marketplace.json` (Claude Code `/plugin update` reads
  this)

CHANGELOG entry: self-heal extended to every hook event; new
`claude_code.token_extraction.status` diagnostic attribute on chat
children; bounded once-only late-flush retry;
`claude_code.collector.respawned_from_version` tag for ≤60 s after a
self-heal.

## Risk

- **Low:** all changes are additive at the observability surface;
  existing attributes unchanged.
- **Low–moderate:** per-hook `ensureServerRunning` adds ~2 ms
  steady-state. If user-perception ever measures this, we can gate it
  behind a "checked within last N seconds" memoization. Not needed
  initially given the existing process-spawn cost per hook dominates.
- **Low:** the 200 ms retry could in principle race with itself, but
  it is scoped inside one `closeCurrentTurn` invocation per turn — no
  concurrent invocation possible for the same turn.
- **None:** diagnostic attribute is purely informational.

## Reversibility

Each item is independent and revertable by removing the attribute
write, hook hoist, or retry block. No persisted state, no schema
migrations.

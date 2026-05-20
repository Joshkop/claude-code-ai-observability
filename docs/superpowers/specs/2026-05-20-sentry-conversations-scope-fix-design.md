# Sentry Conversations Scope Fix

**Date:** 2026-05-20
**Status:** Draft (pending user review)
**Scope:** Make the Sentry AI Agents → Conversations view actually populate.
One spec, one patch release (0.2.6).

## Problem

0.2.2 added `gen_ai.conversation.id` as a span attribute on every span in a
turn's call tree. 0.2.5 upgraded `@sentry/node` from 9.x to 10.53.1 and
enabled `streamGenAiSpans: true` in `Sentry.init`. Despite both, the
**Conversations view at `/explore/conversations/` is still empty**.

Root cause: Sentry's `Scope` class in v10 has a private `_conversationId`
field, populated by `Sentry.setConversationId(...)`. The v2-envelope-item
serialization path that `streamGenAiSpans` enables reads conversation id
from **the scope at span-end time**, not from the span's `attributes` map.
Manually setting `gen_ai.conversation.id` as a span attribute puts the
right value on the span — visible in Discover and the span detail panel —
but the Conversations pipeline never sees it because scope-level
`conversationId` stays empty.

Evidence:
- Latest `gen_ai.invoke_agent` span attributes (verified via Sentry events
  API) show `gen_ai.conversation.id` populated correctly.
- Conversations view at the documented URL is empty for the same time
  range.
- `node_modules/.pnpm/@sentry+core@10.53.1/.../scope.d.ts` declares:
  `setConversationId(conversationId: string | null | undefined): void`
  and `protected _conversationId?: string;` on the `Scope` class.

## Goals

- Every `gen_ai.*` span the collector emits is associated with the
  correct conversation id at the Sentry SDK *scope* level, not just the
  span attribute.
- After this ships and a user takes a turn, the Conversations view
  populates with one row per `gen_ai.conversation.id` (= Claude Code
  `sessionId`).
- No cross-session leak: concurrent `/hook` requests from different
  Claude Code sessions never share a conversation id.

## Non-Goals

- **No change to span attribute emission.** Manual
  `gen_ai.conversation.id` stays on every span. The SDK's auto-apply
  via scope is additive, not a replacement.
- **No new config surface.** No env vars, no new fields in
  `ResolvedPluginConfig`.
- **No re-architecture of the span lifecycle.** Turn spans still live
  across multiple hook events via `startInactiveSpan`.

## Design

### Per-hook isolation scope

Wrap every hook event handler in `Sentry.withIsolationScope` and call
`scope.setConversationId(event.session_id)` immediately on entry. Spans
created or ended inside that scope inherit the conversation id, which
the streaming-spans pipeline serializes into v2 envelope items.

**`src/server.ts`** changes:

1. **`handleEvent`** in `src/server.ts` (around line 532) — the async
   function that switches on `event.hook_event_name` and routes to
   `handleSessionStart` / `handleUserPrompt` / `handlePreTool` /
   `handlePostTool` / `handleSessionEnd`. Wrap the entire `switch`
   body in `withIsolationScope`:

   ```ts
   async function handleEvent(event: HookEvent): Promise<void> {
     touchSession(event);
     await sentry.withIsolationScope(async (scope) => {
       if (event.session_id) scope.setConversationId(event.session_id);
       switch (event.hook_event_name) {
         case "SessionStart":     await handleSessionStart(event); return;
         case "UserPromptSubmit": handleUserPrompt(event);         return;
         case "PreToolUse":       handlePreTool(event);            return;
         case "PostToolUse":      handlePostTool(event);           return;
         case "SessionEnd":       await handleSessionEnd(event);   return;
         case "Stop":
         case "PreCompact":       return;
       }
     });
   }
   ```

   `withIsolationScope` returns whatever its callback returns, so the
   `async` callback is supported. Spans created during the callback
   capture the scope in their internal reference, so subsequent
   `span.end()` calls (which may happen later, in a different scope)
   still serialize with the original scope's `_conversationId`.

2. **`reapStaleSession`** runs from a timer outside any HTTP scope chain.
   Wrap its `closeCurrentTurn` work in `withIsolationScope` + the
   session's `session_id` so the timer-driven close emits with the right
   conversation id:

   ```ts
   const reapStaleSession = (sessionId: string, record: SessionRecord) => {
     sentry.withIsolationScope((scope) => {
       scope.setConversationId(sessionId);
       try { closeCurrentTurn(record); } catch { /* ignore */ }
       for (const [, pending] of record.pendingTools) {
         try { pending.span.end(); } catch { /* ignore */ }
       }
       record.pendingTools.clear();
     });
     sessions.delete(sessionId);
   };
   ```

3. **Heartbeat span** (`claude_code.collector.heartbeat`, emitted by the
   flush timer) is unrelated to any session. Leave unwrapped — it
   legitimately has no conversation id.

### Why scope is bound at span-create time, not end time

Sentry v10 spans hold a reference to the isolation scope active at
`startInactiveSpan` time. When `end()` is called later in a different
async context, the SDK uses the span's *captured* scope, not the
*currently active* scope, for event-level attributes like
`conversationId`. This is the canonical pattern for long-lived inactive
spans.

This makes the per-hook wrap correct: each `/hook` event lives in its
own isolation scope; every span it opens (turn root, tool span,
synthesized chat child) captures that scope; the scope carries the
session's conversation id forever after.

The chat child synthesized in `closeCurrentTurn` is created in *whichever*
hook event triggered the close (next `UserPromptSubmit` or
`SessionEnd`). Both of those handlers will be wrapped, so the chat
child gets the same conversation id as the turn span.

### Manual `gen_ai.conversation.id` attribute stays

We continue setting `gen_ai.conversation.id = sessionId` as a span
attribute. It is redundant with the scope-based propagation once
streamGenAiSpans is working, but:

- Existing Discover queries and dashboards filter on this attribute.
- It documents the value clearly in the span detail panel.
- Removing it would require coordinated dashboard migration; not worth
  the churn for this patch.

Add a comment in `spans.ts` and `subagent.ts` noting the redundancy.

## Edge Cases

1. **Concurrent sessions.** Each `/hook` POST runs in its own async
   context. `Sentry.withIsolationScope` (backed by v10's
   OpenTelemetry context strategy) gives each its own scope object.
   No cross-session leak.
2. **`withActiveSpan` for nested spans.** Tool spans and subagent
   spans are opened inside `withActiveSpan(parentSpan, () => ...)`
   to set the parent for trace hierarchy. `withActiveSpan` does
   not push a new isolation scope — children inherit the outer
   isolation scope's conversation id. Correct behavior.
3. **Subagent dispatch from a session whose isolation scope has a
   different `session_id`.** Not possible: a subagent's PreToolUse
   carries the parent session's `session_id`, so the dispatcher's
   `withIsolationScope` sets the right id before nesting work begins.
4. **Stale-session reaper.** Timer-driven, runs outside any HTTP
   scope. Explicit `withIsolationScope` wrap in `reapStaleSession`
   handles this.
5. **Events with no `session_id`.** Defensive: skip
   `setConversationId` rather than calling it with `undefined`. The
   `Sentry.setConversationId` signature accepts `string | null |
   undefined` but we don't want to clobber any inherited scope id.
6. **Heartbeat span.** No session context. No wrap. Emits without
   conversation id — correct.

## Testing

Unit (`tests/server-lifecycle.test.ts`):

- New test: drive a `UserPromptSubmit` event through the public
  `/hook` POST. Assert the fake-sentry spy on `setConversationId`
  was called with `event.session_id`. Use the existing fake-sentry
  shape; if `setConversationId` isn't on it, extend the fake to
  capture calls.
- New test: drive a `SessionEnd` event. Assert
  `setConversationId(sessionId)` was called.
- New test: drive a `PostToolUse` event. Assert
  `setConversationId(sessionId)` was called.
- New test: event with no `session_id` (synthetic / malformed)
  does NOT call `setConversationId`.

Smoke (`scripts/smoke-test.sh`): no changes needed; existing
pipeline still works under the new wrap.

Manual (post-merge, live Sentry):

1. `/plugin update` to 0.2.6.
2. Fully exit Claude Code; start a fresh session.
3. Take 2–3 turns including a tool call and a subagent invocation.
4. Wait ~30 s for ingestion.
5. Open `https://jobo-handel.sentry.io/explore/conversations/` →
   confirm one row per session, with first user message, latest
   assistant response, cost estimate, and call counts populated.

## Rollout

Patch release **0.2.6**. CHANGELOG + version bump in all three
files (`package.json`, `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`) per the release-version-files
memory.

## Risk

- **Low.** `withIsolationScope` is the SDK's canonical scope-isolation
  primitive; we use it exactly as documented.
- The biggest unknown is whether v10's HTTP server integration *also*
  creates per-request isolation scopes — if so, our explicit wrap is a
  thin extra scope layer over an existing one (harmless). If not, our
  wrap is load-bearing for correctness.
- The fix is fully additive: removing it would only revert to the
  current broken-Conversations state, not break anything else.

## Reversibility

Each item is independent and revertable by removing the
`withIsolationScope` wrap. No persisted state, no schema migrations,
no public API change.

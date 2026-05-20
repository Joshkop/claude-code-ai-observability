# Sentry Conversations Scope Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sentry's AI Agents → Conversations view actually populate by calling `Sentry.setConversationId(...)` on the SDK scope for every hook event, in addition to the existing per-span `gen_ai.conversation.id` attribute.

**Architecture:** Wrap `handleEvent` and `reapStaleSession` in `Sentry.withIsolationScope`; call `scope.setConversationId(event.session_id)` immediately on entry. Spans created inside the scope capture it; v10's streamGenAiSpans pipeline (enabled in 0.2.5) reads scope-level conversation id when emitting v2 envelope items. Existing manual span attribute stays for Discover/dashboard compatibility.

**Tech Stack:** TypeScript, `@sentry/node` ^10.53.1, vitest, pnpm, Node ≥18.

**Spec:** `docs/superpowers/specs/2026-05-20-sentry-conversations-scope-fix-design.md`

---

## File Map

| File | Role |
|---|---|
| `src/server.ts` (modify) | `handleEvent`: wrap switch in `withIsolationScope` + `setConversationId`. `reapStaleSession`: wrap close work in `withIsolationScope` + `setConversationId`. |
| `tests/server-lifecycle.test.ts` (modify) | Extend fake-sentry to capture `withIsolationScope` + `setConversationId` calls. Add 4 tests (UserPromptSubmit, SessionEnd, PostToolUse, malformed-no-session-id). |
| `tests/server-endpoints.test.ts` (read-only verification) | Existing real-server tests should still pass — fake-sentry change is test-local. |
| `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (modify) | Bump to 0.2.6. |
| `CHANGELOG.md` (modify) | 0.2.6 entry. |
| `scripts/server.js` (regenerated) | Rebuilt from `src/server.ts` for the CI sync check. |

---

## Task 1: Extend fake-sentry in tests with withIsolationScope + setConversationId (TDD setup)

**Files:**
- Modify: `tests/server-lifecycle.test.ts`

The existing `makeFakeSentry` helper (around line 17) supports `startInactiveSpan`, `withActiveSpan`, and `flush` — but not `withIsolationScope` or `setConversationId`. Task 2 will require these. Add them now without changing existing test behavior.

- [ ] **Step 1: Inspect the existing helper**

Run: `grep -n "makeFakeSentry\|withActiveSpan\|setConversationId\|withIsolationScope" tests/server-lifecycle.test.ts`

Confirm:
- `makeFakeSentry` is at the top of the file
- No existing reference to `withIsolationScope` or `setConversationId`

- [ ] **Step 2: Extend `makeFakeSentry`**

In `tests/server-lifecycle.test.ts`, replace the existing `makeFakeSentry` body with:

```ts
function makeFakeSentry() {
  const spans: FakeSpan[] = [];
  const conversationIdCalls: Array<string | null | undefined> = [];
  return {
    spans,
    conversationIdCalls,
    startInactiveSpan(opts: {
      op?: string;
      name?: string;
      attributes?: Record<string, unknown>;
      forceTransaction?: boolean;
    }) {
      const span: FakeSpan = {
        attrs: { ...(opts.attributes ?? {}) },
        ended: false,
        op: opts.op,
        name: opts.name,
        forceTransaction: opts.forceTransaction,
      };
      spans.push(span);
      return {
        setAttribute(k: string, v: unknown) { span.attrs[k] = v; },
        setStatus() {},
        end() { span.ended = true; },
      };
    },
    withActiveSpan<T>(_parent: unknown, fn: () => T): T {
      return fn();
    },
    withIsolationScope<T>(fn: (scope: { setConversationId(id: string | null | undefined): void }) => T): T {
      const scope = {
        setConversationId: (id: string | null | undefined) => {
          conversationIdCalls.push(id);
        },
      };
      return fn(scope);
    },
    flush: async () => true,
  };
}
```

Notes:
- `conversationIdCalls` accumulates every value passed to `setConversationId` so tests can assert on it.
- `withIsolationScope` synchronously invokes the callback with a fake scope — mirrors how `Sentry.withIsolationScope` works for sync callbacks. The real SDK also supports async callbacks (returns the promise); the fake handles that case because TypeScript infers `T = Promise<void>` and the callback executes immediately.

- [ ] **Step 3: Run all existing tests to confirm no regression**

Run: `pnpm exec vitest run tests/server-lifecycle.test.ts`
Expected: PASS — same number of tests as before, all green.

- [ ] **Step 4: Commit**

```bash
git add tests/server-lifecycle.test.ts
git commit -m "test(server-lifecycle): extend fake-sentry with withIsolationScope + setConversationId"
```

---

## Task 2: Wrap `handleEvent` in withIsolationScope + setConversationId (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-lifecycle.test.ts`

`handleEvent` (around `src/server.ts:532`) is the dispatcher that routes a parsed hook event to its specific handler via a `switch` on `event.hook_event_name`. Wrap the switch in `Sentry.withIsolationScope` and call `scope.setConversationId(event.session_id)` immediately on entry.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server-lifecycle.test.ts` inside the existing top-level `describe` block (or create a new `describe("conversation scope propagation", ...)` block if cleaner). Use whatever fixture pattern the existing tests use to drive events through `startServer` — typically a `mkdtempSync` cache dir + writing a transcript file + dispatching events via the real `/hook` endpoint or directly via the exported handlers.

If the existing tests construct a "test harness" function that returns a started server + a way to post hook events, reuse it. Otherwise, model the new tests on the closest existing pattern in this file.

```ts
  it("handleEvent: UserPromptSubmit triggers setConversationId(session_id)", async () => {
    const { sentry, postHook } = await startTestHarness();
    try {
      await postHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-abc",
        prompt: "hello",
      });
      expect(sentry.conversationIdCalls).toContain("sess-abc");
    } finally {
      await teardownTestHarness();
    }
  });

  it("handleEvent: SessionEnd triggers setConversationId(session_id)", async () => {
    const { sentry, postHook } = await startTestHarness();
    try {
      await postHook({
        hook_event_name: "SessionEnd",
        session_id: "sess-end",
      });
      expect(sentry.conversationIdCalls).toContain("sess-end");
    } finally {
      await teardownTestHarness();
    }
  });

  it("handleEvent: PostToolUse triggers setConversationId(session_id)", async () => {
    const { sentry, postHook } = await startTestHarness();
    try {
      await postHook({
        hook_event_name: "PostToolUse",
        session_id: "sess-tool",
        tool_name: "Bash",
        tool_use_id: "tu-1",
      });
      expect(sentry.conversationIdCalls).toContain("sess-tool");
    } finally {
      await teardownTestHarness();
    }
  });

  it("handleEvent: event with no session_id does NOT call setConversationId", async () => {
    const { sentry, postHook } = await startTestHarness();
    const before = sentry.conversationIdCalls.length;
    try {
      // Synthetic / malformed event without session_id
      await postHook({
        hook_event_name: "PreCompact",
        // session_id intentionally omitted
      } as unknown as Parameters<typeof postHook>[0]);
      expect(sentry.conversationIdCalls.length).toBe(before);
    } finally {
      await teardownTestHarness();
    }
  });
```

**Important:** if `startTestHarness` / `postHook` / `teardownTestHarness` don't exist in this file, the IMPLEMENTER must inspect existing tests to find the actual harness pattern. Look for tests that drive events through `startServer` and copy that exact mechanism. Likely the existing pattern uses a real-server (binds a random port and POSTs to `/hook`), or directly invokes the dispatcher by extracting it from a returned API. The assertions on `sentry.conversationIdCalls` are what matter — translate the harness skeleton above to whatever the file already does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/server-lifecycle.test.ts -t "conversation scope" `
Expected: FAIL — `sentry.conversationIdCalls` is empty because `handleEvent` doesn't yet call `setConversationId`.

- [ ] **Step 3: Update `handleEvent`**

In `src/server.ts`, replace the existing `handleEvent` (currently around line 532-555) with:

```ts
  async function handleEvent(event: HookEvent): Promise<void> {
    touchSession(event);
    await sentry.withIsolationScope(async (scope) => {
      if (event.session_id) scope.setConversationId(event.session_id);
      switch (event.hook_event_name) {
        case "SessionStart":
          await handleSessionStart(event);
          return;
        case "UserPromptSubmit":
          handleUserPrompt(event);
          return;
        case "PreToolUse":
          handlePreTool(event);
          return;
        case "PostToolUse":
          handlePostTool(event);
          return;
        case "SessionEnd":
          await handleSessionEnd(event);
          return;
        case "Stop":
        case "PreCompact":
          return;
      }
    });
  }
```

**Note on the `await`:** `Sentry.withIsolationScope` returns whatever its callback returns. With an `async` callback, it returns a `Promise<void>`. Awaiting it preserves the existing semantics (the outer caller awaits `handleEvent`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/server-lifecycle.test.ts -t "conversation scope"`
Expected: PASS — all 4 new tests green.

- [ ] **Step 5: Full lifecycle test run + typecheck**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run tests/server-lifecycle.test.ts`
Expected: PASS — all server-lifecycle tests (existing + new) green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "server: withIsolationScope + setConversationId per hook event"
```

---

## Task 3: Wrap `reapStaleSession` in withIsolationScope + setConversationId (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-lifecycle.test.ts`

`reapStaleSession` (around `src/server.ts:182`) runs from a flush timer outside any HTTP scope chain. It calls `closeCurrentTurn` and ends pending tool spans. Wrap that work in `Sentry.withIsolationScope` so the timer-driven close still emits with the correct conversation id.

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
  it("reapStaleSession: timer-driven close triggers setConversationId(sessionId)", async () => {
    const { sentry, postHook, advanceTime, teardown } = await startTestHarness({
      sessionTtlMs: 100, // force the reaper to fire quickly
    });
    try {
      await postHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-stale",
        prompt: "hi",
      });
      const beforeReap = sentry.conversationIdCalls.length;
      await advanceTime(200); // exceeds TTL; reaper runs
      expect(sentry.conversationIdCalls.slice(beforeReap)).toContain("sess-stale");
    } finally {
      await teardown();
    }
  });
```

**Important:** the `advanceTime` / `sessionTtlMs` mechanisms above are placeholders — adapt to however the existing tests trigger the reaper. Look for any test in this file that already exercises `reapStaleSession` or the flush timer. Likely options:
- `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(...)`
- A `forceReap()` helper exposed by the test harness
- Direct invocation of `reapStaleSession` by reaching into the closure (if it's exported for testing)

If `reapStaleSession` is not currently testable in isolation, **export a helper** that calls it on demand for testing — or, simpler, make the test wait wall-clock for the timer to fire and trigger reap.

The behavior to assert is: after the reaper fires for a session, `setConversationId(sessionId)` appears in `sentry.conversationIdCalls`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/server-lifecycle.test.ts -t "reapStaleSession"`
Expected: FAIL — reaper doesn't call `setConversationId` yet.

- [ ] **Step 3: Update `reapStaleSession`**

In `src/server.ts`, replace the existing `reapStaleSession` (currently around line 182-190) with:

```ts
  const reapStaleSession = (sessionId: string, record: SessionRecord): void => {
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

**Note:** the `sessions.delete(sessionId)` stays *outside* the scope wrap — it doesn't emit telemetry, just cleans up the in-memory map.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/server-lifecycle.test.ts -t "reapStaleSession"`
Expected: PASS.

- [ ] **Step 5: Full lifecycle test run + typecheck**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run tests/server-lifecycle.test.ts`
Expected: PASS — all server-lifecycle tests green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "server: wrap reapStaleSession in withIsolationScope + setConversationId"
```

---

## Task 4: Full test + smoke + scripts/*.js rebuild

**Files:** none (verification + build sync)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: All tests pass (will be 415 + however many new tests Tasks 1-3 added — expect ~420).

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke**

Run: `pnpm run smoke`
Expected: `Smoke test PASSED.`

- [ ] **Step 4: Build scripts/*.js**

Run: `pnpm run build`
Expected: Exits 0; `scripts/server.js` regenerated.

Check what changed:

```bash
git status -s scripts/
```

`scripts/server.js` should be modified.

- [ ] **Step 5: Commit rebuilt scripts**

```bash
git add scripts/
git commit -m "build: rebuild scripts/*.js from src/ for CI sync check"
```

---

## Task 5: Bump version + CHANGELOG (0.2.6)

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `CHANGELOG.md`

Per the `release-version-files` memory: all three version files must be bumped together.

- [ ] **Step 1: Bump package.json**

In `package.json`, change `"version": "0.2.5"` to `"version": "0.2.6"`.

- [ ] **Step 2: Bump plugin.json**

In `.claude-plugin/plugin.json`, change `"version": "0.2.5"` to `"version": "0.2.6"`.

- [ ] **Step 3: Bump marketplace.json**

In `.claude-plugin/marketplace.json`, change `"version": "0.2.5"` to `"version": "0.2.6"`.

- [ ] **Step 4: Inspect existing CHANGELOG style**

Run: `head -12 CHANGELOG.md`
Note the heading format used by adjacent entries.

- [ ] **Step 5: Add the entry**

Prepend the entry immediately after the file's intro (above `## [0.2.5] - 2026-05-20`):

```markdown
## [0.2.6] - 2026-05-20

### Fixed

- **Sentry Conversations view now actually populates.** 0.2.5 enabled `streamGenAiSpans: true` but the Conversations view stayed empty because Sentry's pipeline reads conversation id from the SDK *scope* (`Sentry.setConversationId(...)`), not from the per-span `gen_ai.conversation.id` attribute alone. Every hook event handler now runs inside `Sentry.withIsolationScope` and calls `scope.setConversationId(event.session_id)` on entry; the stale-session reaper does the same. Spans created/ended inside that scope carry the conversation id into v2 envelope items.

The manual `gen_ai.conversation.id` span attribute (added in 0.2.2) stays — it is redundant with scope-based propagation once streamGenAiSpans is working, but keeps existing Discover queries and dashboards intact.
```

- [ ] **Step 6: Final verify**

Run: `pnpm run ci`
Expected: PASS — typecheck + tests + smoke all green.

- [ ] **Step 7: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "release: 0.2.6 — Conversations scope fix (withIsolationScope per hook)"
```

---

## Done criteria

- All five tasks committed.
- `pnpm run ci` green.
- Branch ready to PR; the CI's "assert scripts/*.js is in sync with src/" passes (Task 4 step 5).
- After merge, GitHub release workflow auto-tags `v0.2.6` (because `.claude-plugin/plugin.json` changed) and Claude Code `/plugin update` surfaces 0.2.6 (because `.claude-plugin/marketplace.json` changed).
- Manual verification owed post-merge: fresh Claude Code session → take 2-3 turns → confirm `https://jobo-handel.sentry.io/explore/conversations/` populates.

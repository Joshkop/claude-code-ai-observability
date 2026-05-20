# Collector Self-Heal + Zero-Cost Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/plugin update` zero-touch (self-heal on every hook) and add a per-chat-span diagnostic attribute that identifies why a turn extracted 0 tokens, plus a bounded once-only retry to mitigate the most likely cause (late transcript flush).

**Architecture:** Three additive changes. (A) hoist `ensureServerRunning` out of the SessionStart branch in `hook-client.ts` so every hook event self-heals. (B) widen `selectTurn` return shape and derive a status string per `closeCurrentTurn`; emit on chat child. (C) sleep 200 ms + re-read transcript once when matched turn has zero usage. No new config, no new span types.

**Tech Stack:** TypeScript, `@sentry/node` v9, vitest, Node ≥18.

**Spec:** `docs/superpowers/specs/2026-05-20-collector-self-heal-and-zero-cost-diagnostics-design.md`

---

## File Map

| File | Role |
|---|---|
| `src/hook-client.ts` (modify) | Always call `loadConfigJson` + `ensureServerRunning` in `main()`. Pass `AIOBS_RESPAWNED_FROM` env when respawning a stale collector. |
| `src/index.ts` (modify) | At collector startup, if `AIOBS_RESPAWNED_FROM` env present, `Sentry.setTag("claude_code.collector.respawned_from_version", ...)` then clear it after 60 s. |
| `src/transcript-reader.ts` (modify) | `selectTurn` returns `{ turn, matchedBy }`. |
| `src/server.ts` (modify) | `closeCurrentTurn` derives `tokenExtractionStatus`; on `turn_had_no_usage` performs a 200 ms retry once; passes status into `closeTurnSpan`. |
| `src/spans.ts` (modify) | `CloseTurnInput.tokenExtractionStatus?: string`; emit `claude_code.token_extraction.status` on the chat child when set. |
| `tests/hook-client-units.test.ts` (modify) | Self-heal on non-SessionStart event; AIOBS_RESPAWNED_FROM env propagation. |
| `tests/server-lifecycle.test.ts` (modify) | Five new tests covering each status value + retry path. |
| `tests/spans.test.ts` (modify) | Conditional emit of `token_extraction.status`. |
| `CHANGELOG.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (modify) | Bump to 0.2.3 + CHANGELOG entry. |

---

## Task 1: Self-heal on every hook event (TDD)

**Files:**
- Modify: `src/hook-client.ts`
- Test: `tests/hook-client-units.test.ts`

- [ ] **Step 1: Inspect existing self-heal test scaffolding**

Run: `grep -n "ensureServerRunning\|SessionStart\|describe\|main" tests/hook-client-units.test.ts | head -20`

Note the existing test pattern (probably runs `main` with stdin event JSON and a mocked port).

- [ ] **Step 2: Write the failing test**

Append a new test to the existing self-heal `describe` block in `tests/hook-client-units.test.ts`:

```ts
  it("calls ensureServerRunning on non-SessionStart events (mid-session self-heal)", async () => {
    const calls: Array<{ port: number; configJson: string }> = [];
    const mod = await import("../src/hook-client.js");
    const orig = mod.ensureServerRunning;
    // monkey-patch via a stub. If the implementation imports ensureServerRunning
    // from itself via a local reference, the test instead drives `main` and
    // asserts that the collector spawn path observed the event — see the
    // hook-client integration tests in the same file for the pattern.
    (mod as { ensureServerRunning: typeof orig }).ensureServerRunning = (port, cfg) => {
      calls.push({ port, configJson: cfg });
      return Promise.resolve();
    };
    try {
      const event = {
        hook_event_name: "PreToolUse",
        session_id: "sess-1",
        tool_name: "Bash",
      };
      process.stdin.push(JSON.stringify(event));
      process.stdin.push(null);
      await mod.main();
      expect(calls.length).toBe(1);
    } finally {
      (mod as { ensureServerRunning: typeof orig }).ensureServerRunning = orig;
    }
  });
```

**Note:** if `main` is not exported, adapt the test to match the existing test's strategy (drive a child process / fork). The behavior to assert is: when stdin contains a `PreToolUse` event (not `SessionStart`), `ensureServerRunning` is invoked. If `main` is internal, export it for testability (add `export` keyword).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/hook-client-units.test.ts`
Expected: FAIL — `expect(calls.length).toBe(1)` receives 0 because `main()` only calls `ensureServerRunning` on SessionStart.

- [ ] **Step 4: Hoist ensureServerRunning out of SessionStart branch**

In `src/hook-client.ts`, replace the current `main()` (lines 396-410) with:

```ts
export async function main(): Promise<void> {
  const stdin = await readStdin();
  let event: HookEvent;
  try {
    event = JSON.parse(stdin) as HookEvent;
  } catch {
    return;
  }
  const port = getPort();
  // Self-heal on every hook event so `/plugin update` mid-session takes
  // effect on the next hook, not the next cold start. ensureServerRunning
  // short-circuits when the collector is already version-matched — the
  // steady-state cost is one ~LAN probe.
  const configJson = await loadConfigJson();
  await ensureServerRunning(port, configJson);
  await sendHookEvent(event, port);
}
```

Note: `main` was previously not exported. Adding `export` enables the test to await it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/hook-client-units.test.ts`
Expected: PASS — `calls.length === 1` for the non-SessionStart event.

- [ ] **Step 6: Full hook-client test run + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/hook-client-units.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hook-client.ts tests/hook-client-units.test.ts
git commit -m "hook-client: self-heal on every hook event, not just SessionStart"
```

---

## Task 2: Pass AIOBS_RESPAWNED_FROM env when killing+respawning (TDD)

**Files:**
- Modify: `src/hook-client.ts`
- Test: `tests/hook-client-units.test.ts`

The previous health-info object holds the running collector's version. We pass it to `spawnCollector` so the new collector can tag its first ~60 s of spans.

- [ ] **Step 1: Write the failing test**

Append to `tests/hook-client-units.test.ts`:

```ts
  it("spawnCollector receives AIOBS_RESPAWNED_FROM env when replacing a stale collector", async () => {
    let observedEnv: NodeJS.ProcessEnv | null = null;
    const { spawn } = await import("node:child_process");
    const origSpawn = spawn;
    // @ts-expect-error — override for test
    (await import("node:child_process")).spawn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      observedEnv = opts.env;
      return { unref() {} } as unknown as ReturnType<typeof origSpawn>;
    }) as typeof spawn;
    try {
      const mod = await import("../src/hook-client.js");
      await mod.spawnCollector(19877, "{}", { fromVersion: "0.2.1" });
      expect(observedEnv).not.toBeNull();
      expect(observedEnv!.AIOBS_RESPAWNED_FROM).toBe("0.2.1");
    } finally {
      // @ts-expect-error — restore
      (await import("node:child_process")).spawn = origSpawn;
    }
  });
```

**Note:** if `spawnCollector` is currently private, export it for testability. The new optional argument `{ fromVersion }` lets callers pass the previous version. Existing callers that omit the argument get `undefined` and no env var is added.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hook-client-units.test.ts -t "AIOBS_RESPAWNED_FROM"`
Expected: FAIL — `spawnCollector` doesn't accept the option, doesn't set the env.

- [ ] **Step 3: Update spawnCollector signature + env**

In `src/hook-client.ts`, change `spawnCollector` (currently starts at line 243) to accept an options object and inject the env when set:

```ts
export async function spawnCollector(
  port: number,
  configJson: string,
  options: { fromVersion?: string } = {},
): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolve(here, "index.js");
  if (!existsSync(indexPath)) return;
  const dir = logDir();
  const out = openSync(join(dir, "collector.log"), "a");
  const err = openSync(join(dir, "collector.err.log"), "a");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.fromVersion) env.AIOBS_RESPAWNED_FROM = options.fromVersion;
    const child = spawn(process.execPath, [indexPath, "--serve", configJson], {
      detached: true,
      stdio: ["ignore", out, err],
      env,
    });
    child.unref();
  } catch {
    // ignore
  } finally {
    try { closeSync(out); } catch { /* ignore */ }
    try { closeSync(err); } catch { /* ignore */ }
  }
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const next = await probeHealth(port, 200);
    if (next && next.version === PLUGIN_VERSION) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

- [ ] **Step 4: Wire the option through ensureServerRunning**

In `src/hook-client.ts` `ensureServerRunning`, locate the existing `spawnCollector` call inside the "Step 3b" block (currently around line 336). Replace it so the previous version is forwarded:

```ts
          const toEvict = recheck?.ok ? recheck : info?.ok ? info : null;
          const fromVersion = toEvict?.version;
          if (toEvict) {
            await killStaleCollector(
              toEvict.version
                ? `version mismatch (running=${toEvict.version}, expected=${PLUGIN_VERSION})`
                : "legacy collector without version metadata",
              toEvict,
              port,
            );
          }
          await spawnCollector(port, configJson, { fromVersion });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/hook-client-units.test.ts -t "AIOBS_RESPAWNED_FROM"`
Expected: PASS.

- [ ] **Step 6: Full typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run tests/hook-client-units.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hook-client.ts tests/hook-client-units.test.ts
git commit -m "hook-client: propagate prior version as AIOBS_RESPAWNED_FROM on respawn"
```

---

## Task 3: Collector tags its first ~60 s of spans with respawned_from_version (TDD)

**Files:**
- Modify: `src/index.ts`
- Test: `tests/server-lifecycle.test.ts`

The collector reads `AIOBS_RESPAWNED_FROM` at startup, calls `Sentry.setTag`, and schedules a clear via `setTimeout` so it doesn't persist forever.

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
  it("collector sets claude_code.collector.respawned_from_version when AIOBS_RESPAWNED_FROM env is present", async () => {
    const tags: Record<string, string | undefined> = {};
    const fakeSentry = {
      init: () => undefined,
      setTag: (k: string, v: string | undefined) => { tags[k] = v; },
      setUser: () => undefined,
      getCurrentScope: () => ({ setTag: () => undefined }),
    };
    const prev = process.env.AIOBS_RESPAWNED_FROM;
    process.env.AIOBS_RESPAWNED_FROM = "0.2.1";
    try {
      const { applyRespawnTag } = await import("../src/index.js");
      applyRespawnTag(fakeSentry as never);
      expect(tags["claude_code.collector.respawned_from_version"]).toBe("0.2.1");
    } finally {
      if (prev === undefined) delete process.env.AIOBS_RESPAWNED_FROM;
      else process.env.AIOBS_RESPAWNED_FROM = prev;
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "respawned_from_version"`
Expected: FAIL — `applyRespawnTag` is not exported.

- [ ] **Step 3: Implement applyRespawnTag**

In `src/index.ts`, add this exported function above `startCollector`:

```ts
import type * as SentryNS from "@sentry/node";

const RESPAWN_TAG_TTL_MS = 60_000;

export function applyRespawnTag(sentry: typeof SentryNS): void {
  const fromVersion = process.env.AIOBS_RESPAWNED_FROM;
  if (!fromVersion) return;
  try {
    sentry.setTag("claude_code.collector.respawned_from_version", fromVersion);
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      sentry.setTag("claude_code.collector.respawned_from_version", undefined);
    } catch { /* ignore */ }
  }, RESPAWN_TAG_TTL_MS);
  // Don't keep the process alive past its natural lifetime.
  if (typeof timer.unref === "function") timer.unref();
}
```

Note: the `SentryNS` type import is already declared at the top of `index.ts` (line 3). The new function reuses that type.

Then, inside `startCollector` (currently lines 25-60), after the existing `installGlobalHandlers(Sentry);` line and before `startServer(Sentry, config, {});`, add:

```ts
  applyRespawnTag(Sentry);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "respawned_from_version"`
Expected: PASS.

- [ ] **Step 5: Full typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run tests/server-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/server-lifecycle.test.ts
git commit -m "collector: tag first 60s of spans with respawned_from_version when env set"
```

---

## Task 4: selectTurn returns matchedBy discriminator (TDD)

**Files:**
- Modify: `src/transcript-reader.ts`
- Test: existing transcript-reader test file (or `tests/transcript-reader.test.ts` if present)

- [ ] **Step 1: Inspect existing tests for selectTurn**

Run: `grep -n "selectTurn" tests/*.test.ts`

If a dedicated transcript-reader test file exists, add tests there. Otherwise add to `tests/server-lifecycle.test.ts`.

- [ ] **Step 2: Write the failing tests**

Add these tests where `selectTurn` is exercised:

```ts
import { selectTurn, readTranscript } from "../src/transcript-reader.js";

describe("selectTurn matchedBy discriminator", () => {
  it("returns matchedBy='prompt_id' when promptId hits", () => {
    const result = {
      turns: [{ promptId: "p1", inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 8, model: "m", prompt: null, response: null, turnIndex: 0 }],
      byPromptId: new Map([["p1", { promptId: "p1", inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 8, model: "m", prompt: null, response: null, turnIndex: 0 }]]),
      degraded: false,
      session: {},
    };
    const out = selectTurn(result, "p1", 0);
    expect(out.matchedBy).toBe("prompt_id");
    expect(out.turn).not.toBeNull();
  });

  it("returns matchedBy='ordinal' when promptId misses but ordinal hits", () => {
    const turn = { promptId: null, inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 8, model: "m", prompt: null, response: null, turnIndex: 0 };
    const result = { turns: [turn], byPromptId: new Map(), degraded: false, session: {} };
    const out = selectTurn(result, null, 0);
    expect(out.matchedBy).toBe("ordinal");
    expect(out.turn).toBe(turn);
  });

  it("returns matchedBy='none' when neither matches", () => {
    const result = { turns: [], byPromptId: new Map(), degraded: false, session: {} };
    const out = selectTurn(result, "p1", 0);
    expect(out.matchedBy).toBe("none");
    expect(out.turn).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run --grep "matchedBy"`
Expected: FAIL — `selectTurn` returns `RealTurn | null`, not the new shape.

- [ ] **Step 4: Update selectTurn return type**

In `src/transcript-reader.ts`, replace the `selectTurn` function (currently lines 203-213) with:

```ts
export interface SelectTurnResult {
  turn: RealTurn | null;
  matchedBy: "prompt_id" | "ordinal" | "none";
}

export function selectTurn(
  result: TranscriptReadResult,
  promptId: string | null | undefined,
  ordinal: number,
): SelectTurnResult {
  if (promptId) {
    const byId = result.byPromptId.get(promptId);
    if (byId) return { turn: byId, matchedBy: "prompt_id" };
  }
  const t = result.turns[ordinal];
  if (t) return { turn: t, matchedBy: "ordinal" };
  return { turn: null, matchedBy: "none" };
}
```

- [ ] **Step 5: Update the one existing caller**

In `src/server.ts` (currently line 214), replace:

```ts
      const turn = selectTurn(result, record.currentPromptId, record.turnIndex);
      if (turn) tokens = turn;
```

with (just the shape change; the status logic comes in Task 5):

```ts
      const selected = selectTurn(result, record.currentPromptId, record.turnIndex);
      if (selected.turn) tokens = selected.turn;
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/transcript-reader.ts src/server.ts tests/
git commit -m "transcript-reader: selectTurn returns {turn,matchedBy} discriminator"
```

---

## Task 5: closeTurnSpan accepts tokenExtractionStatus (TDD)

**Files:**
- Modify: `src/spans.ts`
- Test: `tests/spans.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing `closeTurnSpan` describe block in `tests/spans.test.ts`:

```ts
  it("emits claude_code.token_extraction.status when CloseTurnInput.tokenExtractionStatus is set", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as never, turn, {
      tokens: { turnIndex: 0, inputTokens: 10, outputTokens: 5,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 15,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "sess-1",
      tokenExtractionStatus: "ok|matched_after_retry",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("ok|matched_after_retry");
  });

  it("omits claude_code.token_extraction.status when undefined", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as never, turn, {
      tokens: { turnIndex: 0, inputTokens: 10, outputTokens: 5,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 15,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "sess-1",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/spans.test.ts -t "token_extraction"`
Expected: FAIL — attribute undefined / type error on the input field.

- [ ] **Step 3: Extend CloseTurnInput and closeTurnSpan**

In `src/spans.ts`, modify the `CloseTurnInput` interface (currently lines 55-70) to add:

```ts
  /** Diagnostic: why per-turn tokens were or were not extracted from transcript.
   *  See spec docs/superpowers/specs/2026-05-20-collector-self-heal-and-zero-cost-diagnostics-design.md */
  tokenExtractionStatus?: string;
```

In `closeTurnSpan` body (around line 79), destructure the new field:

```ts
  const { tokens, responseModel, cost, response, turnStartTime, sessionId, toolCount, subagentCount, toolsUsed, tokenExtractionStatus } = input;
```

After the existing chat-child attribute writes (after the reasoning-tokens block added in 0.2.2), and **before** `chatSpan.end(endTime);`, emit the status:

```ts
  if (tokenExtractionStatus) {
    chatSpan.setAttribute(
      "claude_code.token_extraction.status",
      tokenExtractionStatus,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/spans.test.ts -t "token_extraction"`
Expected: PASS.

- [ ] **Step 5: Full typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run tests/spans.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/spans.ts tests/spans.test.ts
git commit -m "spans: optional token_extraction.status attribute on chat child"
```

---

## Task 6: closeCurrentTurn derives status + emits it (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-lifecycle.test.ts`

This task wires the four non-retry statuses (`ok`, `transcript_missing`, `matched_by_prompt_id`, `matched_by_ordinal`, `no_matching_turn`) through `closeCurrentTurn`. The retry status comes in Task 7.

- [ ] **Step 1: Inspect existing close-turn test fixtures**

Run: `grep -n "closeCurrentTurn\|transcript_missing\|UserPromptSubmit\|SessionEnd" tests/server-lifecycle.test.ts | head -20`

Identify how the existing tests construct fixtures with and without a transcript path.

- [ ] **Step 2: Write the failing tests**

Append to `tests/server-lifecycle.test.ts`:

```ts
  it("emits token_extraction.status=transcript_missing when transcriptPath empty", async () => {
    // Drive the collector through SessionStart + UserPromptSubmit#1 + UserPromptSubmit#2
    // with NO transcript_path on the SessionStart, so closeCurrentTurn falls through.
    // (Use existing fixture helpers in this file; if the file has a `runScenario` helper,
    // reuse it. Otherwise mirror the simplest existing closeTurnSpan-assert test in the
    // file.)
    const sentry = await runScenarioWithNoTranscript();
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("transcript_missing");
  });

  it("emits status=matched_by_ordinal when transcript has the turn and promptId is absent", async () => {
    const sentry = await runScenarioWithFlushedTranscript({ promptId: null });
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("ok");
    // Status is "ok" because tokens > 0; matchedBy is captured only when tokens === 0.
    // The decision tree in the spec elevates "ok" above the matcher identity.
  });

  it("emits status=no_matching_turn when transcript is empty/no real turns", async () => {
    const sentry = await runScenarioWithEmptyTranscript();
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("no_matching_turn");
  });

  it("emits status=turn_had_no_usage when matched turn has zero usage and retry also zero", async () => {
    const sentry = await runScenarioWithZeroUsageTurn();
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("turn_had_no_usage");
  });
```

**Important:** if `runScenarioWithNoTranscript`, `runScenarioWithFlushedTranscript`, `runScenarioWithEmptyTranscript`, and `runScenarioWithZeroUsageTurn` don't exist yet, you must add them as helpers in the same file. Model them on whatever closest pattern the existing tests use (look for existing `it(...)` blocks that drive `UserPromptSubmit` through `closeCurrentTurn`). The minimum helper needs to:

1. Build a `record` (or simulate the same state via the public `/hook` handler)
2. Write a temp transcript file with controlled content (or set transcriptPath to a nonexistent path for `transcript_missing`)
3. Trigger `closeCurrentTurn` (e.g., via a second UserPromptSubmit or SessionEnd)
4. Return the fake sentry instance so the test can inspect spans

Use `mkdtempSync` and `writeFileSync` for fixtures; clean up in `afterEach`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "token_extraction"`
Expected: FAIL — attributes are undefined because `closeCurrentTurn` doesn't yet emit them.

- [ ] **Step 4: Implement status derivation in closeCurrentTurn**

In `src/server.ts`, locate `closeCurrentTurn` (lines 191-270). Replace the section between `let tokens: CloseTurnInput["tokens"] = { ... };` and the `closeTurnSpan(sentry, ...)` call so it derives and passes the status:

```ts
  const closeCurrentTurn = (record: SessionRecord): void => {
    if (!record.currentTurnSpan) return;
    let tokens: CloseTurnInput["tokens"] = {
      turnIndex: record.turnIndex,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      model: record.model ?? null,
      prompt: null,
      response: null,
    };
    let parseDegraded = false;
    let sessionDims: { permissionMode?: string; agentName?: string; entrypoint?: string } = {};
    let tokenExtractionStatus = "transcript_missing";
    if (record.transcriptPath) {
      const result = readTranscript(record.transcriptPath);
      parseDegraded = result.degraded;
      sessionDims = result.session;
      const selected = selectTurn(result, record.currentPromptId, record.turnIndex);
      if (!selected.turn) {
        tokenExtractionStatus = "no_matching_turn";
      } else {
        tokens = selected.turn;
        if (tokens.inputTokens + tokens.outputTokens === 0) {
          tokenExtractionStatus = "turn_had_no_usage";
        } else {
          tokenExtractionStatus = "ok";
        }
      }
    }
    // ... existing cost-computation + attribute-emission block stays unchanged
```

Then in the `closeTurnSpan(sentry, record.currentTurnSpan, { ... }, config)` call, add:

```ts
        tokenExtractionStatus,
```

immediately after the existing `toolsUsed: Array.from(record.turnTools),` line.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "token_extraction"`
Expected: PASS (except possibly the retry test which is Task 7).

- [ ] **Step 6: Full typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "server: emit claude_code.token_extraction.status on chat child"
```

---

## Task 7: Bounded once-only late-flush retry (TDD)

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-lifecycle.test.ts`

When the matched turn has zero usage, sleep 200 ms and retry once. If the retry yields tokens, use them and set status to `ok|matched_after_retry`.

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
  it("emits status='ok|matched_after_retry' when first transcript read had 0 usage and second has usage", async () => {
    // Use a fixture where readTranscript returns a zero-usage turn on first call,
    // then a non-zero turn on second call. Easiest implementation: spy on
    // `readTranscript`, return the empty-usage version on call 1, populated on call 2.
    const { readTranscript } = await import("../src/transcript-reader.js");
    let callCount = 0;
    const empty = { turns: [{ promptId: null, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: "m", prompt: null, response: null, turnIndex: 0 }], byPromptId: new Map(), degraded: false, session: {} };
    const populated = { turns: [{ promptId: null, inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150, model: "m", prompt: null, response: null, turnIndex: 0 }], byPromptId: new Map(), degraded: false, session: {} };
    vi.spyOn(await import("../src/transcript-reader.js"), "readTranscript").mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? empty : populated;
    });
    try {
      const sentry = await runScenarioWithSomeTranscriptPath();
      const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
      expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("ok|matched_after_retry");
      expect(chat!.attrs["gen_ai.usage.input_tokens"]).toBe(100);
      expect(chat!.attrs["gen_ai.usage.output_tokens"]).toBe(50);
      expect(callCount).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
```

**Note:** if the existing tests don't use `vi.spyOn` on module exports, use the same stubbing technique they do. If `runScenarioWithSomeTranscriptPath` doesn't exist, add it as a thin helper that sets `record.transcriptPath` to a real temp file (the spy intercepts before the file content matters).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "matched_after_retry"`
Expected: FAIL — `closeCurrentTurn` doesn't retry.

- [ ] **Step 3: Make closeCurrentTurn async + add retry**

In `src/server.ts`, change `closeCurrentTurn` to async and insert the retry block after the initial `tokenExtractionStatus` derivation:

```ts
  const closeCurrentTurn = async (record: SessionRecord): Promise<void> => {
    if (!record.currentTurnSpan) return;
    let tokens: CloseTurnInput["tokens"] = {
      turnIndex: record.turnIndex,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      model: record.model ?? null,
      prompt: null,
      response: null,
    };
    let parseDegraded = false;
    let sessionDims: { permissionMode?: string; agentName?: string; entrypoint?: string } = {};
    let tokenExtractionStatus = "transcript_missing";
    if (record.transcriptPath) {
      const result = readTranscript(record.transcriptPath);
      parseDegraded = result.degraded;
      sessionDims = result.session;
      const selected = selectTurn(result, record.currentPromptId, record.turnIndex);
      if (!selected.turn) {
        tokenExtractionStatus = "no_matching_turn";
      } else {
        tokens = selected.turn;
        if (tokens.inputTokens + tokens.outputTokens === 0) {
          // Late-flush hypothesis: assistant usage may not yet be on disk.
          // Sleep briefly and try once more.
          await new Promise((r) => setTimeout(r, 200));
          const retry = readTranscript(record.transcriptPath);
          parseDegraded = retry.degraded;
          sessionDims = retry.session;
          const retrySelected = selectTurn(retry, record.currentPromptId, record.turnIndex);
          if (retrySelected.turn && (retrySelected.turn.inputTokens + retrySelected.turn.outputTokens) > 0) {
            tokens = retrySelected.turn;
            tokenExtractionStatus = "ok|matched_after_retry";
          } else {
            tokenExtractionStatus = "turn_had_no_usage";
          }
        } else {
          tokenExtractionStatus = "ok";
        }
      }
    }
    // ... rest of the function continues unchanged ...
```

- [ ] **Step 4: Update all callers of closeCurrentTurn**

`closeCurrentTurn` is now async. Update its three callers in `src/server.ts`:

1. `reapStaleSession` (line 183 area): change to `await closeCurrentTurn(record)`. The enclosing function must also become async — if it's already inside an async context, just add `await`. If it isn't, wrap with `void closeCurrentTurn(...).catch(() => {})` to preserve fire-and-forget semantics for the reaper.
2. `handleUserPrompt` (line 313 area): the surrounding handler returns void; either make it async + `await closeCurrentTurn(record)`, OR wrap with `void closeCurrentTurn(record).then(() => { /* rest of handler */ })`. The cleanest fix is to make `handleUserPrompt` itself async and `await` it from its caller.
3. `handleSessionEnd` (line 468 area): already async. Just `await closeCurrentTurn(record);`.

For (1) and (2), pick the pattern that touches the fewest signatures. If the dispatcher (`switch` in the `/hook` handler) doesn't await the per-event handlers today, you can keep `handleUserPrompt` synchronous and use:

```ts
    void closeCurrentTurn(record).then(() => {
      record.turnIndex += 1;
      record.currentTurnStart = Date.now() / 1000;
      record.currentTurnSpan = openTurnTransaction(
        // ... existing args ...
      );
      // ... existing post-close logic ...
    }).catch(() => { /* ignore */ });
```

Inspect the existing handler to confirm. The retry budget of 200 ms is well below the request-handler timeout.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/server-lifecycle.test.ts -t "matched_after_retry"`
Expected: PASS.

- [ ] **Step 6: Full test suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "server: 200ms once-only retry on turn_had_no_usage (late-flush mitigation)"
```

---

## Task 8: Full test + typecheck + smoke

**Files:** none (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: PASS (no tsc errors).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: 400+ tests pass.

- [ ] **Step 3: Smoke**

Run: `npm run smoke`
Expected: `Smoke test PASSED.`

- [ ] **Step 4: Verify scripts/*.js is in sync**

The CI workflow asserts `scripts/*.js` is built from `src/*.ts`. Stage any rebuilt JS:

```bash
git status -s scripts/
```

If anything is modified:

```bash
git add scripts/
git commit -m "build: rebuild scripts/*.js from src/ for CI sync check"
```

If nothing changed, no commit needed.

---

## Task 9: Bump version in ALL THREE files + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `CHANGELOG.md`

Per the memory `release-version-files`: bumping `package.json` alone is insufficient. The release workflow keys off `plugin.json`; Claude Code's `/plugin update` reads `marketplace.json`.

- [ ] **Step 1: Bump package.json**

In `package.json`, change `"version": "0.2.2"` to `"version": "0.2.3"`.

- [ ] **Step 2: Bump plugin.json**

In `.claude-plugin/plugin.json`, change `"version": "0.2.2"` to `"version": "0.2.3"`.

- [ ] **Step 3: Bump marketplace.json**

In `.claude-plugin/marketplace.json`, change `"version": "0.2.2"` to `"version": "0.2.3"`.

- [ ] **Step 4: Inspect existing CHANGELOG style**

Run: `head -12 CHANGELOG.md`
Note the heading format used by adjacent entries.

- [ ] **Step 5: Add the entry**

Prepend an entry under the top of the changelog, in the same style as adjacent entries:

```markdown
## [0.2.3] - 2026-05-20

### Added

- **Mid-session self-heal.** `ensureServerRunning` now runs on every hook
  event, not just `SessionStart`. After `/plugin update`, the next hook
  event detects the version mismatch, kills the stale collector, and
  spawns the new one — no user intervention needed.
- **`claude_code.collector.respawned_from_version`** tag, set on every
  span for the first 60 seconds after a self-heal respawn. Makes the
  upgrade observable directly in Sentry.
- **`claude_code.token_extraction.status`** diagnostic attribute on
  `gen_ai.chat` children. Values: `ok`, `ok|matched_after_retry`,
  `transcript_missing`, `no_matching_turn`, `turn_had_no_usage`. Quantifies
  in Sentry queries why a turn produced zero tokens.
- **Late-flush retry.** When `closeCurrentTurn` finds a matched turn with
  zero usage, the collector sleeps 200 ms and re-reads the transcript
  once before emitting. Hypothesised cause of recent zero-token chat
  spans on otherwise normal turns.
```

- [ ] **Step 6: Final verify**

Run: `npm run ci`
Expected: PASS — typecheck + unit + smoke all green.

- [ ] **Step 7: Commit**

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json CHANGELOG.md
git commit -m "release: 0.2.3 — mid-session self-heal + zero-cost diagnostics + late-flush retry"
```

---

## Done criteria

- All nine tasks committed.
- `npm run ci` green.
- Branch ready to PR; CI's "assert scripts/*.js is in sync with src/" passes (i.e., `npm run build` produced no untracked changes after Task 8 — or any rebuilt JS was committed in Task 8 step 4).
- After merge, GitHub release workflow auto-tags `v0.2.3` (because `.claude-plugin/plugin.json` changed) and Claude Code `/plugin update` surfaces 0.2.3 (because `.claude-plugin/marketplace.json` changed).

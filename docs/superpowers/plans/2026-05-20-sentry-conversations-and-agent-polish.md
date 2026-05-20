# Sentry Conversations + Agent Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claude-code-ai-observability plugin populate Sentry's new Conversations view correctly, mirror agent names onto chat children, emit estimated reasoning tokens for extended-thinking turns, and document the 100% trace sampling recommendation.

**Architecture:** Additive attribute changes on existing spans (no new span types). Thread `sessionId` into `createToolSpan` and the subagent pipeline so every span carries `gen_ai.conversation.id`. Extend the transcript extractor to count thinking-block characters and emit an estimated reasoning-tokens attribute (flagged as estimated). README-only sampling guidance.

**Tech Stack:** TypeScript, `@sentry/node` v9, vitest, Node ≥18.

**Spec:** `docs/superpowers/specs/2026-05-20-sentry-conversations-and-agent-polish-design.md`

---

## File Map

| File | Role |
|---|---|
| `src/transcript.ts` (modify) | Add `reasoningTokens` + `reasoningEstimated` to `TurnTokens` and `SidechainUsage`. Sum `ceil(len/4)` over `thinking` blocks during transcript scan. |
| `src/types.ts` (modify) | Add new fields to `TurnTokens` interface. |
| `src/spans.ts` (modify) | `createToolSpan` takes `sessionId`. `closeTurnSpan` writes `gen_ai.agent.name` on the chat child and emits reasoning attrs when present. |
| `src/subagent.ts` (modify) | `createSubagentSpan` writes `gen_ai.conversation.id`. `attachChatChild` writes `gen_ai.conversation.id`, `gen_ai.agent.name`, and reasoning attrs. `ActiveSubagent` carries `sessionId`. |
| `src/server.ts` (modify) | Pass `event.session_id` into `createToolSpan`. |
| `tests/transcript.test.ts` (modify) | Cover thinking-block extraction (turn + sidechain). |
| `tests/spans.test.ts` (modify) | Cover conversation.id on tool span; agent.name + reasoning on chat child. |
| `tests/subagent.test.ts` (modify) | Cover conversation.id on subagent + chat child; agent.name on chat child. |
| `README.md` (modify) | Add Sampling subsection. |
| `CHANGELOG.md`, `package.json` (modify) | Version bump + entry. |

---

## Task 1: Add reasoningTokens fields to types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Extend TurnTokens with reasoning fields**

Open `src/types.ts`. Modify the `TurnTokens` interface (currently lines 9–19) to:

```ts
export interface TurnTokens {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  model: string | null;
  prompt: string | null;
  response: string | null;
  /** Estimated reasoning (thinking) tokens summed from transcript thinking
   *  blocks. Anthropic's usage record does not break thinking out of
   *  output_tokens, so this is a heuristic (ceil(chars/4)) per thinking
   *  block. When present, callers MUST also emit
   *  claude_code.reasoning_tokens.estimated=true. */
  reasoningTokens?: number;
  reasoningEstimated?: boolean;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "types: add optional reasoningTokens/reasoningEstimated to TurnTokens"
```

---

## Task 2: Transcript extractor — count thinking blocks (turn-level, TDD)

**Files:**
- Modify: `src/transcript.ts`
- Test: `tests/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/transcript.test.ts` inside the existing `describe("extractPerTurnTokens", ...)` block:

```ts
  it("estimates reasoning tokens from thinking blocks", () => {
    const thinkingText = "a".repeat(40); // 40 chars → ceil(40/4) = 10 tokens
    const p = make(
      JSON.stringify({ type: "user", message: { content: "go" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 30 },
          content: [
            { type: "thinking", thinking: thinkingText },
            { type: "text", text: "done" },
          ],
        },
      }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].reasoningTokens).toBe(10);
    expect(turns[0].reasoningEstimated).toBe(true);
  });

  it("omits reasoning fields when no thinking block present", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "go" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 30 },
          content: [{ type: "text", text: "done" }],
        },
      }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns[0].reasoningTokens).toBeUndefined();
    expect(turns[0].reasoningEstimated).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/transcript.test.ts`
Expected: FAIL — `Expected 10, got undefined` (or similar) on the first new test.

- [ ] **Step 3: Implement the thinking-block scanner**

In `src/transcript.ts`, add this helper above `extractPerTurnTokens` (after `extractTextFromContent`, around line 49):

```ts
function estimateReasoningTokensFromContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string") {
        total += Math.ceil(b.thinking.length / 4);
      }
    }
  }
  return total;
}
```

Then, inside `extractPerTurnTokens`, immediately after the existing `if (parsed.message?.model) current.model = parsed.message.model;` line (currently line 95), add:

```ts
      const reasoning = estimateReasoningTokensFromContent(parsed.message?.content);
      if (reasoning > 0) {
        current.reasoningTokens = (current.reasoningTokens ?? 0) + reasoning;
        current.reasoningEstimated = true;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcript.test.ts`
Expected: PASS — all transcript tests green.

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts
git commit -m "transcript: estimate reasoning tokens from thinking blocks (per-turn)"
```

---

## Task 3: Transcript extractor — thinking blocks for sidechain usage (TDD)

**Files:**
- Modify: `src/transcript.ts`
- Test: `tests/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/transcript.test.ts` (anywhere after the existing sidechain tests, or at end of file):

```ts
describe("extractSidechainUsage reasoning tokens", () => {
  const files: string[] = [];
  function make(content: string): string {
    const p = tmpFile(content);
    files.push(p);
    return p;
  }
  afterEach(() => {
    for (const f of files.splice(0)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it("aggregates reasoning tokens across assistant messages", () => {
    const p = make(
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "go" }, timestamp: "2026-05-20T00:00:00Z" }) + "\n" +
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-20T00:00:05Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 20 },
          content: [
            { type: "thinking", thinking: "x".repeat(20) }, // 5 tokens
            { type: "text", text: "ok" },
          ],
        },
      }) + "\n" +
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-20T00:00:10Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 20 },
          content: [
            { type: "thinking", thinking: "y".repeat(12) }, // 3 tokens
          ],
        },
      }) + "\n"
    );
    const usage = extractSidechainUsage(p);
    expect(usage).not.toBeNull();
    expect(usage!.reasoningTokens).toBe(8);
    expect(usage!.reasoningEstimated).toBe(true);
  });

  it("leaves reasoning fields undefined when no thinking blocks", () => {
    const p = make(
      JSON.stringify({ type: "user", isSidechain: true, message: { content: "go" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 5, output_tokens: 20 },
          content: [{ type: "text", text: "ok" }],
        },
      }) + "\n"
    );
    const usage = extractSidechainUsage(p);
    expect(usage!.reasoningTokens).toBeUndefined();
    expect(usage!.reasoningEstimated).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transcript.test.ts`
Expected: FAIL on the new `aggregates reasoning tokens` test (TS error about `reasoningTokens` not existing on `SidechainUsage`, then assertion failure once that's fixed).

- [ ] **Step 3: Add reasoning fields to SidechainUsage**

In `src/transcript.ts`, extend the `SidechainUsage` interface (currently lines 106–118) to include:

```ts
  /** Estimated reasoning tokens summed from thinking blocks across all
   *  assistant messages in this sidechain. See note in TurnTokens. */
  reasoningTokens?: number;
  reasoningEstimated?: boolean;
```

- [ ] **Step 4: Implement the aggregation**

Inside `extractSidechainUsage`, add a local accumulator. After `let assistantTurnCount = 0;` (line 146), add:

```ts
  let reasoningTokens = 0;
```

Inside the `if (parsed.type === "assistant")` block, after the existing `if (parsed.message?.model) model = parsed.message.model;` (line 177), add:

```ts
      reasoningTokens += estimateReasoningTokensFromContent(parsed.message?.content);
```

Then update the returned object (currently lines 181–190) to include the new fields:

```ts
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    model,
    startTime,
    endTime,
    assistantTurnCount,
    ...(reasoningTokens > 0
      ? { reasoningTokens, reasoningEstimated: true }
      : {}),
  };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcript.test.ts`
Expected: PASS — all transcript tests green.

- [ ] **Step 6: Commit**

```bash
git add src/transcript.ts tests/transcript.test.ts
git commit -m "transcript: estimate reasoning tokens from thinking blocks (sidechain)"
```

---

## Task 4: createToolSpan threads sessionId → gen_ai.conversation.id (TDD)

**Files:**
- Modify: `src/spans.ts`
- Modify: `src/server.ts`
- Test: `tests/spans.test.ts`

- [ ] **Step 1: Inspect the existing spans test layout**

Run: `grep -n "createToolSpan\|describe(" tests/spans.test.ts | head -30`

This shows the existing `createToolSpan` test block — model new assertions on its style.

- [ ] **Step 2: Write the failing test**

Append a new test inside the existing `createToolSpan` describe block in `tests/spans.test.ts`:

```ts
  it("sets gen_ai.conversation.id from sessionId", () => {
    const sentry = makeFakeSentry();
    const span = createToolSpan(
      sentry as any,
      null,
      "Bash",
      { command: "ls" },
      defaultConfig(),
      undefined,
      "tool-use-id-1",
      "session-xyz",
    );
    const created = sentry.lastStartInactiveSpanArgs!;
    expect(created.attributes["gen_ai.conversation.id"]).toBe("session-xyz");
    span.end();
  });
```

(If your `tests/spans.test.ts` uses different fake/builder names, mirror the existing test in the same describe block — the only new behavior is the trailing `sessionId` argument and the `gen_ai.conversation.id` assertion.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/spans.test.ts`
Expected: FAIL — TypeScript error (extra argument) and/or assertion failure.

- [ ] **Step 4: Extend createToolSpan signature**

In `src/spans.ts`, update `createToolSpan` (currently starts at line 149). Add a trailing optional `sessionId` parameter and emit the attribute:

```ts
export function createToolSpan(
  sentry: SentryNs,
  parentSpan: Span | null,
  toolName: string,
  input: unknown,
  config: ResolvedPluginConfig,
  startTime?: number,
  toolUseId?: string,
  sessionId?: string,
): Span {
  const start = (): Span => {
    const span = sentry.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      startTime,
      ...(parentSpan ? {} : { forceTransaction: true }),
      attributes: {
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.type": "function",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        ...(toolUseId ? { "gen_ai.tool.call.id": toolUseId } : {}),
        ...(sessionId ? { "gen_ai.conversation.id": sessionId } : {}),
      },
    });
    if (config.recordInputs && input !== undefined) {
      span.setAttribute(
        "gen_ai.tool.input",
        serialize(input, config.maxAttributeLength),
      );
    }
    return span;
  };
  if (parentSpan) {
    return sentry.withActiveSpan(parentSpan, start);
  }
  return start();
}
```

- [ ] **Step 5: Update the call site in server.ts**

In `src/server.ts`, around line 273, the existing `createToolSpan(...)` call is missing the trailing `sessionId` argument. Update it to:

```ts
    const span = createToolSpan(
      sentry,
      toolParent,
      event.tool_name,
      event.tool_input,
      config,
      undefined,
      event.tool_use_id,
      event.session_id,
    );
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/spans.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/spans.ts src/server.ts tests/spans.test.ts
git commit -m "spans: propagate gen_ai.conversation.id onto tool spans"
```

---

## Task 5: closeTurnSpan — agent.name + reasoning on chat child (TDD)

**Files:**
- Modify: `src/spans.ts`
- Test: `tests/spans.test.ts`

- [ ] **Step 1: Inspect existing closeTurnSpan test**

Run: `grep -n "closeTurnSpan\|gen_ai.agent.name\|gen_ai.usage.output_tokens.reasoning" tests/spans.test.ts | head -20`

Identify the helper that captures attributes set on the chat child span. Mirror its style.

- [ ] **Step 2: Write the failing tests**

Append two tests inside the existing `closeTurnSpan` describe block in `tests/spans.test.ts`:

```ts
  it("sets gen_ai.agent.name=claude-code on the chat child", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as any, "session-abc", 0, "prompt", {}, defaultConfig(), "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as any, turn, {
      tokens: { turnIndex: 0, inputTokens: 100, outputTokens: 50,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "session-abc",
    }, defaultConfig());
    const chat = sentry.findSpanByOp("gen_ai.chat");
    expect(chat.attributes["gen_ai.agent.name"]).toBe("claude-code");
  });

  it("emits reasoning attrs on chat child when tokens.reasoningTokens > 0", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as any, "session-abc", 0, "prompt", {}, defaultConfig(), "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as any, turn, {
      tokens: {
        turnIndex: 0, inputTokens: 100, outputTokens: 50,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150,
        model: "claude-sonnet-4-6", prompt: null, response: null,
        reasoningTokens: 17, reasoningEstimated: true,
      },
      sessionId: "session-abc",
    }, defaultConfig());
    const chat = sentry.findSpanByOp("gen_ai.chat");
    expect(chat.attributes["gen_ai.usage.output_tokens.reasoning"]).toBe(17);
    expect(chat.attributes["claude_code.reasoning_tokens.estimated"]).toBe(true);
  });

  it("does not emit reasoning attrs when tokens.reasoningTokens missing", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as any, "session-abc", 0, "prompt", {}, defaultConfig(), "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as any, turn, {
      tokens: { turnIndex: 0, inputTokens: 100, outputTokens: 50,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "session-abc",
    }, defaultConfig());
    const chat = sentry.findSpanByOp("gen_ai.chat");
    expect(chat.attributes["gen_ai.usage.output_tokens.reasoning"]).toBeUndefined();
    expect(chat.attributes["claude_code.reasoning_tokens.estimated"]).toBeUndefined();
  });
```

If the existing test file uses a different fake-sentry API (e.g., `sentry.spans[i].attributes`), adapt these assertions to that shape — the *behaviors* asserted are what matter.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/spans.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 4: Update closeTurnSpan**

In `src/spans.ts`, in the chat-child `attributes` block inside `closeTurnSpan` (currently lines 93–101), add `gen_ai.agent.name`:

```ts
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        "gen_ai.agent.name": "claude-code",
        ...(sessionId ? { "gen_ai.conversation.id": sessionId } : {}),
        ...(sessionId ? { "claude_code.session_id": sessionId } : {}),
        ...(respModel ? { "gen_ai.request.model": respModel } : {}),
        ...(respModel ? { "gen_ai.response.model": respModel } : {}),
      },
```

Then, immediately after the existing `chatSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);` (line 110) and the `cacheCreationTokens` block (lines 111–114), add the reasoning emission BEFORE `if (config.recordOutputs && response)`:

```ts
  if (tokens.reasoningTokens && tokens.reasoningTokens > 0) {
    chatSpan.setAttribute(
      "gen_ai.usage.output_tokens.reasoning",
      tokens.reasoningTokens,
    );
    if (tokens.reasoningEstimated) {
      chatSpan.setAttribute(
        "claude_code.reasoning_tokens.estimated",
        true,
      );
    }
  }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/spans.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/spans.ts tests/spans.test.ts
git commit -m "spans: emit gen_ai.agent.name + reasoning attrs on turn chat child"
```

---

## Task 6: createSubagentSpan emits gen_ai.conversation.id (TDD)

**Files:**
- Modify: `src/subagent.ts`
- Test: `tests/subagent.test.ts`

- [ ] **Step 1: Write the failing test**

Inspect existing subagent test patterns:

```bash
grep -n "createSubagentSpan\|gen_ai.conversation.id\|attachSubagentToEvent" tests/subagent.test.ts | head -20
```

Append a new test mirroring the existing style. Example:

```ts
  it("sets gen_ai.conversation.id from event.session_id", () => {
    const sentry = makeFakeSentry();
    const span = createSubagentSpan(sentry as any, {
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      tool_name: "Task",
      tool_use_id: "tu_1",
      tool_input: { subagent_type: "researcher", prompt: "find X", description: "research" },
    } as any);
    expect(span).not.toBeNull();
    const args = sentry.lastStartInactiveSpanArgs!;
    expect(args.attributes["gen_ai.conversation.id"]).toBe("sess-1");
    expect(args.attributes["gen_ai.agent.name"]).toBe("researcher");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subagent.test.ts`
Expected: FAIL — attribute undefined.

- [ ] **Step 3: Implement**

In `src/subagent.ts`, in `createSubagentSpan` (currently starts at line 68), add `gen_ai.conversation.id` to the `attributes` object. Replace the existing block at lines 77–85 with:

```ts
  const attributes: Record<string, string> = {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.system": "anthropic",
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.conversation.id": event.session_id,
  };
  if (subagentType) attributes["gen_ai.agent.name"] = subagentType;
  if (description) attributes["gen_ai.agent.description"] = scrubString(truncate(description, maxAttrLen));
  if (prompt) attributes["gen_ai.request.messages"] = scrubString(truncate(prompt, maxAttrLen));
  if (event.tool_use_id) attributes["gen_ai.tool.call.id"] = event.tool_use_id;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/subagent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "subagent: emit gen_ai.conversation.id on subagent wrapper span"
```

---

## Task 7: attachChatChild emits conversation.id, agent.name, reasoning (TDD)

**Files:**
- Modify: `src/subagent.ts`
- Test: `tests/subagent.test.ts`

`attachChatChild` is currently invoked from `attachSubagentToEvent` (PostToolUse path) and is the only consumer of `SidechainUsage`. It needs three new attributes on the synthesized chat child: `gen_ai.conversation.id`, `gen_ai.agent.name`, and the reasoning pair.

The cleanest plumbing is to widen the helper's signature: `attachChatChild(sentry, wrapper, usage, ctx)` where `ctx = { sessionId, subagentType }`. The single caller has both values in scope (it's reading from the `ActiveSubagent` entry it just popped).

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent.test.ts`. Use the existing pattern for driving `attachSubagentToEvent` PreToolUse → PostToolUse with a fake sidechain transcript on disk (or mock `extractSidechainUsage` if that's how existing tests do it):

```ts
  it("subagent chat child carries conversation.id, agent.name, reasoning", async () => {
    // Arrange: stub extractSidechainUsage to return a usage record including
    // reasoning tokens. Drive PreToolUse + PostToolUse to create the wrapper
    // and synthesize the chat child.
    const sentry = makeFakeSentry();
    const session = createSubagentSession();

    // PreToolUse
    attachSubagentToEvent(sentry as any, session, {
      hook_event_name: "PreToolUse",
      session_id: "sess-A",
      tool_name: "Task",
      tool_use_id: "tu_42",
      tool_input: { subagent_type: "researcher", prompt: "go" },
    } as any);

    // Stub the sidechain lookup so attachChatChild has usage to attach.
    // (Use vi.spyOn on the module export; see existing tests for the pattern.)
    vi.spyOn(transcriptMod, "extractSidechainUsage").mockReturnValue({
      inputTokens: 100, outputTokens: 50,
      cachedInputTokens: 0, cacheCreationTokens: 0,
      model: "claude-sonnet-4-6",
      startTime: undefined, endTime: undefined,
      assistantTurnCount: 1,
      reasoningTokens: 11, reasoningEstimated: true,
    });

    attachSubagentToEvent(sentry as any, session, {
      hook_event_name: "PostToolUse",
      session_id: "sess-A",
      tool_name: "Task",
      tool_use_id: "tu_42",
    } as any);

    const chat = sentry.findSpanByOp("gen_ai.chat");
    expect(chat.attributes["gen_ai.conversation.id"]).toBe("sess-A");
    expect(chat.attributes["gen_ai.agent.name"]).toBe("researcher");
    expect(chat.attributes["gen_ai.usage.output_tokens.reasoning"]).toBe(11);
    expect(chat.attributes["claude_code.reasoning_tokens.estimated"]).toBe(true);
  });
```

Adapt the fake-sentry helpers (`makeFakeSentry`, `findSpanByOp`) to whatever the existing test file already provides. If existing tests stub via a different mechanism (e.g., writing a real temp `.jsonl` and pointing the lookup at it), follow that pattern instead — the assertions are what matter.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subagent.test.ts`
Expected: FAIL — attributes undefined.

- [ ] **Step 3: Carry sessionId on ActiveSubagent**

In `src/subagent.ts`, extend the `ActiveSubagent` interface (currently lines 11–22) with:

```ts
  /** sessionId of the parent turn that spawned this subagent — replicated
   *  onto the synthesized chat child as gen_ai.conversation.id. */
  sessionId: string;
```

In `attachSubagentToEvent`, the PreToolUse branch (currently lines 112–127) builds the `ActiveSubagent` entry. Add `sessionId: pre.session_id` to the object:

```ts
    session.active.set(key, {
      span,
      subagentType: subagentType ?? "subagent",
      toolUseId: pre.tool_use_id,
      preExisting: subagentDir ? listAgentFiles(subagentDir) : undefined,
      subagentDir,
      startedAt: Date.now(),
      sessionId: pre.session_id,
    });
```

- [ ] **Step 4: Widen attachChatChild signature**

Replace the `attachChatChild` function signature and attributes block in `src/subagent.ts` (currently line 260). New signature:

```ts
interface ChatChildContext {
  sessionId: string;
  subagentType: string;
}

function attachChatChild(
  sentry: SentryLike,
  wrapper: Span,
  usage: SidechainUsage,
  ctx: ChatChildContext,
): void {
```

Inside `create()` (around line 267), extend the `attrs` block:

```ts
    const attrs: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.system": "anthropic",
      "gen_ai.conversation.id": ctx.sessionId,
      "gen_ai.agent.name": ctx.subagentType,
    };
    if (usage.model) {
      attrs["gen_ai.request.model"] = usage.model;
      attrs["gen_ai.response.model"] = usage.model;
    }
```

After the existing `trySetAttribute(chat, "gen_ai.usage.input_tokens.cache_write", usage.cacheCreationTokens);` block (line 297), emit reasoning:

```ts
  if (usage.reasoningTokens && usage.reasoningTokens > 0) {
    trySetAttribute(chat, "gen_ai.usage.output_tokens.reasoning", usage.reasoningTokens);
    if (usage.reasoningEstimated) {
      trySetAttribute(chat, "claude_code.reasoning_tokens.estimated", true);
    }
  }
```

- [ ] **Step 5: Update the caller**

In `attachSubagentToEvent`, the PostToolUse branch calls `attachChatChild(sentry, entry.span, usage);` (line 144). Update to pass the context:

```ts
      if (usage) {
        attachChatChild(sentry, entry.span, usage, {
          sessionId: entry.sessionId,
          subagentType: entry.subagentType,
        });
      }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx tsc --noEmit && npx vitest run tests/subagent.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "subagent: chat child carries conversation.id, agent.name, reasoning"
```

---

## Task 8: Full test suite + smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full unit run**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Smoke**

Run: `npm run smoke`
Expected: PASS. If the smoke test asserts on specific attributes and any of the new ones break it, **stop and report** — do not "fix" by removing the attribute. The smoke test should accept the additive change; if it doesn't, update the smoke test's expected set to include the new attributes.

- [ ] **Step 4: Commit (only if smoke test required updating)**

If the smoke fixture needed expansion to include new attributes:

```bash
git add scripts/smoke-test.sh
git commit -m "smoke: include new conversation/agent/reasoning attrs in expected set"
```

---

## Task 9: README — Sampling subsection

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the configuration section**

Run: `grep -n "tracesSampleRate\|## Configuration\|## Config" README.md`

Note the line number of the existing configuration heading. The Sampling subsection goes underneath it (or adjacent to other `tracesSampleRate` references).

- [ ] **Step 2: Add the Sampling subsection**

Insert the following block at the location chosen above:

```markdown
### Sampling

This plugin defaults `tracesSampleRate` to `1.0` (capture every trace) and
that is the **recommended** setting for AI traces.

Sentry uses head-based sampling: the sampling decision is made at the root
span and cascades to every child. If a turn's trace is dropped, every
nested LLM call, tool execution, and subagent span is dropped with it.
Lowering the sample rate means losing visibility into a proportional share
of agent failures — a 10% rate hides 90% of incidents.

Trace ingest cost is almost always negligible compared to the underlying
LLM API spend, so dropping AI traces to "save money on observability"
rarely pays off in practice. See [Sentry's sampling guidance for AI
agents](https://docs.sentry.io/ai/monitoring/agents/sampling/) for the
full rationale.

If you nonetheless need to lower it, set `CLAUDE_SENTRY_TRACES_SAMPLE_RATE`
or `tracesSampleRate` in your plugin config.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README sampling section recommending tracesSampleRate=1.0"
```

---

## Task 10: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.1.10"` to `"version": "0.1.11"`.

- [ ] **Step 2: Inspect existing CHANGELOG style**

Run: `head -40 CHANGELOG.md`
Note the heading format used by recent entries (e.g., `## 0.1.10 - YYYY-MM-DD`).

- [ ] **Step 3: Add the entry**

Prepend an entry under the top of the changelog (after any "Unreleased" header if one exists), in the same style as adjacent entries. Content:

```markdown
## 0.1.11 - 2026-05-20

### Added
- `gen_ai.conversation.id` propagated to subagent wrapper spans, the
  synthesized subagent chat child, and tool spans so Sentry's
  Conversations view groups the full call tree per session.
- `gen_ai.agent.name` mirrored onto synthesized chat children (`claude-code`
  on turn-level chat, `<subagent_type>` on subagent chat).
- Estimated `gen_ai.usage.output_tokens.reasoning` emitted for turns and
  sidechains containing `thinking` content blocks. Always paired with
  `claude_code.reasoning_tokens.estimated=true` so the heuristic is
  identifiable.
- README: new Sampling section recommending `tracesSampleRate: 1.0` for AI
  traces, citing Sentry's head-based sampling guidance.
```

- [ ] **Step 4: Final verify**

Run: `npm run ci`
Expected: PASS — typecheck + unit + smoke all green.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "release: 0.1.11 — Sentry Conversations + agent naming/cost/sampling polish"
```

---

## Done criteria

- All ten tasks completed, each ending in a committed change.
- `npm run ci` green.
- A live test session (developer's local Claude Code run, see the spec's "Manual verification" section) shows: one Conversations row groups turn + tool + subagent activity; chat spans filter by `gen_ai.agent.name`; cost panel reflects the reasoning rate when thinking was active.

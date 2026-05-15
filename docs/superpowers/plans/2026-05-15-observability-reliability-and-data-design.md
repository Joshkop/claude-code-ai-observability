# Observability Reliability & Data Design — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix per-turn token/cost misattribution, harden delivery, and add plugin/MCP/skill/subagent attribution in one release, sequenced correctness → reliability → new data.

**Architecture:** A new `src/transcript-reader.ts` becomes the single authority for turn segmentation, token aggregation, and sidechain isolation. `server.ts` keeps only triggering/timing/delivery and asks the reader for the current turn's numbers at turn-close. `cost.ts` gains tiered model matching, `attribution.ts` (new) parses MCP/skill/command/subagent source, `subagent.ts` becomes per-session and emits subagent telemetry, `hook-client.ts` retries once and tracks dropped events.

**Tech Stack:** TypeScript (ES2022, NodeNext), `@sentry/node` ^9, Vitest 3. Source in `src/`, tests in `tests/`, build `npm run build` (`tsc`), tests `npm test` (`vitest run`).

**Spec:** `docs/superpowers/specs/2026-05-15-observability-reliability-and-data-design.md`

---

## File Structure

**New files:**
- `src/transcript-reader.ts` — turn segmentation by `promptId`, per-real-turn token aggregation, sidechain isolation, session-dimension extraction (N4), C6 soft-fail validation. Re-exports `extractSidechainUsage` (ownership surface).
- `src/attribution.ts` — pure parsers: MCP tool name (N1), Skill input (N2), slash command (N2), subagent source-class incl. best-effort path inference (N3).
- `tests/transcript-reader.test.ts` — segmentation / degraded fallback regression gate.
- `tests/attribution.test.ts` — MCP / skill / command / subagent-source parsing.
- `docs/sentry-dashboard-migration.md` — corrected attribute semantics + new attributes for dashboard rebuild.

**Modified files:**
- `src/types.ts` — `prompt_id` on `UserPromptSubmitEvent`; `dropped_since_last` on the `_aiobs` envelope.
- `src/cost.ts` — tiered model resolution (C3) + `unpricedModel` on `TurnCost`.
- `src/transcript.ts` — `extractPerTurnTokens` retained as legacy fallback (unchanged); consumed by the reader.
- `src/spans.ts` — C2 token semantics in `closeTurnSpan`.
- `src/subagent.ts` — per-session keying (C5/N5), name+description sidechain match (C5), subagent telemetry + source-class (N3), nested parenting + depth (N5), C2 token semantics in `attachChatChild`.
- `src/server.ts` — reader integration + `promptId` correlation (C1), per-session git/cwd (C4), parse-degraded flag (C6), lazy session synthesis (R2), dropped-event attribute (R3), heartbeat (R4), MCP/skill/command/session-dim wiring (N1/N2/N4).
- `src/hook-client.ts` — retry-once + 1000ms timeout (R1), dropped-event counter file + piggyback (R3).
- `CHANGELOG.md`, `README.md`, `.claude-plugin/plugin.json`, `package.json` — migration notes + minor version bump.

**Sequencing:** Phase A (correctness, Tasks 1–9) → Phase B (reliability, Tasks 10–13) → Phase C (new data, Tasks 14–19) → Phase D (rollout, Tasks 20–21). Each phase is independently revertable by its commits.

---

# Phase A — Correctness

## Task 1: Add `prompt_id` to UserPromptSubmit + `dropped_since_last` to envelope

**Files:**
- Modify: `src/types.ts:89-106`

- [ ] **Step 1: Add the envelope + event fields**

In `src/types.ts`, replace the `AiobsEnvelope` interface (lines 89-92) with:

```ts
/** Wrapper field added by the hook-client to every outbound hook event. */
export interface AiobsEnvelope {
  _aiobs?: {
    context?: AiobsClientContext;
    /** R3: count of events the hook-client failed to deliver since the last
     *  successful POST. Piggybacked so loss is observable from Sentry. */
    dropped_since_last?: number;
  };
}
```

Then in the same file, add `prompt_id` to `UserPromptSubmitEvent` (currently lines 101-106):

```ts
export interface UserPromptSubmitEvent extends AiobsEnvelope {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt?: string;
  message?: string;
  /** C1: stable id of this prompt, used to correlate the collector's open
   *  turn to the transcript's real-turn line. Optional — absent on older
   *  Claude Code; collector falls back to ordinal among real turns. */
  prompt_id?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS (no emitted errors; this is a purely additive type change).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add prompt_id and dropped_since_last envelope fields

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `transcript-reader` — turn segmentation (C1) failing test

**Files:**
- Create: `src/transcript-reader.ts`
- Test: `tests/transcript-reader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/transcript-reader.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, selectTurn } from "../src/transcript-reader.js";

const files: string[] = [];
function make(content: string): string {
  const p = join(tmpdir(), `tr-test-${Date.now()}-${Math.random()}.jsonl`);
  writeFileSync(p, content, "utf8");
  files.push(p);
  return p;
}
afterEach(() => {
  for (const f of files.splice(0)) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
});

describe("readTranscript — turn segmentation (C1)", () => {
  it("treats a prompt + N tool_result user lines as ONE real turn", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "do it" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 100, output_tokens: 50 } } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 5 } } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok2" }] } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 7, output_tokens: 3 } } }),
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.degraded).toBe(false);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].promptId).toBe("p1");
    expect(r.turns[0].inputTokens).toBe(117);
    expect(r.turns[0].outputTokens).toBe(58);
  });

  it("keys real turns by promptId and ignores sidechain lines", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "turn 1" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 10, output_tokens: 2 } } }),
        JSON.stringify({ type: "assistant", isSidechain: true, message: { model: "m", usage: { input_tokens: 9999, output_tokens: 9999 } } }),
        JSON.stringify({ type: "user", promptId: "p2", message: { content: "turn 2" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 20, output_tokens: 4 } } }),
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.turns).toHaveLength(2);
    expect(r.byPromptId.get("p1")!.inputTokens).toBe(10);
    expect(r.byPromptId.get("p2")!.inputTokens).toBe(20);
    expect(selectTurn(r, "p2", 99)!.outputTokens).toBe(4);
    expect(selectTurn(r, undefined, 0)!.promptId).toBe("p1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcript-reader.test.ts`
Expected: FAIL — `Cannot find module '../src/transcript-reader.js'`.

- [ ] **Step 3: Implement `transcript-reader.ts`**

Create `src/transcript-reader.ts`:

```ts
import { readFileSync } from "node:fs";
import type { TurnTokens } from "./types.js";
import { extractPerTurnTokens } from "./transcript.js";
export { extractSidechainUsage, type SidechainUsage } from "./transcript.js";

export interface RealTurn extends TurnTokens {
  /** Stable prompt id from the user line, or null when absent. */
  promptId: string | null;
}

export interface SessionDimensions {
  permissionMode?: string;
  agentName?: string;
  entrypoint?: string;
}

export interface TranscriptReadResult {
  /** Real turns only, in transcript order. */
  turns: RealTurn[];
  byPromptId: Map<string, RealTurn>;
  /** C6: true when the JSONL shape was unrecognized and we fell back to
   *  legacy positional segmentation. */
  degraded: boolean;
  degradedReason?: string;
  session: SessionDimensions;
}

interface Line {
  type?: string;
  isSidechain?: boolean;
  promptId?: string;
  prompt_id?: string;
  permissionMode?: string;
  permission_mode?: string;
  agentName?: string;
  agent_name?: string;
  entrypoint?: string;
  message?: { model?: string; usage?: AssistantUsage; content?: unknown };
}

interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function emptyTurn(promptId: string | null, index: number): RealTurn {
  return {
    turnIndex: index,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    model: null,
    prompt: null,
    response: null,
    promptId,
  };
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const o = b as Record<string, unknown>;
      if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

function isToolResultUserLine(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
  );
}

function promptIdOf(l: Line): string | null {
  return l.promptId ?? l.prompt_id ?? null;
}

function collectSessionDims(l: Line, into: SessionDimensions): void {
  if (into.permissionMode === undefined) {
    into.permissionMode = l.permissionMode ?? l.permission_mode;
  }
  if (into.agentName === undefined) into.agentName = l.agentName ?? l.agent_name;
  if (into.entrypoint === undefined) into.entrypoint = l.entrypoint;
}

function legacyResult(path: string, reason: string): TranscriptReadResult {
  const turns = extractPerTurnTokens(path).map<RealTurn>((t) => ({ ...t, promptId: null }));
  return {
    turns,
    byPromptId: new Map(),
    degraded: true,
    degradedReason: reason,
    session: {},
  };
}

export function readTranscript(path: string): TranscriptReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { turns: [], byPromptId: new Map(), degraded: false, session: {} };
  }

  const rawLines = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  if (rawLines.length === 0) {
    return { turns: [], byPromptId: new Map(), degraded: false, session: {} };
  }

  const parsed: Line[] = [];
  let recognizedTypeLines = 0;
  for (const ln of rawLines) {
    try {
      const o = JSON.parse(ln) as Line;
      parsed.push(o);
      if (typeof o.type === "string") recognizedTypeLines += 1;
    } catch {
      // skip unparseable line
    }
  }

  // C6: nothing parsed as a typed transcript line → unknown schema.
  if (recognizedTypeLines === 0) {
    return legacyResult(path, "no recognizable transcript line types");
  }

  const turns: RealTurn[] = [];
  const byPromptId = new Map<string, RealTurn>();
  const session: SessionDimensions = {};
  let current: RealTurn | null = null;
  let realIndex = -1;
  let sawAssistantUsage = false;

  for (const l of parsed) {
    collectSessionDims(l, session);
    if (l.type === "user") {
      if (l.isSidechain === true) continue;
      if (isToolResultUserLine(l.message?.content)) continue;
      if (current) turns.push(current);
      realIndex += 1;
      const pid = promptIdOf(l);
      current = emptyTurn(pid, realIndex);
      const t = textFromContent(l.message?.content);
      if (t) current.prompt = t;
      if (pid) byPromptId.set(pid, current);
      continue;
    }
    if (l.type === "assistant") {
      if (l.isSidechain === true) continue; // sidechain isolation
      if (!current) {
        realIndex += 1;
        current = emptyTurn(null, realIndex);
      }
      const u = l.message?.usage;
      if (u) {
        sawAssistantUsage = true;
        const inp = u.input_tokens ?? 0;
        const cc = u.cache_creation_input_tokens ?? 0;
        const cr = u.cache_read_input_tokens ?? 0;
        const out = u.output_tokens ?? 0;
        current.inputTokens += inp + cc + cr;
        current.cachedInputTokens += cr;
        current.cacheCreationTokens += cc;
        current.outputTokens += out;
        current.totalTokens = current.inputTokens + current.outputTokens;
      }
      if (l.message?.model) current.model = l.message.model;
      const t = textFromContent(l.message?.content);
      if (t) current.response = current.response ? `${current.response}\n${t}` : t;
    }
  }
  if (current) turns.push(current);

  // C6: we recognized line types but couldn't segment any real turn even
  // though assistant usage exists → segmentation contract broke.
  if (turns.length === 0 && sawAssistantUsage) {
    return legacyResult(path, "no real-turn boundaries despite assistant usage");
  }

  return { turns, byPromptId, degraded: false, session };
}

/**
 * C1: correlate the collector's open turn to a transcript turn.
 * promptId wins; otherwise ordinal among REAL turns (never among all
 * type:"user" lines).
 */
export function selectTurn(
  result: TranscriptReadResult,
  promptId: string | null | undefined,
  ordinal: number,
): RealTurn | null {
  if (promptId) {
    const byId = result.byPromptId.get(promptId);
    if (byId) return byId;
  }
  return result.turns[ordinal] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transcript-reader.test.ts`
Expected: PASS (both tests green).

- [ ] **Step 5: Commit**

```bash
git add src/transcript-reader.ts tests/transcript-reader.test.ts
git commit -m "feat(transcript-reader): real-turn segmentation keyed by promptId (C1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `transcript-reader` — C6 soft-fail + N4 session dims tests

**Files:**
- Test: `tests/transcript-reader.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/transcript-reader.test.ts`:

```ts
describe("readTranscript — C6 soft-fail", () => {
  it("degrades to legacy positional when no line has a recognizable type", () => {
    const p = make(
      [JSON.stringify({ foo: 1 }), JSON.stringify({ bar: 2 })].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toMatch(/no recognizable transcript line types/);
  });

  it("does NOT degrade on a well-formed transcript", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 5, output_tokens: 1 } } }),
      ].join("\n"),
    );
    expect(readTranscript(p).degraded).toBe(false);
  });
});

describe("readTranscript — N4 session dimensions", () => {
  it("extracts permission_mode / agent_name / entrypoint from metadata lines", () => {
    const p = make(
      [
        JSON.stringify({ type: "summary", permissionMode: "bypassPermissions", agentName: "claude-code", entrypoint: "cli" }),
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "hi" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 5, output_tokens: 1 } } }),
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.session.permissionMode).toBe("bypassPermissions");
    expect(r.session.agentName).toBe("claude-code");
    expect(r.session.entrypoint).toBe("cli");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/transcript-reader.test.ts`
Expected: PASS — the Task 2 implementation already satisfies these (regression lock for C6 + N4).

- [ ] **Step 3: Commit**

```bash
git add tests/transcript-reader.test.ts
git commit -m "test(transcript-reader): lock C6 soft-fail + N4 session dims

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Cost — tiered model resolution (C3) failing test

**Files:**
- Modify: `src/cost.ts:5-9` (TurnCost), `src/cost.ts:55-87` (computeCost)
- Test: `tests/cost.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/cost.test.ts` (inside the file, after the existing `describe` blocks):

```ts
import { resolveModelPrice } from "../src/cost.js";

describe("C3 — tiered model resolution", () => {
  it("exact key wins", () => {
    expect(resolveModelPrice("claude-opus-4-7", DEFAULT_PRICE_TABLE)!.input).toBe(15);
  });

  it("date-suffixed model resolves via prefix", () => {
    const e = resolveModelPrice("claude-opus-4-7-20260101", DEFAULT_PRICE_TABLE);
    expect(e!.input).toBe(15);
  });

  it("family heuristic maps unknown sonnet to the sonnet default", () => {
    const e = resolveModelPrice("claude-sonnet-9-9-experimental", DEFAULT_PRICE_TABLE);
    expect(e!.input).toBe(3);
  });

  it("truly unknown model is unpriced and flagged", () => {
    const cost = computeCost(
      { model: "gpt-4o", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 },
      DEFAULT_PRICE_TABLE,
    );
    expect(cost.totalCost).toBe(0);
    expect(cost.unpricedModel).toBe("gpt-4o");
  });

  it("priced model leaves unpricedModel undefined", () => {
    const cost = computeCost(
      { model: "claude-opus-4-7", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 },
      DEFAULT_PRICE_TABLE,
    );
    expect(cost.unpricedModel).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cost.test.ts`
Expected: FAIL — `resolveModelPrice` is not exported; `cost.unpricedModel` is `undefined` where the test expects `"gpt-4o"`.

- [ ] **Step 3: Implement tiered resolution**

In `src/cost.ts`, change the `TurnCost` interface (lines 5-9) to:

```ts
export interface TurnCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** Set to the raw model string when no price entry could be resolved. */
  unpricedModel?: string;
}
```

Add, immediately after `DEFAULT_PRICE_TABLE` (after line 25):

```ts
const FAMILY_DEFAULT_KEY: Record<"opus" | "sonnet" | "haiku", string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

function familyOf(model: string): "opus" | "sonnet" | "haiku" | null {
  const s = model.toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return null;
}

/**
 * C3: exact key → strip trailing -YYYYMMDD → table key is a prefix →
 * family heuristic → null (unpriced).
 */
export function resolveModelPrice(
  model: string,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): ModelPriceEntry | null {
  if (table[model]) return table[model];

  const stripped = model.replace(/-\d{8}$/, "");
  if (stripped !== model && table[stripped]) return table[stripped];

  for (const k of Object.keys(table)) {
    if (model === k || model.startsWith(k + "-")) return table[k];
    if (stripped === k || stripped.startsWith(k + "-")) return table[k];
  }

  const fam = familyOf(model);
  if (fam) {
    for (const [k, v] of Object.entries(table)) {
      if (k.includes(fam)) return v;
    }
    const def = DEFAULT_PRICE_TABLE[FAMILY_DEFAULT_KEY[fam]];
    if (def) return def;
  }
  return null;
}
```

Then replace the body of `computeCost` (lines 55-87) with:

```ts
export function computeCost(
  input: ComputeCostInput,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): TurnCost {
  const zero: TurnCost = { inputCost: 0, outputCost: 0, totalCost: 0 };

  if (!input || !input.model) return zero;
  const price = resolveModelPrice(input.model, table);
  if (!price) return { ...zero, unpricedModel: input.model };

  const inputTokens = toNonNegInt(input.inputTokens);
  const cachedInputTokens = Math.min(toNonNegInt(input.cachedInputTokens), inputTokens);
  const cacheCreationTokens = Math.min(
    toNonNegInt(input.cacheCreationTokens),
    Math.max(0, inputTokens - cachedInputTokens),
  );
  const outputTokens = toNonNegInt(input.outputTokens);
  const nonCachedInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);

  const inputMicros =
    nonCachedInput * priceToMicrosPerToken(price.input) +
    cachedInputTokens * priceToMicrosPerToken(price.cacheRead) +
    cacheCreationTokens * priceToMicrosPerToken(price.cacheCreation);
  const outputMicros = outputTokens * priceToMicrosPerToken(price.output);

  const inputCost = inputMicros / MICRO;
  const outputCost = outputMicros / MICRO;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cost.test.ts`
Expected: PASS (new C3 block + all pre-existing cost tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/cost.ts tests/cost.test.ts
git commit -m "feat(cost): tiered model resolution + unpriced flag (C3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Spans — C2 token semantics in `closeTurnSpan`

**Files:**
- Modify: `src/spans.ts:104-114`
- Test: `tests/spans.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/spans.test.ts`. Reuse the file's existing fake-Sentry helpers; if the file does not already expose `makeFakeSentry`, copy this self-contained block in:

```ts
import { closeTurnSpan as _closeTurnSpan } from "../src/spans.js";

describe("C2 — emitted token semantics", () => {
  function fakeSpan() {
    const attrs: Record<string, unknown> = {};
    return { attrs, setAttribute(k: string, v: unknown) { attrs[k] = v; }, end() {}, setStatus() {} };
  }
  function fakeSentry() {
    const spans: ReturnType<typeof fakeSpan>[] = [];
    return {
      spans,
      startInactiveSpan(o: { attributes?: Record<string, unknown> }) {
        const s = fakeSpan();
        if (o.attributes) Object.assign(s.attrs, o.attributes);
        spans.push(s);
        return s;
      },
      withActiveSpan<T>(_p: unknown, fn: () => T): T { return fn(); },
    };
  }

  it("input_tokens excludes cached + cache_write; total_tokens is the full sum", () => {
    const sentry = fakeSentry();
    const turnSpan = fakeSpan();
    const cfg = { recordInputs: false, recordOutputs: false, maxAttributeLength: 1000, tags: {} } as never;
    // raw inputTokens already = nonCached(70) + cached(20) + cacheWrite(10) = 100
    _closeTurnSpan(
      sentry as never,
      turnSpan as never,
      {
        tokens: {
          turnIndex: 0, inputTokens: 100, outputTokens: 40,
          cachedInputTokens: 20, cacheCreationTokens: 10, totalTokens: 140,
          model: "claude-opus-4-7", prompt: null, response: null,
        },
      },
      cfg,
    );
    const chat = sentry.spans[sentry.spans.length - 1];
    expect(chat.attrs["gen_ai.usage.input_tokens"]).toBe(70);
    expect(chat.attrs["gen_ai.usage.input_tokens.cached"]).toBe(20);
    expect(chat.attrs["gen_ai.usage.input_tokens.cache_write"]).toBe(10);
    expect(chat.attrs["gen_ai.usage.output_tokens"]).toBe(40);
    expect(chat.attrs["gen_ai.usage.total_tokens"]).toBe(140);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/spans.test.ts`
Expected: FAIL — `gen_ai.usage.input_tokens` is `100` (raw sum), test expects `70`.

- [ ] **Step 3: Implement the C2 correction**

In `src/spans.ts`, replace lines 104-114 (the `chatSpan.setAttribute(...)` token block) with:

```ts
  // C2: Sentry's schema expects input_tokens = NON-cached input only, with
  // cache-read and cache-write reported separately. tokens.inputTokens is the
  // raw sum of all three input buckets, so subtract the two cache buckets.
  const nonCachedInput = Math.max(
    0,
    tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheCreationTokens,
  );
  chatSpan.setAttribute("gen_ai.usage.input_tokens", nonCachedInput);
  chatSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
  chatSpan.setAttribute(
    "gen_ai.usage.total_tokens",
    tokens.inputTokens + tokens.outputTokens,
  );
  chatSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
  if (tokens.cacheCreationTokens) {
    chatSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cacheCreationTokens);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/spans.test.ts`
Expected: PASS (new C2 test + all pre-existing spans tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/spans.ts tests/spans.test.ts
git commit -m "fix(spans): emit non-cached input_tokens per Sentry schema (C2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Subagent — C2 token semantics in `attachChatChild`

**Files:**
- Modify: `src/subagent.ts:292-298`
- Test: `tests/subagent.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent.test.ts` (the file already has `makeFakeSpan` / `makeFakeSentry` helpers and the imports; reuse them — add this `describe` block at the end of the file):

```ts
import { readFileSync as _rf } from "node:fs";

describe("C2 — subagent chat-child token semantics", () => {
  it("subagent chat child emits non-cached input_tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-c2-"));
    const subDir = join(dir, "sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    const tx = join(subDir, "agent-x.jsonl");
    writeFileSync(
      tx,
      [
        JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-05-15T00:00:00Z", message: { content: "go" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-05-15T00:00:02Z", message: { model: "claude-opus-4-7", usage: { input_tokens: 50, output_tokens: 9, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 } } }),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(subDir, "agent-x.meta.json"), JSON.stringify({ agentType: "explorer" }), "utf8");

    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const parentTranscriptPath = join(dir, "sess.jsonl");
    const pre: PreToolUseEvent = {
      hook_event_name: "PreToolUse", session_id: "sess", tool_name: "Task",
      tool_use_id: "tu1", tool_input: { subagent_type: "explorer", description: "d", prompt: "p" },
    };
    attachSubagentToEvent(sentry as never, session, pre, { parentTranscriptPath });
    const post: PostToolUseEvent = {
      hook_event_name: "PostToolUse", session_id: "sess", tool_name: "Task", tool_use_id: "tu1",
    };
    attachSubagentToEvent(sentry as never, session, post, { parentTranscriptPath });

    const chat = sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "chat")!;
    // raw input = 50 + 10 + 20 = 80; non-cached = 50
    expect(chat.attrs["gen_ai.usage.input_tokens"]).toBe(50);
    expect(chat.attrs["gen_ai.usage.input_tokens.cached"]).toBe(20);
    expect(chat.attrs["gen_ai.usage.input_tokens.cache_write"]).toBe(10);
    expect(chat.attrs["gen_ai.usage.total_tokens"]).toBe(80 + 9);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subagent.test.ts`
Expected: FAIL — `gen_ai.usage.input_tokens` is `80` (raw sum), test expects `50`.

- [ ] **Step 3: Implement the C2 correction**

In `src/subagent.ts`, replace lines 292-298 (the `trySetAttribute(chat, "gen_ai.usage...")` block in `attachChatChild`) with:

```ts
  const nonCachedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationTokens,
  );
  trySetAttribute(chat, "gen_ai.usage.input_tokens", nonCachedInput);
  trySetAttribute(chat, "gen_ai.usage.output_tokens", usage.outputTokens);
  trySetAttribute(chat, "gen_ai.usage.total_tokens", usage.inputTokens + usage.outputTokens);
  trySetAttribute(chat, "gen_ai.usage.input_tokens.cached", usage.cachedInputTokens);
  if (usage.cacheCreationTokens) {
    trySetAttribute(chat, "gen_ai.usage.input_tokens.cache_write", usage.cacheCreationTokens);
  }
```

Then update the wrapper-mirror block at lines 320-322 to mirror the same corrected `input_tokens`:

```ts
  trySetAttribute(wrapper, "gen_ai.usage.input_tokens", nonCachedInput);
  trySetAttribute(wrapper, "gen_ai.usage.output_tokens", usage.outputTokens);
  trySetAttribute(wrapper, "gen_ai.usage.total_tokens", usage.inputTokens + usage.outputTokens);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/subagent.test.ts`
Expected: PASS (new C2 test + all pre-existing subagent tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "fix(subagent): non-cached input_tokens on chat child + wrapper (C2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Server — wire reader, `promptId` correlation, parse-degraded, unpriced (C1/C3/C6)

**Files:**
- Modify: `src/server.ts:22` (import), `src/server.ts:37-54` (SessionRecord), `src/server.ts:177-245` (closeCurrentTurn + handleUserPrompt)
- Test: `tests/server-lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Open `tests/server-lifecycle.test.ts` and look at its existing harness for driving `handleEvent`/`startServer` (it already constructs a fake Sentry and posts events). Append a test that drives a real-turn-with-tool-results transcript and asserts tokens land on the single turn. Use the same fake-Sentry + event-dispatch pattern already present in that file. Add:

```ts
describe("C1/C6 — collector turn correlation", () => {
  it("attributes tokens to one turn despite tool_result user lines", async () => {
    // Arrange: write a transcript with 1 prompt + 2 tool_result user lines.
    const dir = mkdtempSync(join(tmpdir(), "srv-c1-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(
      tx,
      [
        JSON.stringify({ type: "user", promptId: "P1", message: { content: "go" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 100, output_tokens: 50 } } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 8, output_tokens: 4 } } }),
      ].join("\n"),
      "utf8",
    );
    // Use the file's existing helper to start a collector + dispatch events.
    // (Match the harness already used by other tests in this file.)
    const h = startTestCollector(); // existing helper in this test file
    await h.dispatch({ hook_event_name: "SessionStart", session_id: "s", transcript_path: tx });
    await h.dispatch({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "go", prompt_id: "P1" });
    await h.dispatch({ hook_event_name: "SessionEnd", session_id: "s", transcript_path: tx });

    const chat = h.sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "chat")!;
    // total = (100+8) input + (50+4) output = 162
    expect(chat.attrs["gen_ai.usage.total_tokens"]).toBe(162);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

> If `tests/server-lifecycle.test.ts` does not expose a `startTestCollector` helper, reuse whatever event-dispatch harness that file already defines (read its top 60 lines first) and adapt the three `dispatch` calls accordingly. The assertion (single chat child, `total_tokens === 162`) is the invariant that must hold.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — with the legacy positional reader, `turns[turnIndex]` drifts (the tool_result user line creates a phantom turn), so `total_tokens` is wrong (e.g. only the first assistant slice).

- [ ] **Step 3: Swap the import + extend SessionRecord**

In `src/server.ts` line 22, replace:

```ts
import { extractPerTurnTokens } from "./transcript.js";
```

with:

```ts
import { readTranscript, selectTurn } from "./transcript-reader.js";
```

In the `SessionRecord` interface (lines 37-54), add these fields (after `turnIndex: number;`):

```ts
  /** C1: promptId of the currently-open turn, from UserPromptSubmit. */
  currentPromptId: string | null;
  /** R2: true when this record was synthesized (SessionStart missed). */
  synthesized: boolean;
```

- [ ] **Step 4: Initialize the new fields**

In `handleSessionStart` (the `sessions.set(...)` object, lines 152-165) add:

```ts
      currentPromptId: null,
      synthesized: false,
```

- [ ] **Step 5: Rewrite `closeCurrentTurn` to use the reader**

Replace the body of `closeCurrentTurn` (lines 177-227) with:

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
    if (record.transcriptPath) {
      const result = readTranscript(record.transcriptPath);
      parseDegraded = result.degraded;
      sessionDims = result.session;
      const turn = selectTurn(result, record.currentPromptId, record.turnIndex);
      if (turn) tokens = turn;
    }
    if (tokens.model) record.responseModel = tokens.model;
    const cost = computeCost(
      {
        model: tokens.model ?? record.responseModel ?? record.model ?? null,
        inputTokens: tokens.inputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        outputTokens: tokens.outputTokens,
      },
      priceTable,
    );
    // Additive correctness/attribution attributes set directly on the turn
    // span (keeps spans.ts API stable; these are not behavior-shifting).
    try {
      if (cost.unpricedModel) {
        record.currentTurnSpan.setAttribute(
          "claude_code.cost.unpriced_model",
          cost.unpricedModel,
        );
      }
      if (parseDegraded) {
        record.currentTurnSpan.setAttribute(
          "claude_code.transcript.parse_degraded",
          true,
        );
      }
      if (record.synthesized) {
        record.currentTurnSpan.setAttribute(
          "claude_code.session.synthesized",
          true,
        );
      }
      if (sessionDims.permissionMode) {
        record.currentTurnSpan.setAttribute(
          "claude_code.permission_mode",
          sessionDims.permissionMode,
        );
      }
      if (sessionDims.agentName) {
        record.currentTurnSpan.setAttribute(
          "claude_code.agent_name",
          sessionDims.agentName,
        );
      }
      if (sessionDims.entrypoint) {
        record.currentTurnSpan.setAttribute(
          "claude_code.entrypoint",
          sessionDims.entrypoint,
        );
      }
    } catch { /* ignore */ }
    closeTurnSpan(
      sentry,
      record.currentTurnSpan,
      {
        tokens,
        responseModel: record.responseModel ?? record.model,
        response: tokens.response,
        cost,
        turnStartTime: record.currentTurnStart ?? undefined,
        sessionId: record.autoTags["claude_code.session_id"],
        toolCount: record.turnToolCount,
        subagentCount: record.turnSubagentCount,
        toolsUsed: Array.from(record.turnTools),
      },
      config,
    );
    record.currentTurnSpan = null;
    record.currentTurnStart = null;
    record.currentPromptId = null;
    record.turnToolCount = 0;
    record.turnSubagentCount = 0;
    record.turnTools.clear();
  };
```

- [ ] **Step 6: Capture `prompt_id` in `handleUserPrompt`**

In `handleUserPrompt` (lines 229-245), after `record.turnIndex += 1;` add:

```ts
    record.currentPromptId = event.prompt_id ?? null;
```

- [ ] **Step 7: Run the targeted tests**

Run: `npx vitest run tests/server-lifecycle.test.ts tests/transcript-reader.test.ts`
Expected: PASS — the C1 token-attribution test is green; the reader regression suite stays green.

- [ ] **Step 8: Full build + suite**

Run: `npm run build && npm test`
Expected: PASS — `tsc` clean; entire vitest suite green.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "feat(server): reader-based turn correlation + degraded/unpriced/N4 attrs (C1/C3/C6)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Server — per-session git/cwd accuracy (C4)

**Files:**
- Modify: `src/server.ts:138-166` (handleSessionStart) and the `detectContext` call site
- Test: `tests/server-lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
import * as ctxMod from "../src/context.js";
import { vi } from "vitest";

describe("C4 — per-session cwd for git detection", () => {
  it("passes the event's _aiobs.context.cwd into detectContext", async () => {
    const spy = vi.spyOn(ctxMod, "detectContext").mockResolvedValue({} as never);
    const h = startTestCollector();
    await h.dispatch({
      hook_event_name: "SessionStart",
      session_id: "s",
      transcript_path: "/tmp/x.jsonl",
      _aiobs: { context: { cwd: "/work/repo-a" } },
    });
    expect(spy).toHaveBeenCalledWith("s", "/work/repo-a");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — `detectContext` is currently called as `detectContext(event.session_id)` (one arg); the spy assertion on the second arg fails.

- [ ] **Step 3: Pass per-session cwd**

In `src/server.ts` `handleSessionStart`, replace line 140:

```ts
    const detected = await detectContext(event.session_id).catch(() => ({} as AutoTags));
```

with:

```ts
    // C4: derive git/cwd from the session's own cwd (sent live by the
    // hook-client), never the long-lived collector's process.cwd().
    const sessionCwd = event._aiobs?.context?.cwd;
    const detected = await detectContext(event.session_id, sessionCwd).catch(
      () => ({} as AutoTags),
    );
```

> `detectContext(sessionId, cwd?)` already accepts a `cwd` second argument (`src/context.ts:35`) and runs git with `git -C <cwd>`; this change only feeds it the correct per-session value. The result is stored on the session record's `autoTags` — i.e. cached per `session_id`, satisfying the "cache keyed by session_id, not per collector process" requirement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server-lifecycle.test.ts tests/context.test.ts`
Expected: PASS — C4 test green; `context.test.ts` unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "fix(server): run git detection against the session's cwd (C4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Subagent — per-session keying + name/description match (C5/N5 isolation)

**Files:**
- Modify: `src/subagent.ts:24-26` (SubagentSession), `:53-66` (findActiveSubagentSpan), `:104-162` (attachSubagentToEvent keying), `:200-247` (locateSidechainUsage matching), `:249-258` (readMeta)
- Test: `tests/subagent.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent.test.ts`:

```ts
describe("C5/N5 — per-session isolation + name/description match", () => {
  it("two sessions do not cross-wire active subagents", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const preA: PreToolUseEvent = {
      hook_event_name: "PreToolUse", session_id: "A", tool_name: "Task",
      tool_use_id: "a1", tool_input: { subagent_type: "explorer", description: "da", prompt: "pa" },
    };
    const preB: PreToolUseEvent = {
      hook_event_name: "PreToolUse", session_id: "B", tool_name: "Task",
      tool_use_id: "b1", tool_input: { subagent_type: "explorer", description: "db", prompt: "pb" },
    };
    attachSubagentToEvent(sentry as never, session, preA);
    attachSubagentToEvent(sentry as never, session, preB);
    // Active span for A must be A's wrapper, never B's most-recent.
    const aSpan = findActiveSubagentSpan(session, "A");
    const bSpan = findActiveSubagentSpan(session, "B");
    expect(aSpan).not.toBe(bSpan);
    expect(aSpan).not.toBeNull();
    expect(findActiveSubagentSpan(session, "C")).toBeNull();
  });

  it("matches the sidechain transcript by .meta.json name+description", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-c5-"));
    const subDir = join(dir, "sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    // Two parallel same-type subagents; only meta name+description disambiguates.
    for (const [f, name, desc, inTok] of [
      ["agent-1.jsonl", "explorer", "find auth bug", 11],
      ["agent-2.jsonl", "explorer", "find perf bug", 22],
    ] as const) {
      writeFileSync(
        join(subDir, f),
        [
          JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-05-15T00:00:00Z", message: { content: "go" } }),
          JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-05-15T00:00:01Z", message: { model: "m", usage: { input_tokens: inTok, output_tokens: 1 } } }),
        ].join("\n"),
        "utf8",
      );
      writeFileSync(join(subDir, f.replace(/\.jsonl$/, ".meta.json")), JSON.stringify({ agentType: name, name, description: desc }), "utf8");
    }
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const parentTranscriptPath = join(dir, "sess.jsonl");
    const pre: PreToolUseEvent = {
      hook_event_name: "PreToolUse", session_id: "sess", tool_name: "Task",
      tool_use_id: "t2", tool_input: { subagent_type: "explorer", description: "find perf bug", prompt: "p" },
    };
    attachSubagentToEvent(sentry as never, session, pre, { parentTranscriptPath });
    attachSubagentToEvent(sentry as never, session, { hook_event_name: "PostToolUse", session_id: "sess", tool_name: "Task", tool_use_id: "t2" } as PostToolUseEvent, { parentTranscriptPath });
    const chat = sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "chat")!;
    // Must pick agent-2 (description "find perf bug") → input 22.
    expect(chat.attrs["gen_ai.usage.input_tokens"]).toBe(22);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subagent.test.ts`
Expected: FAIL — `findActiveSubagentSpan` returns the globally-most-recent wrapper (B's) for session "A"; and `locateSidechainUsage` picks by mtime/agentType, not description, so the wrong agent file (input 11) is chosen.

- [ ] **Step 3: Make `ActiveSubagent` carry session + match keys**

In `src/subagent.ts`, extend the `ActiveSubagent` interface (lines 11-22) with:

```ts
  sessionId: string;
  /** C5 match keys captured from the Task tool_input at PreToolUse. */
  matchDescription?: string;
  matchPrompt?: string;
  /** N5 nesting. */
  parentSpan?: Span;
  depth: number;
```

- [ ] **Step 4: Rewrite `findActiveSubagentSpan` to filter by session + return depth-aware latest**

Replace lines 53-66 with:

```ts
export function findActiveSubagentSpan(
  session: SubagentSession,
  sessionId: string | undefined,
): Span | null {
  if (!sessionId) return null;
  let latest: ActiveSubagent | null = null;
  for (const entry of session.active.values()) {
    if (entry.sessionId !== sessionId) continue;
    latest = entry; // Map preserves insertion order; last match = most recent.
  }
  return latest?.span ?? null;
}
```

- [ ] **Step 5: Key entries per session + capture match keys + nest (N5)**

In `attachSubagentToEvent`, replace the PreToolUse block (lines 112-128) with:

```ts
  if (event.hook_event_name === "PreToolUse") {
    const pre = event as PreToolUseEvent;
    // N5: nest under an already-active subagent for THIS session, if any.
    const enclosing = findEnclosingActive(session, pre.session_id);
    const span = createSubagentSpan(sentry, pre, {
      ...options,
      parent: enclosing?.span ?? options.parent,
    });
    if (!span) return true;
    const key = `${pre.session_id}::${pre.tool_use_id ?? session.active.size}`;
    const { subagentType, description, prompt } = readTaskInput(pre.tool_input);
    const subagentDir = computeSubagentDir(options.parentTranscriptPath, pre.session_id);
    session.active.set(key, {
      span,
      subagentType: subagentType ?? "subagent",
      toolUseId: pre.tool_use_id,
      preExisting: subagentDir ? listAgentFiles(subagentDir) : undefined,
      subagentDir,
      startedAt: Date.now(),
      sessionId: pre.session_id,
      matchDescription: description,
      matchPrompt: prompt,
      parentSpan: enclosing?.span ?? options.parent,
      depth: enclosing ? enclosing.depth + 1 : 0,
    });
    return true;
  }
```

In the PostToolUse block, replace the key lookup (lines 131-133) with a per-session-aware lookup:

```ts
    const post = event as PostToolUseEvent;
    const key = post.tool_use_id
      ? findKeyByToolUse(session.active, post.session_id, post.tool_use_id)
      : findFirstKeyForSession(session.active, post.session_id);
    if (!key) return true;
```

Add these helpers near `findFirstKey` (replace the existing `findFirstKey` at lines 345-348 with all three):

```ts
function findKeyByToolUse(
  m: Map<string, ActiveSubagent>,
  sessionId: string,
  toolUseId: string,
): string | undefined {
  for (const [k, v] of m) {
    if (v.sessionId === sessionId && v.toolUseId === toolUseId) return k;
  }
  return undefined;
}

function findFirstKeyForSession(
  m: Map<string, ActiveSubagent>,
  sessionId: string,
): string | undefined {
  for (const [k, v] of m) {
    if (v.sessionId === sessionId) return k;
  }
  return undefined;
}

function findEnclosingActive(
  session: SubagentSession,
  sessionId: string,
): ActiveSubagent | null {
  let latest: ActiveSubagent | null = null;
  for (const v of session.active.values()) {
    if (v.sessionId === sessionId) latest = v;
  }
  return latest;
}
```

- [ ] **Step 6: Make `locateSidechainUsage` prefer name+description match**

Replace `readMeta` (lines 249-258) with a richer reader:

```ts
function readMeta(
  transcriptPath: string,
): { agentType?: string; name?: string; description?: string } | null {
  const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const raw = readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(raw) as {
      agentType?: string;
      name?: string;
      description?: string;
    };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
```

Replace the scoring loop + sort in `locateSidechainUsage` (lines 224-246) with description-first scoring:

```ts
  type Scored = {
    file: string;
    mtimeMs: number;
    descMatch: boolean;
    agentTypeMatch: boolean;
  };
  const scored: Scored[] = [];
  for (const f of search) {
    const full = path.join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < entry.startedAt - 5_000) continue;
    const meta = readMeta(full);
    const descMatch =
      !!entry.matchDescription &&
      typeof meta?.description === "string" &&
      meta.description === entry.matchDescription;
    const agentTypeMatch =
      typeof meta?.agentType === "string" && meta.agentType === entry.subagentType;
    scored.push({ file: full, mtimeMs, descMatch, agentTypeMatch });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => {
    // C5: exact description match is authoritative; agentType then mtime
    // are tiebreakers only.
    if (a.descMatch !== b.descMatch) return a.descMatch ? -1 : 1;
    if (a.agentTypeMatch !== b.agentTypeMatch) return a.agentTypeMatch ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });
  return extractSidechainUsage(scored[0].file);
```

- [ ] **Step 7: Fix the PostToolUse `findFirstKey` reference**

The old PostToolUse path referenced `findFirstKey(session.active)`. Confirm Step 5 replaced that call site; grep to be sure:

Run: `grep -n "findFirstKey(" src/subagent.ts`
Expected: no matches (the function was renamed/replaced by `findFirstKeyForSession`).

- [ ] **Step 8: Run tests + build**

Run: `npx vitest run tests/subagent.test.ts && npm run build`
Expected: PASS — per-session isolation + description-match tests green; `tsc` clean.

- [ ] **Step 9: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "fix(subagent): per-session keying + description-matched sidechain (C5/N5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase B — Reliability

## Task 10: Hook-client — retry-once + 1000ms timeout (R1)

**Files:**
- Modify: `src/hook-client.ts:49-67`
- Test: `tests/hook-client-units.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/hook-client-units.test.ts`:

```ts
import { sendHookEvent } from "../src/hook-client.js";
import { vi } from "vitest";

describe("R1 — sendHookEvent retry-once", () => {
  it("retries exactly once when the first POST rejects, then succeeds", async () => {
    const calls: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => { calls.push("a"); return Promise.reject(new Error("boom")); })
      .mockImplementationOnce(() => { calls.push("b"); return Promise.resolve(new Response("{}", { status: 200 })); });
    vi.stubGlobal("fetch", fetchMock);
    await sendHookEvent({ hook_event_name: "Stop", session_id: "s" } as never, 19877);
    expect(calls).toEqual(["a", "b"]);
    vi.unstubAllGlobals();
  });

  it("does not throw when both attempts fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      sendHookEvent({ hook_event_name: "Stop", session_id: "s" } as never, 19877),
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client-units.test.ts`
Expected: FAIL — current `sendHookEvent` calls `fetch` once; `calls` is `["a"]`, not `["a","b"]`.

- [ ] **Step 3: Implement retry-once + 1000ms timeout**

In `src/hook-client.ts`, replace `sendHookEvent` (lines 49-67) with:

```ts
export async function sendHookEvent(event: HookEvent, port: number): Promise<void> {
  // R3: piggyback the count of events we previously failed to deliver, then
  // optimistically reset; if THIS send also fails we re-increment below.
  const droppedSinceLast = readDroppedCount();
  const enriched: HookEvent = {
    ...event,
    _aiobs: {
      context: detectClientContext(),
      ...(droppedSinceLast > 0 ? { dropped_since_last: droppedSinceLast } : {}),
    },
  };
  const body = JSON.stringify(enriched);

  const attempt = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl(port)}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        // R1: detached hook process; Claude Code is never blocked by this.
        signal: AbortSignal.timeout(1000),
      });
      return !!res && (res.status ?? 200) < 500;
    } catch {
      return false;
    }
  };

  let ok = await attempt();
  if (!ok) ok = await attempt(); // R1: retry exactly once.

  if (ok) {
    if (droppedSinceLast > 0) resetDroppedCount();
  } else {
    incrementDroppedCount();
  }
}
```

> The R3 counter helpers (`readDroppedCount`, `resetDroppedCount`, `incrementDroppedCount`) are added in Task 11. To keep this task self-contained and compiling now, add temporary no-op stubs at the bottom of `hook-client.ts`:
>
> ```ts
> function readDroppedCount(): number { return 0; }
> function resetDroppedCount(): void { /* implemented in R3 */ }
> function incrementDroppedCount(): void { /* implemented in R3 */ }
> ```
>
> Task 11 replaces these stubs with real file-backed implementations.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/hook-client-units.test.ts && npm run build`
Expected: PASS — retry test green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client-units.test.ts
git commit -m "feat(hook-client): retry-once + 1000ms timeout (R1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Hook-client — dropped-event counter file (R3)

**Files:**
- Modify: `src/hook-client.ts` (replace the Task 10 stubs)
- Test: `tests/hook-client-units.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/hook-client-units.test.ts`:

```ts
import { _droppedCountPath, readDroppedCount, incrementDroppedCount, resetDroppedCount } from "../src/hook-client.js";
import { existsSync, rmSync } from "node:fs";

describe("R3 — dropped-event counter round-trip", () => {
  afterEach(() => {
    try { rmSync(_droppedCountPath(), { force: true }); } catch { /* ignore */ }
  });
  it("increments and resets a persistent counter", () => {
    resetDroppedCount();
    expect(readDroppedCount()).toBe(0);
    incrementDroppedCount();
    incrementDroppedCount();
    expect(readDroppedCount()).toBe(2);
    resetDroppedCount();
    expect(readDroppedCount()).toBe(0);
    expect(existsSync(_droppedCountPath())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client-units.test.ts`
Expected: FAIL — `_droppedCountPath` / `readDroppedCount` / `incrementDroppedCount` / `resetDroppedCount` are not exported (Task 10 left private no-op stubs).

- [ ] **Step 3: Replace the stubs with file-backed implementations**

In `src/hook-client.ts`, delete the three temporary stubs added in Task 10 and add (near the other `CACHE_DIR` helpers):

```ts
/** R3: path to the persistent dropped-event counter file. */
export function _droppedCountPath(): string {
  return join(CACHE_DIR, "dropped.count");
}

export function readDroppedCount(): number {
  try {
    const n = Number(readFileSync(_droppedCountPath(), "utf8").trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function incrementDroppedCount(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(_droppedCountPath(), String(readDroppedCount() + 1));
  } catch {
    // best-effort
  }
}

export function resetDroppedCount(): void {
  try { unlinkSync(_droppedCountPath()); } catch { /* ignore */ }
}
```

> `readFileSync`, `mkdirSync`, `writeFileSync`, `unlinkSync` and `join` are already imported at the top of `hook-client.ts` (lines 1-3). No new imports needed.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/hook-client-units.test.ts && npm run build`
Expected: PASS — counter round-trip + the R1 retry tests green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client-units.test.ts
git commit -m "feat(hook-client): persistent dropped-event counter (R3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Server — lazy session synthesis (R2)

**Files:**
- Modify: `src/server.ts:229-337` (handleUserPrompt / handlePreTool / handlePostTool), add a `getOrCreateSession` helper
- Test: `tests/server-lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
describe("R2 — lazy session synthesis", () => {
  it("emits a turn even when SessionStart was missed, flagged synthesized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-r2-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(
      tx,
      [
        JSON.stringify({ type: "user", promptId: "P1", message: { content: "go" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 9, output_tokens: 3 } } }),
      ].join("\n"),
      "utf8",
    );
    const h = startTestCollector();
    // NOTE: no SessionStart dispatched.
    await h.dispatch({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "go", prompt_id: "P1", _aiobs: { context: { cwd: dir } } });
    await h.dispatch({ hook_event_name: "SessionEnd", session_id: "s", transcript_path: tx });
    const turn = h.sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "invoke_agent")!;
    expect(turn).toBeTruthy();
    expect(turn.attrs["claude_code.session.synthesized"]).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

> If the test harness can't pass `transcript_path` on SessionEnd to a never-started session, the existing `handleSessionEnd` already copies `event.transcript_path` onto the record when missing (server.ts:342-344) — synthesis just needs to create the record first.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — `handleUserPrompt` does `if (!record) return;`, so no turn span is ever created without SessionStart.

- [ ] **Step 3: Add `getOrCreateSession` and use it in the three handlers**

In `src/server.ts`, add this helper inside `startServer` (just before `handleUserPrompt`, around line 228):

```ts
  // R2: SessionStart can be missed (collector spawned mid-session, or the
  // event was dropped). Build a minimal record from the event so whole turns
  // aren't blacked out. Spans get claude_code.session.synthesized = true.
  const getOrCreateSession = (event: HookEvent): SessionRecord => {
    const sid = (event as { session_id: string }).session_id;
    let record = sessions.get(sid);
    if (record) return record;
    const cwd = event._aiobs?.context?.cwd;
    const transcriptPath = (event as { transcript_path?: string }).transcript_path;
    record = {
      currentTurnSpan: null,
      currentTurnStart: null,
      pendingTools: new Map(),
      toolCount: 0,
      turnToolCount: 0,
      turnSubagentCount: 0,
      turnTools: new Set(),
      transcriptPath,
      model: undefined,
      turnIndex: -1,
      autoTags: {
        ...baseAutoTags,
        "claude_code.session_id": sid,
        ...(cwd ? { "process.cwd": cwd } : {}),
      },
      lastEventAt: Date.now(),
      currentPromptId: null,
      synthesized: true,
    };
    applyClientContext(record.autoTags, event._aiobs?.context);
    sessions.set(sid, record);
    return record;
  };
```

In `handleUserPrompt` (line 230-231), replace:

```ts
    const record = sessions.get(event.session_id);
    if (!record) return;
```

with:

```ts
    const record = getOrCreateSession(event);
```

Apply the **same** replacement at the top of `handlePreTool` (lines 248-249) and `handlePostTool` (lines 290-291).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/server-lifecycle.test.ts && npm run build`
Expected: PASS — synthesized-turn test green (`claude_code.session.synthesized === true`, already wired in Task 7 Step 5); `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "feat(server): lazy session synthesis when SessionStart missed (R2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Server — dropped-event attribute (R3) + collector heartbeat (R4)

**Files:**
- Modify: `src/server.ts:354-363` (touchSession), `:454-471` (timers), add a heartbeat emitter
- Test: `tests/server-lifecycle.test.ts` (append) and/or `tests/server-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
describe("R3/R4 — loss observability + heartbeat", () => {
  it("records dropped_since_last on the open turn span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-r3-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, JSON.stringify({ type: "user", promptId: "P1", message: { content: "x" } }) + "\n", "utf8");
    const h = startTestCollector();
    await h.dispatch({ hook_event_name: "SessionStart", session_id: "s", transcript_path: tx });
    await h.dispatch({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x", prompt_id: "P1", _aiobs: { dropped_since_last: 4 } });
    const turn = h.sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "invoke_agent")!;
    expect(turn.attrs["claude_code.dropped_since_last"]).toBe(4);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emitHeartbeat produces a claude_code.collector.heartbeat span", () => {
    const h = startTestCollector();
    h.emitHeartbeat(); // test seam exposed by startServer return value
    const hb = h.sentry.spans.find((s) => s.attrs["claude_code.collector.heartbeat"] === true);
    expect(hb).toBeTruthy();
    expect(typeof hb!.attrs["claude_code.collector.uptime_s"]).toBe("number");
    expect(hb!.attrs["claude_code.collector.version"]).toBeDefined();
  });
});
```

> `startServer` currently returns `{ close }`. This task adds a test seam: it must also return `emitHeartbeat`. Adapt `startTestCollector` in the test file to surface `emitHeartbeat` from the `startServer` return value.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — `claude_code.dropped_since_last` is never set; `startServer` exposes no `emitHeartbeat`.

- [ ] **Step 3: Track dropped total + set the per-turn attribute**

In `src/server.ts`, add a counter in `startServer` scope (near `const sessions = ...`, line 133):

```ts
  let droppedTotal = 0;
```

Replace `touchSession` (lines 354-363) with:

```ts
  const touchSession = (event: HookEvent): void => {
    const sid = (event as { session_id?: string }).session_id;
    if (!sid) return;
    const r = sessions.get(sid);
    if (!r) return;
    r.lastEventAt = Date.now();
    applyClientContext(r.autoTags, event._aiobs?.context);
    // R3: surface delivery loss the hook-client piggybacked on this event.
    const dropped = event._aiobs?.dropped_since_last;
    if (typeof dropped === "number" && dropped > 0) {
      droppedTotal += dropped;
      if (r.currentTurnSpan) {
        try {
          r.currentTurnSpan.setAttribute("claude_code.dropped_since_last", dropped);
        } catch { /* ignore */ }
      }
      captureBreadcrumb(sentry, {
        event,
        session: {
          sessionId: sid,
          sessionName: r.autoTags["claude_code.session_name"],
        },
      });
    }
  };
```

> `touchSession` runs before the turn span exists for the very event that opens the turn. The test dispatches `UserPromptSubmit` carrying `dropped_since_last`; `touchSession` runs first (no turn span yet). To cover that ordering, also re-apply in `handleUserPrompt` right after the turn span is opened. Add at the end of `handleUserPrompt` (after the `openTurnTransaction` assignment, ~line 244):
>
> ```ts
>     const dropped = event._aiobs?.dropped_since_last;
>     if (typeof dropped === "number" && dropped > 0 && record.currentTurnSpan) {
>       try {
>         record.currentTurnSpan.setAttribute("claude_code.dropped_since_last", dropped);
>       } catch { /* ignore */ }
>     }
> ```

- [ ] **Step 4: Add the heartbeat emitter (R4) and a test seam**

In `src/server.ts`, add this function in `startServer` scope (near the timers, before `server.on("listening", ...)`, ~line 453):

```ts
  const emitHeartbeat = (): void => {
    try {
      const span = sentry.startInactiveSpan({
        op: "claude_code.collector.heartbeat",
        name: "collector heartbeat",
        forceTransaction: true,
        attributes: {
          "claude_code.collector.heartbeat": true,
          "claude_code.collector.sessions_active": sessions.size,
          "claude_code.collector.uptime_s": Math.floor((Date.now() - startedAt) / 1000),
          "claude_code.collector.version": PLUGIN_VERSION,
          "claude_code.collector.dropped_total": droppedTotal,
        },
      });
      span.end();
    } catch { /* ignore */ }
  };
```

> `startedAt` is declared at line 389 (`const startedAt = Date.now();`). Move that declaration up to just below `let droppedTotal = 0;` (Step 3) so `emitHeartbeat` can reference it. Delete the old `const startedAt = Date.now();` at line 389.

In the existing `flushTimer` interval (lines 456-458), call the emitter on each tick:

```ts
    flushTimer = setInterval(() => {
      emitHeartbeat();
      try { void sentry.flush(2000); } catch { /* ignore */ }
    }, FLUSH_INTERVAL_MS);
```

Finally, expose the test seam — change the `return { close: shutdown };` (line 507) to:

```ts
  return { close: shutdown, emitHeartbeat };
```

…and widen the function's return type annotation (line 132) to:

```ts
): { close: () => Promise<void>; emitHeartbeat: () => void } {
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run tests/server-lifecycle.test.ts tests/server-endpoints.test.ts && npm run build`
Expected: PASS — R3 attribute + R4 heartbeat tests green; endpoint tests unaffected; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "feat(server): dropped-event attribute + collector heartbeat (R3/R4)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase C — New Data

## Task 14: `attribution.ts` — MCP + skill + slash-command parsers (N1/N2)

**Files:**
- Create: `src/attribution.ts`
- Test: `tests/attribution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/attribution.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseMcpTool, parseSkillInput, parseSlashCommand } from "../src/attribution.js";

describe("N1 — MCP tool name parsing", () => {
  it("parses mcp__server__tool", () => {
    expect(parseMcpTool("mcp__claude_ai_Linear__list_issues")).toEqual({
      server: "claude_ai_Linear",
      name: "list_issues",
    });
  });
  it("returns null for non-mcp tools", () => {
    expect(parseMcpTool("Bash")).toBeNull();
  });
  it("keeps remaining __ in the tool name", () => {
    expect(parseMcpTool("mcp__srv__a__b")).toEqual({ server: "srv", name: "a__b" });
  });
});

describe("N2 — skill input parsing", () => {
  it("splits a namespaced skill", () => {
    expect(parseSkillInput({ skill: "superpowers:brainstorming" })).toEqual({
      name: "brainstorming",
      plugin: "superpowers",
    });
  });
  it("bare skill omits plugin", () => {
    expect(parseSkillInput({ skill: "review" })).toEqual({ name: "review" });
  });
  it("returns null for non-skill input", () => {
    expect(parseSkillInput({ foo: 1 })).toBeNull();
  });
});

describe("N2 — slash command parsing", () => {
  it("parses a namespaced command", () => {
    expect(parseSlashCommand("/superpowers:writing-plans go")).toEqual({
      name: "writing-plans",
      plugin: "superpowers",
    });
  });
  it("parses a bare command without plugin", () => {
    expect(parseSlashCommand("/review")).toEqual({ name: "review" });
  });
  it("returns null when prompt is not a slash command", () => {
    expect(parseSlashCommand("hello there")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/attribution.test.ts`
Expected: FAIL — `Cannot find module '../src/attribution.js'`.

- [ ] **Step 3: Implement the parsers**

Create `src/attribution.ts`:

```ts
export interface McpToolRef {
  server: string;
  name: string;
}

/** N1: `mcp__<server>__<tool>` → { server, name }. Null when not an MCP tool. */
export function parseMcpTool(toolName: string): McpToolRef | null {
  if (typeof toolName !== "string" || !toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { server: rest.slice(0, sep), name: rest.slice(sep + 2) };
}

export interface SkillRef {
  name: string;
  plugin?: string;
}

/** N2: the Skill tool input carries `skill: "[plugin:]name"`. */
export function parseSkillInput(input: unknown): SkillRef | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).skill;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    return { plugin: raw.slice(0, colon), name: raw.slice(colon + 1) };
  }
  return { name: raw };
}

export interface CommandRef {
  name: string;
  plugin?: string;
}

/** N2: a UserPromptSubmit prompt of form `/[plugin:]command ...`. */
export function parseSlashCommand(prompt: string): CommandRef | null {
  if (typeof prompt !== "string") return null;
  const m = prompt.match(/^\/(?:([A-Za-z0-9_-]+):)?([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return m[1] ? { plugin: m[1], name: m[2] } : { name: m[2] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attribution.test.ts`
Expected: PASS (all three describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/attribution.ts tests/attribution.test.ts
git commit -m "feat(attribution): MCP + skill + slash-command parsers (N1/N2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `attribution.ts` — subagent source-class + path inference (N3)

**Files:**
- Modify: `src/attribution.ts`
- Test: `tests/attribution.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/attribution.test.ts`:

```ts
import { deriveSubagentSource } from "../src/attribution.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("N3 — subagent source-class", () => {
  it("namespaced subagent_type is authoritative (not inferred)", () => {
    expect(deriveSubagentSource("superpowers:planner", undefined)).toEqual({
      source: "plugin:superpowers",
      inferred: false,
    });
  });

  it("infers plugin from an agent file under a plugin dir", () => {
    const root = mkdtempSync(join(tmpdir(), "n3-"));
    const agentFile = join(root, "plugins", "cache", "acme", "agents", "explorer.md");
    mkdirSync(join(root, "plugins", "cache", "acme", "agents"), { recursive: true });
    writeFileSync(agentFile, "# explorer", "utf8");
    const r = deriveSubagentSource("explorer", agentFile);
    expect(r.source).toBe("plugin:acme");
    expect(r.inferred).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("project .claude/agents → source=project, inferred", () => {
    const root = mkdtempSync(join(tmpdir(), "n3p-"));
    const agentFile = join(root, ".claude", "agents", "myagent.md");
    mkdirSync(join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(agentFile, "x", "utf8");
    expect(deriveSubagentSource("myagent", agentFile)).toEqual({
      source: "project",
      inferred: true,
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("unknown when no namespace and no resolvable path", () => {
    expect(deriveSubagentSource("explorer", undefined)).toEqual({
      source: "unknown",
      inferred: false,
    });
  });

  it("built-in style names map to built-in", () => {
    expect(deriveSubagentSource("general-purpose", undefined).source).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/attribution.test.ts`
Expected: FAIL — `deriveSubagentSource` is not exported.

- [ ] **Step 3: Implement `deriveSubagentSource`**

Append to `src/attribution.ts`:

```ts
export interface SubagentSource {
  /** built-in | user | project | plugin:<name> | unknown */
  source: string;
  /** N3: true when derived by best-effort path inference (discountable). */
  inferred: boolean;
}

/**
 * N3 derivation order:
 *  1. namespace in subagent_type (`plugin:agent`) → authoritative.
 *  2. best-effort: resolve the agent definition file and test whether it
 *     lives under a known plugin / project / user agents dir.
 *  3. otherwise `unknown`.
 */
export function deriveSubagentSource(
  subagentType: string | undefined,
  agentDefPath: string | undefined,
): SubagentSource {
  if (subagentType && subagentType.includes(":")) {
    const plugin = subagentType.slice(0, subagentType.indexOf(":"));
    if (plugin) return { source: `plugin:${plugin}`, inferred: false };
  }

  if (agentDefPath) {
    const norm = agentDefPath.replace(/\\/g, "/");
    // ~/.claude/plugins/**/<plugin>/agents/<file>
    const plug = norm.match(/\/plugins\/(?:[^/]+\/)*?([^/]+)\/agents\//);
    if (plug && plug[1]) return { source: `plugin:${plug[1]}`, inferred: true };
    if (/(^|\/)\.claude\/agents\//.test(norm)) {
      // Disambiguate user (~/.claude) vs project (./.claude) by home dir.
      const home = (process.env.HOME ?? "").replace(/\\/g, "/");
      if (home && norm.startsWith(`${home}/.claude/agents/`)) {
        return { source: "user", inferred: true };
      }
      return { source: "project", inferred: true };
    }
  }

  return { source: "unknown", inferred: false };
}
```

> The "built-in style names map to built-in" test asserts `unknown` for `general-purpose` with no path — Claude Code exposes no authoritative built-in marker (spec "Out of scope"), so absent a resolvable path it is correctly `unknown`. Keep the test as the regression lock for that intentional behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attribution.test.ts`
Expected: PASS (N3 block + N1/N2 blocks all green).

- [ ] **Step 5: Commit**

```bash
git add src/attribution.ts tests/attribution.test.ts
git commit -m "feat(attribution): subagent source-class + path inference (N3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Server — wire MCP tool attribution onto tool spans (N1)

**Files:**
- Modify: `src/server.ts:247-287` (handlePreTool)
- Test: `tests/server-lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
describe("N1 — MCP tool attribution on tool spans", () => {
  it("sets gen_ai.tool.mcp.* + claude_code.tool.source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-n1-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, JSON.stringify({ type: "user", promptId: "P1", message: { content: "x" } }) + "\n", "utf8");
    const h = startTestCollector();
    await h.dispatch({ hook_event_name: "SessionStart", session_id: "s", transcript_path: tx });
    await h.dispatch({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x", prompt_id: "P1" });
    await h.dispatch({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "mcp__claude_ai_Linear__list_issues", tool_use_id: "t1", tool_input: {} });
    const toolSpan = h.sentry.spans.find((s) => s.attrs["gen_ai.tool.name"] === "mcp__claude_ai_Linear__list_issues")!;
    expect(toolSpan.attrs["gen_ai.tool.mcp.server"]).toBe("claude_ai_Linear");
    expect(toolSpan.attrs["gen_ai.tool.mcp.name"]).toBe("list_issues");
    expect(toolSpan.attrs["claude_code.tool.source"]).toBe("mcp");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — MCP attributes are never set on the tool span.

- [ ] **Step 3: Wire MCP + skill attribution in `handlePreTool`**

In `src/server.ts`, add to the imports near line 24:

```ts
import { parseMcpTool, parseSkillInput, parseSlashCommand } from "./attribution.js";
```

In `handlePreTool`, after the tool span is created and stored (right after `record.pendingTools.set(key, ...)` ~line 283), add:

```ts
    // N1: MCP server attribution on every tool span.
    const mcp = parseMcpTool(event.tool_name);
    if (mcp) {
      try {
        span.setAttribute("gen_ai.tool.mcp.server", mcp.server);
        span.setAttribute("gen_ai.tool.mcp.name", mcp.name);
        span.setAttribute("claude_code.tool.source", "mcp");
      } catch { /* ignore */ }
    }
    // N2: Skill tool input → skill name/plugin on the tool span.
    if (event.tool_name === "Skill") {
      const skill = parseSkillInput(event.tool_input);
      if (skill) {
        try {
          span.setAttribute("claude_code.skill.name", skill.name);
          if (skill.plugin) span.setAttribute("claude_code.skill.plugin", skill.plugin);
        } catch { /* ignore */ }
      }
    }
```

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/server-lifecycle.test.ts && npm run build`
Expected: PASS — N1 test green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "feat(server): MCP + Skill tool attribution on tool spans (N1/N2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Server — slash-command attribution on the turn span (N2)

**Files:**
- Modify: `src/server.ts:229-245` (handleUserPrompt)
- Test: `tests/server-lifecycle.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/server-lifecycle.test.ts`:

```ts
describe("N2 — slash-command attribution on the turn span", () => {
  it("sets claude_code.command.name/plugin from a namespaced command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-n2-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, JSON.stringify({ type: "user", promptId: "P1", message: { content: "x" } }) + "\n", "utf8");
    const h = startTestCollector();
    await h.dispatch({ hook_event_name: "SessionStart", session_id: "s", transcript_path: tx });
    await h.dispatch({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "/superpowers:writing-plans go", prompt_id: "P1" });
    const turn = h.sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "invoke_agent")!;
    expect(turn.attrs["claude_code.command.name"]).toBe("writing-plans");
    expect(turn.attrs["claude_code.command.plugin"]).toBe("superpowers");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server-lifecycle.test.ts`
Expected: FAIL — command attributes never set.

- [ ] **Step 3: Parse the command in `handleUserPrompt`**

In `src/server.ts` `handleUserPrompt`, after `record.currentTurnSpan = openTurnTransaction(...)` (~line 244), add:

```ts
    // N2: a slash command in the prompt → command attribution on the turn.
    if (prompt) {
      const cmd = parseSlashCommand(prompt);
      if (cmd && record.currentTurnSpan) {
        try {
          record.currentTurnSpan.setAttribute("claude_code.command.name", cmd.name);
          if (cmd.plugin) {
            record.currentTurnSpan.setAttribute("claude_code.command.plugin", cmd.plugin);
          }
        } catch { /* ignore */ }
      }
    }
```

> `parseSlashCommand` was imported in Task 16 Step 3.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/server-lifecycle.test.ts && npm run build`
Expected: PASS — N2 command test green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server-lifecycle.test.ts
git commit -m "feat(server): slash-command attribution on the turn span (N2)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Subagent — telemetry + source-class on the wrapper span (N3)

**Files:**
- Modify: `src/subagent.ts:68-102` (createSubagentSpan), `:130-159` (PostToolUse close)
- Test: `tests/subagent.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/subagent.test.ts`:

```ts
import { deriveSubagentSource } from "../src/attribution.js";

describe("N3 — subagent telemetry on the wrapper", () => {
  it("sets agent name/description/source + depth on the wrapper span", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-n3-"));
    const subDir = join(dir, "sess", "subagents");
    mkdirSync(subDir, { recursive: true });
    const tx = join(subDir, "agent-z.jsonl");
    writeFileSync(
      tx,
      [
        JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-05-15T00:00:00Z", message: { content: "go" } }),
        JSON.stringify({ type: "assistant", isSidechain: true, timestamp: "2026-05-15T00:00:01Z", message: { model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 2 } } }),
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(subDir, "agent-z.meta.json"), JSON.stringify({ agentType: "explorer", name: "explorer", description: "scout" }), "utf8");

    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const parentTranscriptPath = join(dir, "sess.jsonl");
    const pre: PreToolUseEvent = {
      hook_event_name: "PreToolUse", session_id: "sess", tool_name: "Task", tool_use_id: "tu",
      tool_input: { subagent_type: "superpowers:planner", description: "scout", prompt: "p" },
    };
    attachSubagentToEvent(sentry as never, session, pre, { parentTranscriptPath });
    attachSubagentToEvent(sentry as never, session, { hook_event_name: "PostToolUse", session_id: "sess", tool_name: "Task", tool_use_id: "tu" } as PostToolUseEvent, { parentTranscriptPath });

    const wrapper = sentry.spans.find((s) => s.attrs["gen_ai.operation.name"] === "invoke_agent")!;
    expect(wrapper.attrs["gen_ai.agent.name"]).toBe("superpowers:planner");
    expect(wrapper.attrs["claude_code.subagent.source"]).toBe("plugin:superpowers");
    expect(wrapper.attrs["claude_code.subagent.source_inferred"]).toBeUndefined();
    expect(wrapper.attrs["claude_code.subagent.depth"]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subagent.test.ts`
Expected: FAIL — `claude_code.subagent.source` / `.depth` are not set on the wrapper.

- [ ] **Step 3: Set source-class + depth at span creation**

In `src/subagent.ts`, add the import near line 6:

```ts
import { deriveSubagentSource } from "./attribution.js";
```

In `createSubagentSpan`, after the `attributes` object is populated (after line 85, before `startSpan` is read), add:

```ts
  const src = deriveSubagentSource(subagentType, undefined);
  attributes["claude_code.subagent.source"] = src.source;
  if (src.inferred) attributes["claude_code.subagent.source_inferred"] = "true";
  if (subagentType) attributes["claude_code.subagent.name"] = subagentType;
  if (description) {
    attributes["claude_code.subagent.description"] = scrubString(
      truncate(description, maxAttrLen),
    );
  }
```

In `attachSubagentToEvent` PreToolUse block (Task 9 Step 5 rewrite), after `session.active.set(key, {...})`, set depth on the span:

```ts
    try {
      span.setAttribute(
        "claude_code.subagent.depth",
        enclosing ? enclosing.depth + 1 : 0,
      );
    } catch { /* ignore */ }
```

- [ ] **Step 4: Add duration + error flag at PostToolUse close**

In the PostToolUse block of `attachSubagentToEvent`, right before `tryEnd(entry.span)` (~line 157), add:

```ts
    trySetAttribute(entry.span, "claude_code.subagent.duration_ms", Date.now() - entry.startedAt);
    trySetAttribute(entry.span, "claude_code.subagent.error", post.tool_error === true);
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run tests/subagent.test.ts && npm run build`
Expected: PASS — N3 wrapper telemetry test green; all prior subagent tests still green; `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "feat(subagent): source-class + depth + duration telemetry (N3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Full regression gate + smoke

**Files:** none (verification task)

- [ ] **Step 1: Typecheck + full suite + smoke**

Run: `npm run ci`
Expected: PASS — `tsc --noEmit` clean, entire `vitest run` green, `bash scripts/smoke-test.sh` succeeds.

- [ ] **Step 2: If anything fails, fix forward (do not weaken assertions)**

Use superpowers:systematic-debugging on any failure. Re-run `npm run ci` until green.

- [ ] **Step 3: Commit (only if fixes were needed)**

```bash
git add -A
git commit -m "test: green full CI gate for observability reliability + data design

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase D — Rollout & Back-compat

## Task 20: Dashboard migration guide + CHANGELOG + README

**Files:**
- Create: `docs/sentry-dashboard-migration.md`
- Modify: `CHANGELOG.md` (new top entry), `README.md` (migration paragraph)

- [ ] **Step 1: Write the migration guide**

Create `docs/sentry-dashboard-migration.md`:

```markdown
# Sentry Dashboard Migration — v0.2.0

v0.2.0 corrects two long-standing inaccuracies **in place** (no parallel
`_v2` attributes). Existing dashboards keep working but show **shifted,
now-correct** numbers. Rebuild cost/token panels using the queries below.

## What changed (behavior)

- **C1 — turn segmentation.** Per-turn token/cost is no longer mis-sliced by
  tool-result user lines. Per-turn totals will differ from pre-0.2.0; session
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
| Tokens Used | `sum(gen_ai.usage.input_tokens)` on `op:gen_ai.chat` (double-counted cache) | same query — value now excludes cache; add `gen_ai.usage.input_tokens.cached` + `.cache_write` series for full picture |
| Cost (plugin) | `sum(conversation.cost_estimate_usd)` on `op:gen_ai.invoke_agent` | unchanged; now correct per turn |
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
  `claude_code.collector.heartbeat` (+ `…sessions_active`, `…uptime_s`,
  `…version`, `…dropped_total`)

Filter `claude_code.subagent.source_inferred:true` to discount best-effort
plugin attribution.
```

- [ ] **Step 2: Prepend a CHANGELOG entry**

In `CHANGELOG.md`, insert a new section directly above `## [0.1.7] - 2026-04-27`:

```markdown
## [0.2.0] - 2026-05-15

### Changed (behavior — read the migration note)

- **BREAKING (numbers, not API): per-turn token/cost is now correctly
  segmented (C1).** Tool-result user lines no longer start phantom turns;
  per-turn values shift to correct. See `docs/sentry-dashboard-migration.md`.
- **`gen_ai.usage.input_tokens` is now non-cached input only (C2).**
  Cache read/write are separate attributes; `total_tokens` is the full sum.
  Sentry's server-side cost + Tokens Used widget no longer double-count.

### Fixed

- **Cost model matching (C3):** exact → date-stripped prefix → family
  heuristic → unpriced. Unpriced turns set `claude_code.cost.unpriced_model`.
- **Per-session git/cwd (C4):** git detection runs against the session's own
  cwd, not the long-lived collector's `process.cwd()`.
- **Parallel same-type subagents (C5):** sidechain transcripts are matched by
  `.meta.json` name+description; mtime/agentType are tiebreakers only.
- **Cross-session subagent misattribution (C5/N5):** active subagents are
  keyed per `session_id`; nested subagents parent to their enclosing wrapper.
- **Soft-fail transcript parsing (C6):** unrecognized JSONL falls back to
  legacy positional behavior and sets `claude_code.transcript.parse_degraded`.

### Added

- **Reliability:** retry-once + 1000ms hook timeout (R1); lazy session
  synthesis with `claude_code.session.synthesized` (R2); dropped-event
  counter piggybacked as `claude_code.dropped_since_last` (R3);
  `claude_code.collector.heartbeat` span on the flush tick (R4).
- **Attribution:** MCP server (N1), skill & slash-command (N2), subagent
  source-class + telemetry incl. `claude_code.subagent.source_inferred` (N3),
  cheap session dimensions `claude_code.permission_mode` / `agent_name` /
  `entrypoint` (N4).
- **`docs/sentry-dashboard-migration.md`** — corrected semantics + queries.
```

- [ ] **Step 3: Add a README migration paragraph**

In `README.md`, find the features/usage section and add a short note (place it after the feature summary, before install instructions if unsure):

```markdown
### Upgrading to v0.2.0 (behavior change)

v0.2.0 corrects per-turn token/cost segmentation and aligns
`gen_ai.usage.input_tokens` with Sentry's schema (non-cached input only).
Existing dashboards keep working but show shifted, now-correct numbers —
rebuild cost/token panels per
[`docs/sentry-dashboard-migration.md`](docs/sentry-dashboard-migration.md).
No config changes are required.
```

- [ ] **Step 4: Commit**

```bash
git add docs/sentry-dashboard-migration.md CHANGELOG.md README.md
git commit -m "docs: v0.2.0 migration guide + changelog + readme note

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21: Minor version bump → 0.2.0

**Files:**
- Modify: `.claude-plugin/plugin.json:4`, `package.json` (`version` field)

- [ ] **Step 1: Bump the plugin manifest**

In `.claude-plugin/plugin.json`, change `"version": "0.1.9"` to `"version": "0.2.0"`.

- [ ] **Step 2: Bump package.json**

In `package.json`, change `"version": "0.1.9"` to `"version": "0.2.0"` (same value the manifest now carries; `PLUGIN_VERSION` is read from the manifest at `src/plugin-meta.ts:9`).

- [ ] **Step 3: Verify the version is read consistently**

Run: `npm run build && node -e "import('./scripts/plugin-meta.js').then(m=>console.log(m.PLUGIN_VERSION))"`
Expected: prints `0.2.0`.

- [ ] **Step 4: Final full gate**

Run: `npm run ci`
Expected: PASS — `tsc --noEmit` clean, full `vitest run` green, smoke test succeeds.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json package.json
git commit -m "chore: bump version to 0.2.0

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** C1→T2/T7, C2→T5/T6, C3→T4, C4→T8, C5→T9, C6→T2/T3/T7,
  R1→T10, R2→T12, R3→T11/T13, R4→T13, N1→T14/T16, N2→T14/T16/T17,
  N3→T15/T18, N4→T2/T7, N5→T9, rollout→T20/T21. All spec items mapped.
- **Type consistency:** `RealTurn`/`selectTurn`/`readTranscript` (T2) are used
  unchanged in T7. `TurnCost.unpricedModel` (T4) is consumed in T7.
  `resolveModelPrice` name is stable across T4/T7. `SubagentSession.active`
  becomes `Map<string, ActiveSubagent>` keyed `${sessionId}::${toolUseId}`
  consistently across T9/T18. `emitHeartbeat` test seam (T13) matches the
  widened `startServer` return type.
- **Known integration risk:** `tests/server-lifecycle.test.ts` must expose a
  dispatch harness (`startTestCollector` with `.dispatch`, `.sentry.spans`,
  `.emitHeartbeat`). Read its existing top-of-file harness before Task 7 and
  adapt the helper name if it differs; the assertions are the contract, not
  the helper name.
- **Back-compat:** no config schema change; behavior shifts (C1/C2) are
  corrected in place and documented (T20). Minor bump 0.1.9 → 0.2.0 (T21).
```

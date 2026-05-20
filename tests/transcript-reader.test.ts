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
    expect(selectTurn(r, "p2", 99).turn!.outputTokens).toBe(4);
    expect(selectTurn(r, undefined, 0).turn!.promptId).toBe("p1");
  });
});

describe("readTranscript — missing/empty file is not parse-degraded", () => {
  it("missing file → empty turns, degraded false (not format drift)", () => {
    const r = readTranscript("/tmp/__aiobs_no_such_transcript__.jsonl");
    expect(r.turns).toEqual([]);
    expect(r.degraded).toBe(false);
  });
  it("empty file → empty turns, degraded false", () => {
    const p = make("");
    const r = readTranscript(p);
    expect(r.turns).toEqual([]);
    expect(r.degraded).toBe(false);
  });
});

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

describe("selectTurn matchedBy discriminator", () => {
  it("returns matchedBy='prompt_id' when promptId hits", () => {
    const turn = { promptId: "p1", inputTokens: 5, outputTokens: 3, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 8, model: "m", prompt: null, response: null, turnIndex: 0 };
    const result = {
      turns: [turn],
      byPromptId: new Map([["p1", turn]]),
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

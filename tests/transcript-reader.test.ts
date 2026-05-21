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

describe("readTranscript — synthetic slash-command lines do not count as real turns", () => {
  // Claude Code emits synthetic user lines for client-only slash commands like
  // /model and /clear — typically a triple: <local-command-caveat> (isMeta:true),
  // <command-name>/foo, <local-command-stdout>. These never fire UserPromptSubmit,
  // so they must be excluded from the real-turn index, or the collector's
  // turnIndex (which counts UserPromptSubmit events) drifts off-by-N from
  // transcript ordinals and selectTurn returns the wrong turn.
  it("skips /model-style synthetic triples and aligns ordinals with real prompts", () => {
    const p = make(
      [
        // /model client-only command: 3 synthetic user lines sharing one promptId
        JSON.stringify({ type: "user", isMeta: true, promptId: "cmd1", message: { content: "<local-command-caveat>Caveat: ...</local-command-caveat>" } }),
        JSON.stringify({ type: "user", promptId: "cmd1", message: { content: "<command-name>/model</command-name>\n<command-args></command-args>" } }),
        JSON.stringify({ type: "user", promptId: "cmd1", message: { content: "<local-command-stdout>Set model to Sonnet</local-command-stdout>" } }),
        // First real prompt — UserPromptSubmit would fire here, collector turnIndex=0
        JSON.stringify({ type: "user", promptId: "real1", message: { content: "Hello how are you" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "text", text: "Doing well, thanks!" }] } }),
        // Second real prompt — collector turnIndex=1
        JSON.stringify({ type: "user", promptId: "real2", message: { content: "another reply please" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: "text", text: "Here you go." }] } }),
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.degraded).toBe(false);
    // Only 2 REAL turns — the 3 /model synthetic lines collapse to 0.
    expect(r.turns).toHaveLength(2);
    // Ordinal 0 must be "Hello", not the caveat — this is what selectTurn
    // returns when UserPromptSubmit lacks prompt_id and falls back to ordinal.
    expect(r.turns[0].promptId).toBe("real1");
    expect(r.turns[0].response).toBe("Doing well, thanks!");
    expect(r.turns[1].promptId).toBe("real2");
    expect(r.turns[1].response).toBe("Here you go.");
    // byPromptId must NOT contain the synthetic prompt_id at all.
    expect(r.byPromptId.has("cmd1")).toBe(false);
    expect(selectTurn(r, undefined, 0).turn!.response).toBe("Doing well, thanks!");
  });
});

describe("readTranscript — multi-completion turn (text → tool → text)", () => {
  // When the assistant emits text, calls a tool, then emits more text, the
  // transcript holds two distinct assistant JSONL lines under one user
  // prompt. Sentry AI Conversations renders each entry in
  // gen_ai.output.messages as a separate bubble, so we must keep them split
  // — collapsing into a single newline-joined entry hides every text after
  // the first.
  it("collects each assistant completion into responses[] (one per JSONL line)", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "do the thing" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Message 1." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "text", text: "Message 2." }] } }),
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].responses).toEqual(["Message 1.", "Message 2."]);
    // response (joined string) preserved for backward compat / missingness checks.
    expect(r.turns[0].response).toBe("Message 1.\nMessage 2.");
    // The trailing assistant message is text-only → no follow-up expected.
    expect(r.turns[0].endsWithToolUse).toBe(false);
  });

  // Reproduces the file-flush race that hit Sentry session
  // 539e96b1-…-d40962357876: Stop fired ~70ms after the assistant wrote its
  // trailing text JSONL line, so closeCurrentTurn read a snapshot where the
  // turn's last visible assistant message was still the tool_use. The
  // endsWithToolUse flag is what tells the retry path to wait once instead
  // of emitting a partial gen_ai.output.messages.
  it("flags endsWithToolUse=true when the trailing text completion hasn't flushed yet", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", promptId: "p1", message: { content: "do the thing" } }),
        JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: "Message 1." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
        // Trailing assistant text line NOT yet on disk — simulates the
        // Stop-vs-JSONL-flush race.
      ].join("\n"),
    );
    const r = readTranscript(p);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].responses).toEqual(["Message 1."]);
    expect(r.turns[0].endsWithToolUse).toBe(true);
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

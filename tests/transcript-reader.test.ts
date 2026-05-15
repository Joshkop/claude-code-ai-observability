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

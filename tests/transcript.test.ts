import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPerTurnTokens, extractSidechainUsage, extractTotals } from "../src/transcript.js";

function tmpFile(content: string): string {
  const p = join(tmpdir(), `transcript-test-${Date.now()}-${Math.random()}.jsonl`);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("extractPerTurnTokens", () => {
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

  it("returns empty array for nonexistent file", () => {
    expect(extractPerTurnTokens("/tmp/__no_such_file_aiobs__.jsonl")).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const p = make("");
    expect(extractPerTurnTokens(p)).toEqual([]);
  });

  it("single turn with no usage", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", content: "hi" } }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].inputTokens).toBe(0);
    expect(turns[0].outputTokens).toBe(0);
    expect(turns[0].model).toBe("claude-sonnet-4-6");
  });

  it("single turn with cache_read and cache_creation", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "prompt" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns).toHaveLength(1);
    // inputTokens = input + cacheCreate + cacheRead = 100 + 20 + 30 = 150
    expect(turns[0].inputTokens).toBe(150);
    expect(turns[0].cachedInputTokens).toBe(30);
    expect(turns[0].cacheCreationTokens).toBe(20);
    expect(turns[0].outputTokens).toBe(50);
    expect(turns[0].totalTokens).toBe(200);
    expect(turns[0].model).toBe("claude-opus-4-7");
  });

  it("multiple turns accumulate separately", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "turn 1" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } } }) + "\n" +
      JSON.stringify({ type: "user", message: { content: "turn 2" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 20, output_tokens: 8 } } }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns).toHaveLength(2);
    expect(turns[0].inputTokens).toBe(10);
    expect(turns[0].outputTokens).toBe(5);
    expect(turns[1].inputTokens).toBe(20);
    expect(turns[1].outputTokens).toBe(8);
  });

  it("missing model field results in null model", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n" +
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, output_tokens: 2 } } }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns[0].model).toBeNull();
  });

  it("malformed JSONL lines are skipped without throwing", () => {
    const p = make(
      JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n" +
      "not valid json {{{" + "\n" +
      JSON.stringify({ type: "assistant", message: { model: "claude-haiku-4-5-20251001", usage: { input_tokens: 3, output_tokens: 1 } } }) + "\n"
    );
    const turns = extractPerTurnTokens(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("extractTotals", () => {
  it("sums across multiple turns", () => {
    const turns = [
      { turnIndex: 0, inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, cacheCreationTokens: 5, totalTokens: 150, model: null, prompt: null, response: null },
      { turnIndex: 1, inputTokens: 200, outputTokens: 80, cachedInputTokens: 20, cacheCreationTokens: 0, totalTokens: 280, model: null, prompt: null, response: null },
    ];
    const totals = extractTotals(turns);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(130);
    expect(totals.cachedInputTokens).toBe(30);
    expect(totals.totalTokens).toBe(430);
  });
});

describe("extractSidechainUsage", () => {
  const files: string[] = [];
  function make(content: string): string {
    const p = tmpFile(content);
    files.push(p);
    return p;
  }
  afterEach(() => {
    for (const f of files) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    files.length = 0;
  });

  it("aggregates assistant usage across the whole sidechain", () => {
    const p = make(
      [
        JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-04-28T10:00:00Z", message: { role: "user", content: "go" } }),
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          timestamp: "2026-04-28T10:00:01Z",
          message: { model: "claude-sonnet-4-6", role: "assistant", usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 } },
        }),
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          timestamp: "2026-04-28T10:00:05Z",
          message: { model: "claude-sonnet-4-6", role: "assistant", usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50 } },
        }),
      ].join("\n"),
    );
    const u = extractSidechainUsage(p);
    expect(u).not.toBeNull();
    expect(u!.model).toBe("claude-sonnet-4-6");
    // input = (10+5+100) + (3+0+50) = 168
    expect(u!.inputTokens).toBe(168);
    expect(u!.outputTokens).toBe(27);
    expect(u!.cachedInputTokens).toBe(150);
    expect(u!.cacheCreationTokens).toBe(5);
    expect(u!.assistantTurnCount).toBe(2);
    expect(u!.startTime).toBe(Date.parse("2026-04-28T10:00:00Z") / 1000);
    expect(u!.endTime).toBe(Date.parse("2026-04-28T10:00:05Z") / 1000);
  });

  it("returns null when no assistant entries are present", () => {
    const p = make(JSON.stringify({ type: "user", message: { role: "user", content: "go" } }));
    expect(extractSidechainUsage(p)).toBeNull();
  });

  it("returns null when file does not exist", () => {
    expect(extractSidechainUsage("/no/such/file.jsonl")).toBeNull();
  });
});

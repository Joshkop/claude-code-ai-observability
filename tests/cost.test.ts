import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeCost, loadPriceTable, DEFAULT_PRICE_TABLE } from "../src/cost.js";

describe("computeCost", () => {
  it("returns zero cost for null model", () => {
    const cost = computeCost({ model: null, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 });
    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
    expect(cost.totalCost).toBe(0);
  });

  it("returns zero cost for unknown model", () => {
    const cost = computeCost({ model: "unknown-model-xyz", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500 });
    expect(cost.totalCost).toBe(0);
  });

  it("computes correct cost for claude-opus-4-7", () => {
    // $15/M input, $75/M output
    // 1M input tokens → $15, 1M output → $75
    const cost = computeCost(
      { model: "claude-opus-4-7", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      DEFAULT_PRICE_TABLE,
    );
    expect(cost.inputCost).toBeCloseTo(15, 4);
    expect(cost.outputCost).toBeCloseTo(75, 4);
    expect(cost.totalCost).toBeCloseTo(90, 4);
  });

  it("computes correct cost for claude-sonnet-4-6", () => {
    // $3/M input, $15/M output
    const cost = computeCost(
      { model: "claude-sonnet-4-6", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      DEFAULT_PRICE_TABLE,
    );
    expect(cost.inputCost).toBeCloseTo(3, 4);
    expect(cost.outputCost).toBeCloseTo(15, 4);
  });

  it("computes correct cost for claude-haiku-4-5-20251001", () => {
    // $1/M input, $5/M output
    const cost = computeCost(
      { model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 },
      DEFAULT_PRICE_TABLE,
    );
    expect(cost.inputCost).toBeCloseTo(1, 4);
    expect(cost.outputCost).toBeCloseTo(5, 4);
  });

  it("cached input priced at cacheRead rate, not input rate", () => {
    // Opus: input=$15/M, cacheRead=$1.5/M
    // 1M tokens, all cached → $1.5 input cost
    const costAllCached = computeCost(
      { model: "claude-opus-4-7", inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
      DEFAULT_PRICE_TABLE,
    );
    expect(costAllCached.inputCost).toBeCloseTo(1.5, 4);

    // 1M tokens, none cached → $15 input cost
    const costNoCached = computeCost(
      { model: "claude-opus-4-7", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
      DEFAULT_PRICE_TABLE,
    );
    expect(costNoCached.inputCost).toBeCloseTo(15, 4);
  });

  it("small token counts produce nonzero cost for known models", () => {
    const cost = computeCost(
      { model: "claude-sonnet-4-6", inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
      DEFAULT_PRICE_TABLE,
    );
    // Not zero — just verify sign
    expect(cost.totalCost).toBeGreaterThan(0);
  });
});

describe("loadPriceTable", () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.CLAUDE_AIOBS_PRICE_OVERRIDES;
    delete process.env.CLAUDE_AIOBS_PRICE_OVERRIDES;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.CLAUDE_AIOBS_PRICE_OVERRIDES;
    } else {
      process.env.CLAUDE_AIOBS_PRICE_OVERRIDES = origEnv;
    }
  });

  it("returns default table when no overrides", () => {
    const table = loadPriceTable();
    expect(table["claude-opus-4-7"]).toBeDefined();
    expect(table["claude-sonnet-4-6"]).toBeDefined();
  });

  it("env CLAUDE_AIOBS_PRICE_OVERRIDES merges into table", () => {
    process.env.CLAUDE_AIOBS_PRICE_OVERRIDES = JSON.stringify({
      "my-custom-model": { input: 2, cacheCreation: 2.5, cacheRead: 0.2, output: 10 },
    });
    const table = loadPriceTable();
    expect(table["my-custom-model"]).toBeDefined();
    expect(table["my-custom-model"].input).toBe(2);
    // defaults still present
    expect(table["claude-opus-4-7"]).toBeDefined();
  });

  it("env override can override existing model pricing", () => {
    process.env.CLAUDE_AIOBS_PRICE_OVERRIDES = JSON.stringify({
      "claude-opus-4-7": { input: 99, cacheCreation: 99, cacheRead: 99, output: 99 },
    });
    const table = loadPriceTable();
    expect(table["claude-opus-4-7"].input).toBe(99);
  });

  it("invalid env JSON is silently ignored", () => {
    process.env.CLAUDE_AIOBS_PRICE_OVERRIDES = "not-json";
    expect(() => loadPriceTable()).not.toThrow();
    const table = loadPriceTable();
    expect(table["claude-opus-4-7"]).toBeDefined();
  });

  it("direct overrides parameter takes priority over env", () => {
    process.env.CLAUDE_AIOBS_PRICE_OVERRIDES = JSON.stringify({
      "claude-opus-4-7": { input: 50, cacheCreation: 50, cacheRead: 50, output: 50 },
    });
    const table = loadPriceTable({
      "claude-opus-4-7": { input: 1, cacheCreation: 1, cacheRead: 1, output: 1 },
    });
    // direct overrides win
    expect(table["claude-opus-4-7"].input).toBe(1);
  });
});

import type { ResolvedPluginConfig } from "./types.js";

export interface ModelPriceEntry {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export type PriceTable = Record<string, ModelPriceEntry>;

export interface TurnCost {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export interface ComputeCostInput {
  model: string | null | undefined;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const MICRO = 100_000_000;

export const DEFAULT_PRICE_TABLE: PriceTable = {
  "claude-opus-4-7": { input: 15, cacheCreation: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4-6": { input: 3, cacheCreation: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 },
};

export function loadPriceTable(
  overrides?: PriceTable | null,
  config?: Pick<ResolvedPluginConfig, "tags"> & { prices?: PriceTable },
): PriceTable {
  const merged: PriceTable = { ...DEFAULT_PRICE_TABLE };

  const envRaw = process.env.CLAUDE_AIOBS_PRICE_OVERRIDES;
  if (envRaw && envRaw.trim().length > 0) {
    const parsed = safeParsePriceTable(envRaw);
    if (parsed) Object.assign(merged, parsed);
  }

  const fromConfig = config?.prices;
  if (fromConfig && typeof fromConfig === "object") {
    for (const [k, v] of Object.entries(fromConfig)) {
      if (isValidPriceEntry(v)) merged[k] = v;
    }
  }

  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      if (isValidPriceEntry(v)) merged[k] = v;
    }
  }

  return merged;
}

export function computeCost(
  input: ComputeCostInput,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): TurnCost {
  const zero: TurnCost = { inputCost: 0, outputCost: 0, totalCost: 0 };

  if (!input || !input.model) return zero;
  const price = table[input.model];
  if (!price) return zero;

  const inputTokens = toNonNegInt(input.inputTokens);
  const cachedInputTokens = Math.min(toNonNegInt(input.cachedInputTokens), inputTokens);
  const outputTokens = toNonNegInt(input.outputTokens);
  const nonCachedInput = inputTokens - cachedInputTokens;

  const inputMicros =
    nonCachedInput * priceToMicrosPerToken(price.input) +
    cachedInputTokens * priceToMicrosPerToken(price.cacheRead);
  const outputMicros = outputTokens * priceToMicrosPerToken(price.output);

  const inputCost = inputMicros / MICRO;
  const outputCost = outputMicros / MICRO;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

function priceToMicrosPerToken(perMTokenUSD: number): number {
  return Math.round((perMTokenUSD * MICRO) / 1_000_000);
}

function toNonNegInt(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function isValidPriceEntry(v: unknown): v is ModelPriceEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.input === "number" &&
    typeof e.output === "number" &&
    typeof e.cacheCreation === "number" &&
    typeof e.cacheRead === "number"
  );
}

function safeParsePriceTable(raw: string): PriceTable | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const out: PriceTable = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidPriceEntry(v)) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

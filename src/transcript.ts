import { readFileSync } from "node:fs";
import type { TurnTokens, Totals } from "./types.js";

interface AssistantUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptLine {
  type?: string;
  message?: {
    model?: string;
    usage?: AssistantUsage;
    content?: unknown;
    role?: string;
  };
}

function emptyTurn(turnIndex: number): TurnTokens {
  return {
    turnIndex,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    model: null,
    prompt: null,
    response: null,
  };
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.length ? parts.join("\n") : null;
}

export function extractPerTurnTokens(path: string): TurnTokens[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const turns: TurnTokens[] = [];
  let current: TurnTokens | null = null;
  let turnIndex = -1;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.type === "user") {
      if (current) turns.push(current);
      turnIndex += 1;
      current = emptyTurn(turnIndex);
      const text = extractTextFromContent(parsed.message?.content);
      if (text) current.prompt = text;
      continue;
    }
    if (parsed.type === "assistant") {
      if (!current) {
        turnIndex += 1;
        current = emptyTurn(turnIndex);
      }
      const usage = parsed.message?.usage;
      if (usage) {
        const input = usage.input_tokens ?? 0;
        const cacheCreate = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        current.inputTokens += input + cacheCreate + cacheRead;
        current.cachedInputTokens += cacheRead;
        current.cacheCreationTokens += cacheCreate;
        current.outputTokens += output;
        current.totalTokens = current.inputTokens + current.outputTokens;
      }
      if (parsed.message?.model) current.model = parsed.message.model;
      const text = extractTextFromContent(parsed.message?.content);
      if (text) {
        current.response = current.response ? `${current.response}\n${text}` : text;
      }
    }
  }
  if (current) turns.push(current);
  return turns;
}

export interface SidechainUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  model: string | null;
  /** Unix-seconds timestamp of the first sidechain user message (best-effort). */
  startTime?: number;
  /** Unix-seconds timestamp of the last assistant message (best-effort). */
  endTime?: number;
  /** Number of assistant turns recorded in this sidechain transcript. */
  assistantTurnCount: number;
}

interface SidechainLine extends TranscriptLine {
  isSidechain?: boolean;
  timestamp?: string;
}

/**
 * Aggregate token usage across an entire sidechain (subagent) transcript.
 * Unlike extractPerTurnTokens which breaks per user-message boundary, this
 * sums every assistant usage record in the file — the natural unit for one
 * subagent invocation since subagents typically run a single self-contained
 * loop and write one transcript file.
 */
export function extractSidechainUsage(filePath: string): SidechainUsage | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let model: string | null = null;
  let startTime: number | undefined;
  let endTime: number | undefined;
  let assistantTurnCount = 0;
  let any = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: SidechainLine;
    try {
      parsed = JSON.parse(trimmed) as SidechainLine;
    } catch {
      continue;
    }
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) / 1000 : undefined;
    if (parsed.type === "user" && ts !== undefined && startTime === undefined) {
      startTime = ts;
    }
    if (parsed.type === "assistant") {
      any = true;
      assistantTurnCount += 1;
      if (ts !== undefined) endTime = ts;
      const usage = parsed.message?.usage;
      if (usage) {
        const input = usage.input_tokens ?? 0;
        const cacheCreate = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        inputTokens += input + cacheCreate + cacheRead;
        cachedInputTokens += cacheRead;
        cacheCreationTokens += cacheCreate;
        outputTokens += output;
      }
      if (parsed.message?.model) model = parsed.message.model;
    }
  }
  if (!any) return null;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    model,
    startTime,
    endTime,
    assistantTurnCount,
  };
}

export function extractTotals(turns: TurnTokens[]): Totals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  for (const t of turns) {
    inputTokens += t.inputTokens;
    outputTokens += t.outputTokens;
    cachedInputTokens += t.cachedInputTokens;
    cacheCreationTokens += t.cacheCreationTokens;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

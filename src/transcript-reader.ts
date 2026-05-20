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

// Dual camelCase/snake_case fields tolerate both Claude Code serialisations.
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
  // Rare degraded fallback re-reads by path: transcript.ts is intentionally
  // unchanged this release; fails safe to [] if the file vanished meanwhile.
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
    // Missing/not-yet-flushed transcript is normal, not JSONL format drift —
    // keep degraded=false so claude_code.transcript.parse_degraded stays
    // reserved for genuine schema drift (spec C6).
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

export interface SelectTurnResult {
  turn: RealTurn | null;
  matchedBy: "prompt_id" | "ordinal" | "none";
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
): SelectTurnResult {
  if (promptId) {
    const byId = result.byPromptId.get(promptId);
    if (byId) return { turn: byId, matchedBy: "prompt_id" };
  }
  const t = result.turns[ordinal];
  if (t) return { turn: t, matchedBy: "ordinal" };
  return { turn: null, matchedBy: "none" };
}

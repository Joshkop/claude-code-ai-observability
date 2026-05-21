import { readFileSync } from "node:fs";
import { extractPerTurnTokens } from "./transcript.js";
export { extractSidechainUsage } from "./transcript.js";
function emptyTurn(promptId, index) {
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
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const b of content) {
        if (b && typeof b === "object") {
            const o = b;
            if (o.type === "text" && typeof o.text === "string")
                parts.push(o.text);
        }
    }
    return parts.length ? parts.join("\n") : null;
}
function isToolResultUserLine(content) {
    if (!Array.isArray(content))
        return false;
    return content.some((b) => b && typeof b === "object" && b.type === "tool_result");
}
function promptIdOf(l) {
    return l.promptId ?? l.prompt_id ?? null;
}
function isMetaOf(l) {
    return l.isMeta === true || l.is_meta === true;
}
// Client-only slash commands like /model and /clear are surfaced in the
// transcript as a synthetic user-line triple (<local-command-caveat>,
// <command-name>, <local-command-stdout>) but never fire UserPromptSubmit,
// so they must NOT count as real turns. Detect them by the unmistakable
// <local-command-*> wrappers — these only appear on client-side commands;
// model-bound slash commands (e.g. /superpowers:foo) have <command-name>
// without any <local-command-*> sibling.
function isLocalCommandText(text) {
    if (!text)
        return false;
    return text.startsWith("<local-command-stdout>") || text.startsWith("<local-command-caveat>");
}
function collectSessionDims(l, into) {
    if (into.permissionMode === undefined) {
        into.permissionMode = l.permissionMode ?? l.permission_mode;
    }
    if (into.agentName === undefined)
        into.agentName = l.agentName ?? l.agent_name;
    if (into.entrypoint === undefined)
        into.entrypoint = l.entrypoint;
}
function legacyResult(path, reason) {
    // Rare degraded fallback re-reads by path: transcript.ts is intentionally
    // unchanged this release; fails safe to [] if the file vanished meanwhile.
    const turns = extractPerTurnTokens(path).map((t) => ({ ...t, promptId: null }));
    return {
        turns,
        byPromptId: new Map(),
        degraded: true,
        degradedReason: reason,
        session: {},
    };
}
export function readTranscript(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        // Missing/not-yet-flushed transcript is normal, not JSONL format drift —
        // keep degraded=false so claude_code.transcript.parse_degraded stays
        // reserved for genuine schema drift (spec C6).
        return { turns: [], byPromptId: new Map(), degraded: false, session: {} };
    }
    const rawLines = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (rawLines.length === 0) {
        return { turns: [], byPromptId: new Map(), degraded: false, session: {} };
    }
    const parsed = [];
    let recognizedTypeLines = 0;
    for (const ln of rawLines) {
        try {
            const o = JSON.parse(ln);
            parsed.push(o);
            if (typeof o.type === "string")
                recognizedTypeLines += 1;
        }
        catch {
            // skip unparseable line
        }
    }
    // C6: nothing parsed as a typed transcript line → unknown schema.
    if (recognizedTypeLines === 0) {
        return legacyResult(path, "no recognizable transcript line types");
    }
    // Pre-pass: any prompt_id that has at least one <local-command-*> line is
    // a client-only slash command (/model, /clear, …). Every user line under
    // that prompt_id must be excluded from real-turn segmentation; otherwise
    // the synthetic triple bumps the real-turn ordinal off-by-N from the
    // collector's turnIndex (which only counts true UserPromptSubmit events).
    const clientOnlyPromptIds = new Set();
    for (const l of parsed) {
        if (l.type !== "user")
            continue;
        if (l.isSidechain === true)
            continue;
        const pid = promptIdOf(l);
        if (!pid)
            continue;
        if (isLocalCommandText(textFromContent(l.message?.content))) {
            clientOnlyPromptIds.add(pid);
        }
    }
    const turns = [];
    const byPromptId = new Map();
    const session = {};
    let current = null;
    let realIndex = -1;
    let sawAssistantUsage = false;
    for (const l of parsed) {
        collectSessionDims(l, session);
        if (l.type === "user") {
            if (l.isSidechain === true)
                continue;
            if (isToolResultUserLine(l.message?.content))
                continue;
            // Skip caveat / meta lines — these are Claude Code annotations, not
            // user input, and never fire UserPromptSubmit.
            if (isMetaOf(l))
                continue;
            const pid = promptIdOf(l);
            // Skip every line in a client-only slash-command group (see pre-pass).
            if (pid && clientOnlyPromptIds.has(pid))
                continue;
            // Defensive: also skip a bare <local-command-*> line that somehow lacks
            // a prompt_id (older Claude Code builds).
            if (isLocalCommandText(textFromContent(l.message?.content)))
                continue;
            if (current)
                turns.push(current);
            realIndex += 1;
            current = emptyTurn(pid, realIndex);
            const t = textFromContent(l.message?.content);
            if (t)
                current.prompt = t;
            if (pid)
                byPromptId.set(pid, current);
            continue;
        }
        if (l.type === "assistant") {
            if (l.isSidechain === true)
                continue; // sidechain isolation
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
            if (l.message?.model)
                current.model = l.message.model;
            const t = textFromContent(l.message?.content);
            if (t)
                current.response = current.response ? `${current.response}\n${t}` : t;
        }
    }
    if (current)
        turns.push(current);
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
export function selectTurn(result, promptId, ordinal) {
    if (promptId) {
        const byId = result.byPromptId.get(promptId);
        if (byId)
            return { turn: byId, matchedBy: "prompt_id" };
    }
    const t = result.turns[ordinal];
    if (t)
        return { turn: t, matchedBy: "ordinal" };
    return { turn: null, matchedBy: "none" };
}

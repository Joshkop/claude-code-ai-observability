import { readFileSync } from "node:fs";
function emptyTurn(turnIndex) {
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
function extractTextFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const block of content) {
        if (block && typeof block === "object") {
            const b = block;
            if (b.type === "text" && typeof b.text === "string") {
                parts.push(b.text);
            }
        }
    }
    return parts.length ? parts.join("\n") : null;
}
export function extractPerTurnTokens(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const turns = [];
    let current = null;
    let turnIndex = -1;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (parsed.type === "user") {
            if (current)
                turns.push(current);
            turnIndex += 1;
            current = emptyTurn(turnIndex);
            const text = extractTextFromContent(parsed.message?.content);
            if (text)
                current.prompt = text;
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
            if (parsed.message?.model)
                current.model = parsed.message.model;
            const text = extractTextFromContent(parsed.message?.content);
            if (text) {
                current.response = current.response ? `${current.response}\n${text}` : text;
            }
        }
    }
    if (current)
        turns.push(current);
    return turns;
}
/**
 * Aggregate token usage across an entire sidechain (subagent) transcript.
 * Unlike extractPerTurnTokens which breaks per user-message boundary, this
 * sums every assistant usage record in the file — the natural unit for one
 * subagent invocation since subagents typically run a single self-contained
 * loop and write one transcript file.
 */
export function extractSidechainUsage(filePath) {
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch {
        return null;
    }
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cacheCreationTokens = 0;
    let model = null;
    let startTime;
    let endTime;
    let assistantTurnCount = 0;
    let any = false;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const ts = parsed.timestamp ? Date.parse(parsed.timestamp) / 1000 : undefined;
        if (parsed.type === "user" && ts !== undefined && startTime === undefined) {
            startTime = ts;
        }
        if (parsed.type === "assistant") {
            any = true;
            assistantTurnCount += 1;
            if (ts !== undefined)
                endTime = ts;
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
            if (parsed.message?.model)
                model = parsed.message.model;
        }
    }
    if (!any)
        return null;
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
export function extractTotals(turns) {
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

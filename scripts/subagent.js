import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { scrubString } from "./serialize.js";
import { extractSidechainUsage } from "./transcript.js";
import { deriveSubagentSource } from "./attribution.js";
export function createSubagentSession() {
    return { active: new Map() };
}
export function isSubagentInvocation(event) {
    if (!event)
        return false;
    if (event.hook_event_name !== "PreToolUse" && event.hook_event_name !== "PostToolUse") {
        return false;
    }
    const toolName = event.tool_name;
    return toolName === "Task" || toolName === "Agent";
}
/**
 * Returns the most-recently-started active subagent wrapper span for the
 * given session, or null. Used by the dispatcher to nest tool calls that
 * occur while a subagent is running under the wrapper instead of directly
 * under the parent turn span.
 */
export function findActiveSubagentSpan(session, sessionId) {
    if (!sessionId)
        return null;
    let latest = null;
    for (const entry of session.active.values()) {
        if (entry.sessionId !== sessionId)
            continue;
        latest = entry; // Map preserves insertion order; last match = most recent.
    }
    return latest?.span ?? null;
}
export function createSubagentSpan(sentry, event, options = {}) {
    const maxAttrLen = options.maxAttrLen ?? 12000;
    const { subagentType, prompt, description } = readTaskInput(event.tool_input);
    const name = `invoke_agent ${subagentType ?? "subagent"}`;
    const attributes = {
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": event.session_id,
    };
    if (subagentType)
        attributes["gen_ai.agent.name"] = subagentType;
    if (description)
        attributes["gen_ai.agent.description"] = scrubString(truncate(description, maxAttrLen));
    if (prompt)
        attributes["gen_ai.request.messages"] = scrubString(truncate(prompt, maxAttrLen));
    if (event.tool_use_id)
        attributes["gen_ai.tool.call.id"] = event.tool_use_id;
    // Dual-namespaced on purpose: gen_ai.agent.* for generic OTel AI tooling,
    // claude_code.subagent.* for plugin dashboards (no cross-namespace joins).
    // `attributes` is string-only (span-construction map); depth/duration/error
    // are set later via setAttribute as real number/boolean.
    const src = deriveSubagentSource(subagentType, undefined);
    attributes["claude_code.subagent.source"] = src.source;
    if (src.inferred)
        attributes["claude_code.subagent.source_inferred"] = "true";
    if (subagentType)
        attributes["claude_code.subagent.name"] = subagentType;
    if (description) {
        attributes["claude_code.subagent.description"] = scrubString(truncate(description, maxAttrLen));
    }
    const startSpan = sentry.startInactiveSpan;
    if (typeof startSpan !== "function")
        return null;
    try {
        return startSpan.call(sentry, {
            name,
            op: "gen_ai.invoke_agent",
            attributes,
            ...(options.parent ? { parentSpan: options.parent } : {}),
        });
    }
    catch {
        return null;
    }
}
export function attachSubagentToEvent(sentry, session, event, options = {}) {
    if (!isSubagentInvocation(event))
        return false;
    if (event.hook_event_name === "PreToolUse") {
        const pre = event;
        // N5: nest under an already-active subagent for THIS session, if any.
        const enclosing = findEnclosingActive(session, pre.session_id);
        const span = createSubagentSpan(sentry, pre, {
            ...options,
            parent: enclosing?.span ?? options.parent,
        });
        if (!span)
            return true;
        // Real Claude Code Task/Agent events always carry tool_use_id; the
        // `?? size` fallback only sequences pathological no-id events. Two
        // concurrent no-id subagents in one session would resolve FIFO at
        // PostToolUse (findFirstKeyForSession) — acceptable for that edge.
        const key = `${pre.session_id}::${pre.tool_use_id ?? session.active.size}`;
        const { subagentType, description, prompt } = readTaskInput(pre.tool_input);
        const subagentDir = computeSubagentDir(options.parentTranscriptPath, pre.session_id);
        const depth = enclosing ? enclosing.depth + 1 : 0;
        session.active.set(key, {
            span,
            subagentType: subagentType ?? "subagent",
            toolUseId: pre.tool_use_id,
            preExisting: subagentDir ? listAgentFiles(subagentDir) : undefined,
            subagentDir,
            startedAt: Date.now(),
            sessionId: pre.session_id,
            matchDescription: description,
            matchPrompt: prompt,
            parentSpan: enclosing?.span ?? options.parent,
            depth,
        });
        try {
            span.setAttribute("claude_code.subagent.depth", depth);
        }
        catch { /* ignore */ }
        return true;
    }
    if (event.hook_event_name === "PostToolUse") {
        const post = event;
        const key = post.tool_use_id
            ? findKeyByToolUse(session.active, post.session_id, post.tool_use_id)
            : findFirstKeyForSession(session.active, post.session_id);
        if (!key)
            return true;
        const entry = session.active.get(key);
        if (!entry)
            return true;
        session.active.delete(key);
        // Synthesize a gen_ai.chat child under the wrapper carrying the
        // subagent's actual model + token usage. Without this the wrapper span
        // is a stub and Sentry's AI Agents widgets show no per-subagent
        // breakdown.
        try {
            const usage = locateSidechainUsage(entry);
            if (usage) {
                attachChatChild(sentry, entry.span, usage, {
                    sessionId: entry.sessionId,
                    subagentType: entry.subagentType,
                });
            }
        }
        catch {
            // best-effort — never fail PostToolUse on observability gaps.
        }
        if (post.tool_error) {
            trySetStatus(entry.span, "internal_error");
            trySetAttribute(entry.span, "gen_ai.tool.error", true);
            const msg = coerceErrorMessage(post.tool_response, options.maxAttrLen ?? 1024);
            if (msg)
                trySetAttribute(entry.span, "gen_ai.tool.error.message", msg);
        }
        else {
            trySetStatus(entry.span, "ok");
        }
        trySetAttribute(entry.span, "claude_code.subagent.duration_ms", Date.now() - entry.startedAt);
        trySetAttribute(entry.span, "claude_code.subagent.error", post.tool_error === true);
        tryEnd(entry.span);
        return true;
    }
    return false;
}
function readTaskInput(input) {
    if (!input || typeof input !== "object")
        return {};
    const o = input;
    return {
        subagentType: typeof o.subagent_type === "string" ? o.subagent_type : undefined,
        prompt: typeof o.prompt === "string" ? o.prompt : undefined,
        description: typeof o.description === "string" ? o.description : undefined,
    };
}
/**
 * Resolve the per-session subagents directory. Claude Code lays transcripts
 * out as `<projectDir>/<sessionId>.jsonl` plus a sibling
 * `<projectDir>/<sessionId>/subagents/agent-*.jsonl` per spawned subagent.
 */
function computeSubagentDir(parentTranscriptPath, sessionId) {
    if (!parentTranscriptPath || !sessionId)
        return undefined;
    const dir = path.dirname(parentTranscriptPath);
    return path.join(dir, sessionId, "subagents");
}
function listAgentFiles(dir) {
    try {
        return new Set(readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl")));
    }
    catch {
        return new Set();
    }
}
/**
 * Find the sidechain transcript that belongs to this subagent invocation.
 * Strategy:
 *  1. List current agent-*.jsonl files; new ones are candidates.
 *  2. Prefer the candidate whose .meta.json agentType matches subagentType.
 *  3. Otherwise fall back to the most-recently-modified candidate.
 *  4. If no new files exist (subagent reused an existing transcript or
 *     dir layout differs), fall back to the newest file modified after
 *     the wrapper started.
 */
function locateSidechainUsage(entry) {
    if (!entry.subagentDir)
        return null;
    const dir = entry.subagentDir;
    let files;
    try {
        files = readdirSync(dir).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
    }
    catch {
        return null;
    }
    if (!files.length)
        return null;
    const preExisting = entry.preExisting ?? new Set();
    const candidates = files.filter((f) => !preExisting.has(f));
    const search = candidates.length ? candidates : files;
    const scored = [];
    for (const f of search) {
        const full = path.join(dir, f);
        let mtimeMs = 0;
        try {
            mtimeMs = statSync(full).mtimeMs;
        }
        catch {
            continue;
        }
        // 5s back-window tolerates clock skew between PreToolUse and the
        // sidechain file's first write; `search` already excludes preExisting
        // files so this only guards the no-new-candidates fallback path.
        if (mtimeMs < entry.startedAt - 5_000)
            continue;
        const meta = readMeta(full);
        const descMatch = !!entry.matchDescription &&
            typeof meta?.description === "string" &&
            meta.description === entry.matchDescription;
        const agentTypeMatch = typeof meta?.agentType === "string" && meta.agentType === entry.subagentType;
        scored.push({ file: full, mtimeMs, descMatch, agentTypeMatch });
    }
    if (!scored.length)
        return null;
    scored.sort((a, b) => {
        // C5: exact description match is authoritative; agentType then mtime
        // are tiebreakers only.
        if (a.descMatch !== b.descMatch)
            return a.descMatch ? -1 : 1;
        if (a.agentTypeMatch !== b.agentTypeMatch)
            return a.agentTypeMatch ? -1 : 1;
        return b.mtimeMs - a.mtimeMs;
    });
    return extractSidechainUsage(scored[0].file);
}
function readMeta(transcriptPath) {
    const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
    try {
        const raw = readFileSync(metaPath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function attachChatChild(sentry, wrapper, usage, ctx) {
    const startSpan = sentry;
    if (typeof startSpan.startInactiveSpan !== "function")
        return;
    const create = () => {
        const attrs = {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.system": "anthropic",
            "gen_ai.conversation.id": ctx.sessionId,
            "gen_ai.agent.name": ctx.subagentType,
        };
        if (usage.model) {
            attrs["gen_ai.request.model"] = usage.model;
            attrs["gen_ai.response.model"] = usage.model;
        }
        return startSpan.startInactiveSpan.call(sentry, {
            op: "gen_ai.chat",
            name: usage.model ? `chat ${usage.model}` : "chat",
            ...(usage.startTime ? { startTime: usage.startTime } : {}),
            attributes: attrs,
        });
    };
    let chat;
    if (typeof startSpan.withActiveSpan === "function") {
        chat = startSpan.withActiveSpan.call(sentry, wrapper, create);
    }
    else {
        chat = create();
    }
    trySetAttribute(chat, "gen_ai.usage.input_tokens", usage.inputTokens);
    trySetAttribute(chat, "gen_ai.usage.output_tokens", usage.outputTokens);
    trySetAttribute(chat, "gen_ai.usage.total_tokens", usage.inputTokens + usage.outputTokens);
    trySetAttribute(chat, "gen_ai.usage.input_tokens.cached", usage.cachedInputTokens);
    if (usage.cacheCreationTokens) {
        trySetAttribute(chat, "gen_ai.usage.input_tokens.cache_write", usage.cacheCreationTokens);
    }
    if (usage.reasoningTokens && usage.reasoningTokens > 0) {
        trySetAttribute(chat, "gen_ai.usage.output_tokens.reasoning", usage.reasoningTokens);
        if (usage.reasoningEstimated) {
            trySetAttribute(chat, "claude_code.reasoning_tokens.estimated", true);
        }
    }
    if (typeof usage.assistantTurnCount === "number") {
        trySetAttribute(chat, "claude_code.subagent.assistant_turns", usage.assistantTurnCount);
    }
    // End the chat at the same time we end the wrapper. Pass endTime explicitly
    // so the chat span matches the subagent's actual end timestamp from the
    // transcript (otherwise it'd default to "now" minus the wrapper duration).
    const endTime = usage.endTime;
    const endFn = chat.end;
    if (typeof endFn === "function") {
        try {
            endFn.call(chat, endTime);
        }
        catch {
            /* ignore */
        }
    }
    // Mirror the model + cumulative-usage rollup onto the wrapper for filters.
    if (usage.model) {
        trySetAttribute(wrapper, "gen_ai.request.model", usage.model);
        trySetAttribute(wrapper, "gen_ai.response.model", usage.model);
    }
    trySetAttribute(wrapper, "gen_ai.usage.input_tokens", usage.inputTokens);
    trySetAttribute(wrapper, "gen_ai.usage.output_tokens", usage.outputTokens);
    trySetAttribute(wrapper, "gen_ai.usage.total_tokens", usage.inputTokens + usage.outputTokens);
}
function truncate(s, max) {
    if (typeof s !== "string")
        return "";
    return s.length <= max ? s : s.slice(0, max) + "…";
}
function coerceErrorMessage(value, max) {
    if (value == null)
        return null;
    let s;
    if (typeof value === "string")
        s = value;
    else {
        try {
            s = JSON.stringify(value);
        }
        catch {
            s = String(value);
        }
    }
    if (!s)
        return null;
    return scrubString(truncate(s, max));
}
function findKeyByToolUse(m, sessionId, toolUseId) {
    for (const [k, v] of m) {
        if (v.sessionId === sessionId && v.toolUseId === toolUseId)
            return k;
    }
    return undefined;
}
function findFirstKeyForSession(m, sessionId) {
    for (const [k, v] of m) {
        if (v.sessionId === sessionId)
            return k;
    }
    return undefined;
}
function findEnclosingActive(session, sessionId) {
    let latest = null;
    for (const v of session.active.values()) {
        if (v.sessionId === sessionId)
            latest = v;
    }
    return latest;
}
function trySetStatus(span, status) {
    const fn = span.setStatus;
    if (typeof fn === "function") {
        try {
            fn.call(span, { code: status === "ok" ? 1 : 2, message: status });
        }
        catch {
            /* ignore */
        }
    }
}
function trySetAttribute(span, key, value) {
    const fn = span.setAttribute;
    if (typeof fn === "function") {
        try {
            fn.call(span, key, value);
        }
        catch {
            /* ignore */
        }
    }
}
function tryEnd(span) {
    const fn = span.end;
    if (typeof fn === "function") {
        try {
            fn.call(span);
        }
        catch {
            /* ignore */
        }
    }
}

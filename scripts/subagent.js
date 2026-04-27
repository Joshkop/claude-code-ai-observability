import { scrubString } from "./serialize.js";
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
export function createSubagentSpan(sentry, event, options = {}) {
    const maxAttrLen = options.maxAttrLen ?? 12000;
    const { subagentType, prompt, description } = readTaskInput(event.tool_input);
    const name = `invoke_agent ${subagentType ?? "subagent"}`;
    const attributes = {
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        "gen_ai.operation.name": "invoke_agent",
    };
    if (subagentType)
        attributes["gen_ai.agent.name"] = subagentType;
    if (description)
        attributes["gen_ai.agent.description"] = scrubString(truncate(description, maxAttrLen));
    if (prompt)
        attributes["gen_ai.request.messages"] = scrubString(truncate(prompt, maxAttrLen));
    if (event.tool_use_id)
        attributes["gen_ai.tool.call.id"] = event.tool_use_id;
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
        const span = createSubagentSpan(sentry, pre, options);
        if (!span)
            return true;
        const key = pre.tool_use_id ?? `${pre.session_id}:${session.active.size}`;
        const { subagentType } = readTaskInput(pre.tool_input);
        session.active.set(key, {
            span,
            subagentType: subagentType ?? "subagent",
            toolUseId: pre.tool_use_id,
        });
        return true;
    }
    if (event.hook_event_name === "PostToolUse") {
        const post = event;
        const key = post.tool_use_id ?? findFirstKey(session.active);
        if (!key)
            return true;
        const entry = session.active.get(key);
        if (!entry)
            return true;
        session.active.delete(key);
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
function findFirstKey(m) {
    const it = m.keys().next();
    return it.done ? undefined : it.value;
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

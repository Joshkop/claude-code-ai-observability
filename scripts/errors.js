import { scrubString } from "./serialize.js";
const ERROR_MESSAGE_LIMIT = 1024;
export function applyToolError(span, event) {
    if (!span)
        return;
    trySetStatus(span, { code: 2, message: "tool_error" });
    trySetAttribute(span, "gen_ai.tool.error", true);
    const msg = coerceMessage(event.tool_response, ERROR_MESSAGE_LIMIT);
    if (msg)
        trySetAttribute(span, "gen_ai.tool.error.message", msg);
}
export function captureBreadcrumb(sentry, input) {
    const fn = sentry.addBreadcrumb;
    if (typeof fn !== "function")
        return;
    const data = {
        tool_name: input.event.tool_name,
    };
    if (input.event.tool_use_id)
        data.tool_use_id = input.event.tool_use_id;
    if (input.session?.sessionId)
        data["claude_code.session_id"] = input.session.sessionId;
    if (input.session?.sessionName)
        data["claude_code.session_name"] = input.session.sessionName;
    const msg = coerceMessage(input.event.tool_response, 256);
    if (msg)
        data.message = msg;
    try {
        fn.call(sentry, {
            category: "gen_ai.tool",
            level: "error",
            message: `tool_error: ${input.event.tool_name}`,
            data,
        });
    }
    catch {
        /* ignore */
    }
}
function coerceMessage(value, max) {
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
    return scrubString(s.length <= max ? s : s.slice(0, max) + "…");
}
function trySetStatus(span, status) {
    const fn = span.setStatus;
    if (typeof fn === "function") {
        try {
            fn.call(span, status);
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

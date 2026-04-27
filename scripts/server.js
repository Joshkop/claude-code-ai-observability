import { createServer } from "node:http";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { reportPluginError } from "./sentry-errors.js";
import { closeTurnSpan, createToolSpan, openTurnTransaction, } from "./spans.js";
import { extractPerTurnTokens } from "./transcript.js";
import { detectContext } from "./context.js";
import { attachSubagentToEvent, createSubagentSession } from "./subagent.js";
import { computeCost, loadPriceTable } from "./cost.js";
import { applyToolError, captureBreadcrumb } from "./errors.js";
import { serialize } from "./serialize.js";
import { CACHE_DIR, PID_FILE, PLUGIN_VERSION, } from "./plugin-meta.js";
const DEFAULT_PORT = 19877;
const FLUSH_INTERVAL_MS = 30_000;
const STALE_SESSION_IDLE_MS = 30 * 60_000;
/**
 * Pure predicate used by the reaper timer.
 * Exported so it can be unit-tested without running a real timer.
 */
/**
 * Merge hook-client-supplied dynamic context onto the session's autoTags.
 * Only writes fields that are non-empty so missing context (e.g. no tmux)
 * doesn't blank a previously-known value.
 */
export function applyClientContext(tags, ctx) {
    if (!ctx)
        return;
    if (ctx.session_name)
        tags["claude_code.session_name"] = ctx.session_name;
    if (ctx.parent_session_id)
        tags["claude_code.parent_session_id"] = ctx.parent_session_id;
    if (ctx.parent_agent_name)
        tags["claude_code.parent_agent_name"] = ctx.parent_agent_name;
    if (ctx.tmux_window)
        tags["claude_code.tmux.window"] = ctx.tmux_window;
    if (ctx.tmux_pane)
        tags["claude_code.tmux.pane"] = ctx.tmux_pane;
    if (ctx.terminal_program)
        tags["claude_code.terminal.program"] = ctx.terminal_program;
    if (ctx.terminal_session_id)
        tags["claude_code.terminal.session_id"] = ctx.terminal_session_id;
    if (ctx.username)
        tags["user.username"] = ctx.username;
    if (ctx.user_id)
        tags["user.id"] = ctx.user_id;
    if (ctx.cwd)
        tags["process.cwd"] = ctx.cwd;
}
export function isStaleSession(record, now, idleMs = STALE_SESSION_IDLE_MS) {
    return now - record.lastEventAt > idleMs;
}
function writePidFile(port, startedAt) {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        const data = {
            pid: process.pid,
            port,
            version: PLUGIN_VERSION,
            startedAt,
        };
        writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
    }
    catch {
        // ignore
    }
}
function removePidFile() {
    try {
        unlinkSync(PID_FILE);
    }
    catch { /* ignore */ }
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function send(res, status, body, contentType = "text/plain") {
    res.statusCode = status;
    res.setHeader("Content-Type", contentType);
    res.end(body);
}
export function startServer(sentry, config, baseAutoTags) {
    const sessions = new Map();
    const port = Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;
    const priceTable = loadPriceTable(null, config);
    const subagentSession = createSubagentSession();
    const handleSessionStart = async (event) => {
        if (sessions.has(event.session_id))
            return;
        const detected = await detectContext(event.session_id).catch(() => ({}));
        const autoTags = {
            ...baseAutoTags,
            ...detected,
            "claude_code.session_id": event.session_id,
        };
        // The collector inherits the env of *its* spawning process. On a long-
        // lived collector that env is stale (e.g. a tmux session that died days
        // ago) — every later session_id then inherits the same wrong session
        // name. The hook-client sends live values via event._aiobs.context;
        // those win.
        applyClientContext(autoTags, event._aiobs?.context);
        sessions.set(event.session_id, {
            currentTurnSpan: null,
            currentTurnStart: null,
            pendingTools: new Map(),
            toolCount: 0,
            turnToolCount: 0,
            turnSubagentCount: 0,
            turnTools: new Set(),
            transcriptPath: event.transcript_path,
            model: event.model,
            turnIndex: -1,
            autoTags,
            lastEventAt: Date.now(),
        });
    };
    const reapStaleSession = (sessionId, record) => {
        try {
            closeCurrentTurn(record);
        }
        catch { /* ignore */ }
        for (const [, pending] of record.pendingTools) {
            try {
                pending.span.end();
            }
            catch { /* ignore */ }
        }
        record.pendingTools.clear();
        sessions.delete(sessionId);
    };
    const closeCurrentTurn = (record) => {
        if (!record.currentTurnSpan)
            return;
        let tokens = {
            turnIndex: record.turnIndex,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            model: record.model ?? null,
            prompt: null,
            response: null,
        };
        if (record.transcriptPath) {
            const turns = extractPerTurnTokens(record.transcriptPath);
            const turn = turns[record.turnIndex];
            if (turn)
                tokens = turn;
        }
        if (tokens.model)
            record.responseModel = tokens.model;
        const cost = computeCost({
            model: tokens.model ?? record.responseModel ?? record.model ?? null,
            inputTokens: tokens.inputTokens,
            cachedInputTokens: tokens.cachedInputTokens,
            cacheCreationTokens: tokens.cacheCreationTokens,
            outputTokens: tokens.outputTokens,
        }, priceTable);
        closeTurnSpan(sentry, record.currentTurnSpan, {
            tokens,
            responseModel: record.responseModel ?? record.model,
            response: tokens.response,
            cost,
            turnStartTime: record.currentTurnStart ?? undefined,
            sessionId: record.autoTags["claude_code.session_id"],
            toolCount: record.turnToolCount,
            subagentCount: record.turnSubagentCount,
            toolsUsed: Array.from(record.turnTools),
        }, config);
        record.currentTurnSpan = null;
        record.currentTurnStart = null;
        record.turnToolCount = 0;
        record.turnSubagentCount = 0;
        record.turnTools.clear();
    };
    const handleUserPrompt = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        closeCurrentTurn(record);
        record.turnIndex += 1;
        const prompt = event.prompt ?? event.message ?? null;
        record.currentTurnStart = Date.now() / 1000;
        record.currentTurnSpan = openTurnTransaction(sentry, event.session_id, record.turnIndex, prompt, record.autoTags, config, record.model);
    };
    const handlePreTool = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        // Subagent tools can run for >30 min; keep the parent session fresh so the reaper
        // doesn't harvest it mid-flight. touchSession already bumped at the dispatcher,
        // but this is belt-and-suspenders in case the event shape ever loses session_id.
        record.lastEventAt = Date.now();
        const parent = record.currentTurnSpan;
        if (attachSubagentToEvent(sentry, subagentSession, event, {
            parent: parent ?? undefined,
            maxAttrLen: config.maxAttributeLength,
        })) {
            record.toolCount += 1;
            record.turnSubagentCount += 1;
            record.turnTools.add("Task");
            return;
        }
        const startedAt = Date.now();
        const span = createToolSpan(sentry, parent, event.tool_name, event.tool_input, config, undefined, event.tool_use_id);
        const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
        record.pendingTools.set(key, { span, startedAt, toolName: event.tool_name });
        record.toolCount += 1;
        record.turnToolCount += 1;
        record.turnTools.add(event.tool_name);
    };
    const handlePostTool = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        record.lastEventAt = Date.now();
        if (attachSubagentToEvent(sentry, subagentSession, event, {
            maxAttrLen: config.maxAttributeLength,
        })) {
            if (event.tool_error) {
                captureBreadcrumb(sentry, {
                    event,
                    session: {
                        sessionId: event.session_id,
                        sessionName: record.autoTags["claude_code.session_name"],
                    },
                });
            }
            return;
        }
        const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount - 1}`;
        const pending = record.pendingTools.get(key);
        if (!pending)
            return;
        const { span, startedAt } = pending;
        if (config.recordOutputs && event.tool_response !== undefined) {
            try {
                const sanitized = serialize(event.tool_response, config.maxAttributeLength);
                if (sanitized)
                    span.setAttribute("gen_ai.tool.output", sanitized);
            }
            catch {
                // ignore
            }
        }
        try {
            span.setAttribute("gen_ai.tool.duration_ms", Date.now() - startedAt);
        }
        catch { /* ignore */ }
        if (event.tool_error) {
            applyToolError(span, event);
            captureBreadcrumb(sentry, {
                event,
                session: {
                    sessionId: event.session_id,
                    sessionName: record.autoTags["claude_code.session_name"],
                },
            });
        }
        span.end();
        record.pendingTools.delete(key);
    };
    const handleSessionEnd = async (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        if (event.transcript_path && !record.transcriptPath) {
            record.transcriptPath = event.transcript_path;
        }
        closeCurrentTurn(record);
        for (const [, pending] of record.pendingTools) {
            try {
                pending.span.end();
            }
            catch { /* ignore */ }
        }
        record.pendingTools.clear();
        sessions.delete(event.session_id);
        try {
            await sentry.flush(5000);
        }
        catch { /* ignore */ }
    };
    const touchSession = (event) => {
        const sid = event.session_id;
        if (!sid)
            return;
        const r = sessions.get(sid);
        if (!r)
            return;
        r.lastEventAt = Date.now();
        // Refresh dynamic tags from every event — tmux sessions can be renamed
        // and parent linkage may only become known after the first hook fires.
        applyClientContext(r.autoTags, event._aiobs?.context);
    };
    async function handleEvent(event) {
        touchSession(event);
        switch (event.hook_event_name) {
            case "SessionStart":
                await handleSessionStart(event);
                return;
            case "UserPromptSubmit":
                handleUserPrompt(event);
                return;
            case "PreToolUse":
                handlePreTool(event);
                return;
            case "PostToolUse":
                handlePostTool(event);
                return;
            case "SessionEnd":
                await handleSessionEnd(event);
                return;
            case "Stop":
            case "PreCompact":
                return;
        }
    }
    const startedAt = Date.now();
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            const body = JSON.stringify({
                ok: true,
                pid: process.pid,
                port,
                version: PLUGIN_VERSION,
                startedAt,
                sessions: sessions.size,
                uid: process.getuid?.(),
            });
            send(res, 200, body, "application/json");
            return;
        }
        if (req.method === "GET" && req.url === "/version") {
            send(res, 200, JSON.stringify({ version: PLUGIN_VERSION }), "application/json");
            return;
        }
        if (req.method === "POST" && req.url === "/hook") {
            readBody(req)
                .then(async (body) => {
                let parsed;
                try {
                    parsed = JSON.parse(body);
                }
                catch {
                    send(res, 400, JSON.stringify({ error: "invalid_json" }), "application/json");
                    return;
                }
                const event = parsed;
                if (!event || typeof event.hook_event_name !== "string") {
                    send(res, 400, JSON.stringify({ error: "missing_hook_event_name" }), "application/json");
                    return;
                }
                try {
                    await handleEvent(event);
                    send(res, 200, "{}", "application/json");
                }
                catch (err) {
                    // Surface dispatch failures into the user's own Sentry project so
                    // "no traces showing up" is debuggable without local log files.
                    reportPluginError(sentry, err, {
                        hook_event_name: event.hook_event_name,
                        session_id: event.session_id,
                    });
                    send(res, 500, JSON.stringify({ error: err.message ?? "unknown" }), "application/json");
                }
            })
                .catch(() => send(res, 500, JSON.stringify({ error: "read_error" }), "application/json"));
            return;
        }
        send(res, 404, "not_found");
    });
    // Timers + PID file are installed only after we've successfully bound. Both
    // need cleanup on shutdown; tying them to the `listening` event keeps the
    // lifecycle symmetric and avoids a phantom PID file if listen fails.
    let flushTimer = null;
    let reapTimer = null;
    server.on("listening", () => {
        writePidFile(port, startedAt);
        flushTimer = setInterval(() => {
            try {
                void sentry.flush(2000);
            }
            catch { /* ignore */ }
        }, FLUSH_INTERVAL_MS);
        flushTimer.unref?.();
        reapTimer = setInterval(() => {
            const now = Date.now();
            for (const [sid, record] of sessions) {
                if (isStaleSession(record, now)) {
                    reapStaleSession(sid, record);
                }
            }
            try {
                void sentry.flush(2000);
            }
            catch { /* ignore */ }
        }, FLUSH_INTERVAL_MS);
        reapTimer.unref?.();
    });
    server.on("error", (err) => {
        process.stderr.write(`collector listen error: ${err.message}\n`);
        if (err.code === "EADDRINUSE") {
            // We never started listening, so no PID file was written — but call
            // removePidFile defensively in case a sibling's cleanup missed.
            removePidFile();
            process.exit(2);
        }
    });
    server.listen(port, "127.0.0.1");
    const shutdown = async () => {
        if (flushTimer)
            clearInterval(flushTimer);
        if (reapTimer)
            clearInterval(reapTimer);
        for (const [, record] of sessions) {
            try {
                closeCurrentTurn(record);
                for (const [, pending] of record.pendingTools) {
                    try {
                        pending.span.end();
                    }
                    catch { /* ignore */ }
                }
            }
            catch { /* ignore */ }
        }
        sessions.clear();
        removePidFile();
        try {
            await sentry.flush(5000);
        }
        catch { /* ignore */ }
        await new Promise((resolve) => server.close(() => resolve()));
    };
    const onSignal = () => {
        void shutdown().then(() => process.exit(0));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    return { close: shutdown };
}

import { createServer } from "node:http";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { reportPluginError } from "./sentry-errors.js";
import { closeTurnSpan, createToolSpan, openTurnTransaction, } from "./spans.js";
import { readTranscript, selectTurn } from "./transcript-reader.js";
import { detectContext } from "./context.js";
import { attachSubagentToEvent, createSubagentSession, findActiveSubagentSpan } from "./subagent.js";
import { computeCost, loadPriceTable } from "./cost.js";
import { applyToolError, captureBreadcrumb, captureDroppedBreadcrumb } from "./errors.js";
import { serialize } from "./serialize.js";
import { parseMcpTool, parseSkillInput, parseSlashCommand } from "./attribution.js";
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
    let droppedTotal = 0;
    const startedAt = Date.now();
    const port = Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;
    const priceTable = loadPriceTable(null, config);
    const subagentSession = createSubagentSession();
    const handleSessionStart = async (event) => {
        if (sessions.has(event.session_id))
            return;
        // C4: derive git/cwd from the session's own cwd (sent live by the
        // hook-client), never the long-lived collector's process.cwd().
        const sessionCwd = event._aiobs?.context?.cwd;
        const detected = await detectContext(event.session_id, sessionCwd).catch(() => ({}));
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
            currentTurnSpans: null,
            currentTurnStart: null,
            pendingTools: new Map(),
            toolCount: 0,
            turnToolCount: 0,
            turnSubagentCount: 0,
            turnTools: new Set(),
            transcriptPath: event.transcript_path,
            model: event.model,
            turnIndex: -1,
            currentPromptId: null,
            synthesized: false,
            autoTags,
            lastEventAt: Date.now(),
        });
    };
    const reapStaleSession = async (sessionId, record) => {
        await sentry.withIsolationScope(async (scope) => {
            scope.setConversationId(sessionId);
            try {
                await closeCurrentTurn(record);
            }
            catch { /* ignore */ }
            for (const [, pending] of record.pendingTools) {
                try {
                    pending.span.end();
                }
                catch { /* ignore */ }
            }
            record.pendingTools.clear();
        });
        sessions.delete(sessionId);
    };
    const closeCurrentTurn = async (record) => {
        if (!record.currentTurnSpans)
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
        let parseDegraded = false;
        let sessionDims = {};
        let tokenExtractionStatus = "transcript_missing";
        if (record.transcriptPath) {
            const result = readTranscript(record.transcriptPath);
            parseDegraded = result.degraded;
            sessionDims = result.session;
            // promptId is the primary key; record.turnIndex is the ordinal fallback —
            // it stays 1:1 with transcript-reader's real-turn index because each
            // UserPromptSubmit corresponds to exactly one real (non-sidechain,
            // non-tool_result) user line.
            const selected = selectTurn(result, record.currentPromptId, record.turnIndex);
            if (!selected.turn) {
                tokenExtractionStatus = "no_matching_turn";
            }
            else {
                tokens = selected.turn;
                if (tokens.inputTokens + tokens.outputTokens === 0) {
                    // Late-flush hypothesis: assistant usage may not yet be on disk.
                    // Sleep briefly and try once more.
                    await new Promise((r) => setTimeout(r, 200));
                    const retry = readTranscript(record.transcriptPath);
                    parseDegraded = retry.degraded;
                    sessionDims = retry.session;
                    const retrySelected = selectTurn(retry, record.currentPromptId, record.turnIndex);
                    if (retrySelected.turn && (retrySelected.turn.inputTokens + retrySelected.turn.outputTokens) > 0) {
                        tokens = retrySelected.turn;
                        tokenExtractionStatus = "ok|matched_after_retry";
                    }
                    else {
                        tokenExtractionStatus = "turn_had_no_usage";
                    }
                }
                else {
                    tokenExtractionStatus = "ok";
                }
            }
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
        try {
            if (cost.unpricedModel) {
                record.currentTurnSpans.agent.setAttribute("claude_code.cost.unpriced_model", cost.unpricedModel);
            }
            if (parseDegraded) {
                record.currentTurnSpans.agent.setAttribute("claude_code.transcript.parse_degraded", true);
            }
            if (record.synthesized) {
                record.currentTurnSpans.agent.setAttribute("claude_code.session.synthesized", true);
            }
            if (sessionDims.permissionMode) {
                record.currentTurnSpans.agent.setAttribute("claude_code.permission_mode", sessionDims.permissionMode);
            }
            if (sessionDims.agentName) {
                record.currentTurnSpans.agent.setAttribute("claude_code.agent_name", sessionDims.agentName);
            }
            if (sessionDims.entrypoint) {
                record.currentTurnSpans.agent.setAttribute("claude_code.entrypoint", sessionDims.entrypoint);
            }
        }
        catch { /* ignore */ }
        closeTurnSpan(sentry, record.currentTurnSpans, {
            tokens,
            responseModel: record.responseModel ?? record.model,
            response: tokens.response,
            cost,
            turnStartTime: record.currentTurnStart ?? undefined,
            sessionId: record.autoTags["claude_code.session_id"],
            toolCount: record.turnToolCount,
            subagentCount: record.turnSubagentCount,
            toolsUsed: Array.from(record.turnTools),
            tokenExtractionStatus,
        }, config);
        record.currentTurnSpans = null;
        record.currentTurnStart = null;
        record.currentPromptId = null;
        record.turnToolCount = 0;
        record.turnSubagentCount = 0;
        record.turnTools.clear();
    };
    // R2: SessionStart can be missed (collector spawned mid-session or the
    // event was dropped). Build a minimal record from the event so whole
    // turns aren't blacked out. Spans get claude_code.session.synthesized.
    // Note: a late SessionStart for an already-synthesized session is dropped
    // by handleSessionStart's `sessions.has` guard, so `synthesized` stays
    // true for its lifetime — accepted (data is degraded, never wrong; the
    // transcript still carries the model per turn).
    const getOrCreateSession = (event) => {
        const sid = event.session_id;
        const existing = sessions.get(sid);
        if (existing)
            return existing;
        const cwd = event._aiobs?.context?.cwd;
        const record = {
            currentTurnSpans: null,
            currentTurnStart: null,
            pendingTools: new Map(),
            toolCount: 0,
            turnToolCount: 0,
            turnSubagentCount: 0,
            turnTools: new Set(),
            // Only the 3 tool/prompt handlers call this; none carry
            // transcript_path. handleSessionEnd upgrades it later if it arrives.
            transcriptPath: undefined,
            model: undefined,
            turnIndex: -1,
            autoTags: {
                ...baseAutoTags,
                "claude_code.session_id": sid,
                ...(cwd ? { "process.cwd": cwd } : {}),
            },
            lastEventAt: Date.now(),
            currentPromptId: null,
            synthesized: true,
        };
        applyClientContext(record.autoTags, event._aiobs?.context);
        sessions.set(sid, record);
        return record;
    };
    const handleUserPrompt = (event) => {
        const record = getOrCreateSession(event);
        void closeCurrentTurn(record).then(() => {
            record.turnIndex += 1;
            record.currentPromptId = event.prompt_id ?? null;
            const prompt = event.prompt ?? event.message ?? null;
            record.currentTurnStart = Date.now() / 1000;
            record.currentTurnSpans = openTurnTransaction(sentry, event.session_id, record.turnIndex, prompt, record.autoTags, config, record.model);
            // R3: touchSession already counted droppedTotal + emitted the breadcrumb
            // for this event, but it ran before this turn's span existed (it saw the
            // prior/closed span or null). Re-stamp the just-opened turn span so the
            // loss is visible on the turn it actually precedes. No double count: only
            // the span attribute is repeated here, not droppedTotal/breadcrumb.
            const droppedNow = event._aiobs?.dropped_since_last;
            if (typeof droppedNow === "number" && droppedNow > 0 && record.currentTurnSpans) {
                try {
                    record.currentTurnSpans.agent.setAttribute("claude_code.dropped_since_last", droppedNow);
                }
                catch { /* ignore */ }
            }
            // N2: a slash command in the prompt → command attribution on the turn.
            if (prompt) {
                const cmd = parseSlashCommand(prompt);
                if (cmd && record.currentTurnSpans) {
                    try {
                        record.currentTurnSpans.agent.setAttribute("claude_code.command.name", cmd.name);
                        if (cmd.plugin) {
                            record.currentTurnSpans.agent.setAttribute("claude_code.command.plugin", cmd.plugin);
                        }
                    }
                    catch { /* ignore */ }
                }
            }
        }).catch(() => { });
    };
    const handlePreTool = (event) => {
        const record = getOrCreateSession(event);
        // Subagent tools can run for >30 min; keep the parent session fresh so the reaper
        // doesn't harvest it mid-flight. touchSession already bumped at the dispatcher,
        // but this is belt-and-suspenders in case the event shape ever loses session_id.
        record.lastEventAt = Date.now();
        const parent = record.currentTurnSpans?.agent ?? null;
        if (attachSubagentToEvent(sentry, subagentSession, event, {
            parent: parent ?? undefined,
            maxAttrLen: config.maxAttributeLength,
            parentTranscriptPath: record.transcriptPath,
        })) {
            record.toolCount += 1;
            record.turnSubagentCount += 1;
            record.turnTools.add("Task");
            return;
        }
        const startedAt = Date.now();
        // While a subagent is active in this session, nest its tool calls under
        // the wrapper span so the trace shows the subagent's tool work as
        // children of invoke_agent <subagent_type> rather than siblings on the
        // parent turn. Falls back to the turn span when no subagent is active.
        const toolParent = findActiveSubagentSpan(subagentSession, event.session_id) ?? parent;
        const span = createToolSpan(sentry, toolParent, event.tool_name, event.tool_input, config, undefined, event.tool_use_id, event.session_id);
        const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
        record.pendingTools.set(key, { span, startedAt, toolName: event.tool_name });
        record.toolCount += 1;
        record.turnToolCount += 1;
        record.turnTools.add(event.tool_name);
        // N1: MCP server attribution on every tool span.
        const mcp = parseMcpTool(event.tool_name);
        if (mcp) {
            try {
                span.setAttribute("gen_ai.tool.mcp.server", mcp.server);
                span.setAttribute("gen_ai.tool.mcp.name", mcp.name);
                span.setAttribute("claude_code.tool.source", "mcp");
            }
            catch { /* ignore */ }
        }
        // N2: Skill tool input → skill name/plugin on the tool span.
        if (event.tool_name === "Skill") {
            const skill = parseSkillInput(event.tool_input);
            if (skill) {
                try {
                    span.setAttribute("claude_code.skill.name", skill.name);
                    if (skill.plugin)
                        span.setAttribute("claude_code.skill.plugin", skill.plugin);
                }
                catch { /* ignore */ }
            }
        }
    };
    const handlePostTool = (event) => {
        const record = getOrCreateSession(event);
        record.lastEventAt = Date.now();
        if (attachSubagentToEvent(sentry, subagentSession, event, {
            maxAttrLen: config.maxAttributeLength,
            parentTranscriptPath: record.transcriptPath,
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
        await closeCurrentTurn(record);
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
        // R3: surface delivery loss the hook-client piggybacked on this event.
        // Sole site that counts droppedTotal + emits the breadcrumb (once per
        // event). currentTurnSpan here is the prior/open turn; handleUserPrompt
        // additionally re-stamps the newly opened turn span (attribute only).
        const dropped = event._aiobs?.dropped_since_last;
        if (typeof dropped === "number" && dropped > 0) {
            droppedTotal += dropped;
            if (r.currentTurnSpans) {
                try {
                    r.currentTurnSpans.agent.setAttribute("claude_code.dropped_since_last", dropped);
                }
                catch { /* ignore */ }
            }
            captureDroppedBreadcrumb(sentry, {
                dropped,
                session: {
                    sessionId: sid,
                    sessionName: r.autoTags["claude_code.session_name"],
                },
            });
        }
    };
    async function handleEvent(event) {
        touchSession(event);
        await sentry.withIsolationScope(async (scope) => {
            if (event.session_id)
                scope.setConversationId(event.session_id);
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
        });
    }
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
    const emitHeartbeat = () => {
        try {
            const span = sentry.startInactiveSpan({
                op: "claude_code.collector.heartbeat",
                name: "collector heartbeat",
                forceTransaction: true,
                attributes: {
                    "claude_code.collector.heartbeat": true,
                    "claude_code.collector.sessions_active": sessions.size,
                    "claude_code.collector.uptime_s": Math.floor((Date.now() - startedAt) / 1000),
                    "claude_code.collector.version": PLUGIN_VERSION,
                    "claude_code.collector.dropped_total": droppedTotal,
                },
            });
            span.end();
        }
        catch { /* ignore */ }
    };
    server.on("listening", () => {
        writePidFile(port, startedAt);
        flushTimer = setInterval(() => {
            emitHeartbeat();
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
                    void reapStaleSession(sid, record).catch(() => { });
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
            // Re-throw so Node's default uncaughtException behavior terminates the
            // process with a non-zero exit code and the original EADDRINUSE message.
            // Previously this was process.exit(2), which under vitest gets
            // re-thrown as a generic "process.exit unexpectedly called" error and
            // captured by our installGlobalHandlers as a Sentry issue
            // (CLAUDE-CODE-1 / DEV2-2). Throwing preserves the real error context
            // and avoids the test-pollution loop.
            throw err;
        }
    });
    server.listen(port, "127.0.0.1");
    const shutdown = async () => {
        if (flushTimer)
            clearInterval(flushTimer);
        if (reapTimer)
            clearInterval(reapTimer);
        for (const [sid, record] of sessions) {
            try {
                await sentry.withIsolationScope(async (scope) => {
                    scope.setConversationId(sid);
                    await closeCurrentTurn(record);
                    for (const [, pending] of record.pendingTools) {
                        try {
                            pending.span.end();
                        }
                        catch { /* ignore */ }
                    }
                });
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
    const forceReap = async () => {
        const pending = [];
        for (const [sid, record] of sessions) {
            pending.push(reapStaleSession(sid, record));
        }
        await Promise.all(pending);
    };
    return { close: shutdown, emitHeartbeat, forceReap };
}

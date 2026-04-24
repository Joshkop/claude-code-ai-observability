import { createServer } from "node:http";
import { closeTurnSpan, createRootSpan, createToolSpan, openTurnSpan, } from "./spans.js";
import { extractPerTurnTokens, extractTotals } from "./transcript.js";
import { detectContext } from "./context.js";
import { attachSubagentToEvent, createSubagentSession } from "./subagent.js";
import { computeCost, loadPriceTable } from "./cost.js";
import { applyToolError, captureBreadcrumb } from "./errors.js";
import { serialize } from "./serialize.js";
const DEFAULT_PORT = 19877;
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
        const rootSpan = createRootSpan(sentry, event.session_id, autoTags, config, event.model);
        sessions.set(event.session_id, {
            rootSpan,
            currentTurnSpan: null,
            pendingTools: new Map(),
            toolCount: 0,
            transcriptPath: event.transcript_path,
            model: event.model,
            turnIndex: -1,
            autoTags,
        });
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
        closeTurnSpan(record.currentTurnSpan, {
            tokens,
            responseModel: record.responseModel ?? record.model,
            response: tokens.response,
            cost,
        }, config);
        record.currentTurnSpan = null;
    };
    const handleUserPrompt = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        closeCurrentTurn(record);
        record.turnIndex += 1;
        const prompt = event.prompt ?? event.message ?? null;
        record.currentTurnSpan = openTurnSpan(sentry, record.rootSpan, prompt, record.autoTags, config, record.model);
    };
    const handlePreTool = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
        const parent = record.currentTurnSpan ?? record.rootSpan;
        if (attachSubagentToEvent(sentry, subagentSession, event, {
            parent,
            maxAttrLen: config.maxAttributeLength,
        })) {
            record.toolCount += 1;
            return;
        }
        const span = createToolSpan(sentry, parent, event.tool_name, event.tool_input, config);
        const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
        record.pendingTools.set(key, span);
        record.toolCount += 1;
    };
    const handlePostTool = (event) => {
        const record = sessions.get(event.session_id);
        if (!record)
            return;
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
        const span = record.pendingTools.get(key);
        if (!span)
            return;
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
        closeCurrentTurn(record);
        for (const [, span] of record.pendingTools) {
            try {
                span.end();
            }
            catch { /* ignore */ }
        }
        record.pendingTools.clear();
        record.rootSpan.setAttribute("gen_ai.tool.call_count", record.toolCount);
        const transcriptPath = event.transcript_path ?? record.transcriptPath;
        if (transcriptPath) {
            const turns = extractPerTurnTokens(transcriptPath);
            const totals = extractTotals(turns);
            record.rootSpan.setAttribute("gen_ai.usage.input_tokens", totals.inputTokens);
            record.rootSpan.setAttribute("gen_ai.usage.output_tokens", totals.outputTokens);
            record.rootSpan.setAttribute("gen_ai.usage.total_tokens", totals.totalTokens);
            record.rootSpan.setAttribute("gen_ai.usage.input_tokens.cached", totals.cachedInputTokens);
            record.rootSpan.setAttribute("claude_code.turn_count", turns.length);
            const lastModel = [...turns].reverse().find((t) => t.model)?.model;
            if (lastModel)
                record.rootSpan.setAttribute("gen_ai.response.model", lastModel);
            const totalsCost = computeCost({
                model: lastModel ?? record.responseModel ?? record.model ?? null,
                inputTokens: totals.inputTokens,
                cachedInputTokens: totals.cachedInputTokens,
                cacheCreationTokens: totals.cacheCreationTokens,
                outputTokens: totals.outputTokens,
            }, priceTable);
            record.rootSpan.setAttribute("gen_ai.usage.cost.input_tokens", totalsCost.inputCost);
            record.rootSpan.setAttribute("gen_ai.usage.cost.output_tokens", totalsCost.outputCost);
            record.rootSpan.setAttribute("gen_ai.usage.cost.total_tokens", totalsCost.totalCost);
        }
        record.rootSpan.end();
        sessions.delete(event.session_id);
        try {
            await sentry.flush(5000);
        }
        catch { /* ignore */ }
    };
    async function handleEvent(event) {
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
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            send(res, 200, "ok");
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
                    send(res, 500, JSON.stringify({ error: err.message ?? "unknown" }), "application/json");
                }
            })
                .catch(() => send(res, 500, JSON.stringify({ error: "read_error" }), "application/json"));
            return;
        }
        send(res, 404, "not_found");
    });
    server.listen(port, "127.0.0.1");
    const shutdown = async () => {
        for (const [, record] of sessions) {
            try {
                closeCurrentTurn(record);
                for (const [, span] of record.pendingTools) {
                    try {
                        span.end();
                    }
                    catch { /* ignore */ }
                }
                record.rootSpan.end();
            }
            catch { /* ignore */ }
        }
        sessions.clear();
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

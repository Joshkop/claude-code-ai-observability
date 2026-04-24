import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type * as Sentry from "@sentry/node";
import type {
  AutoTags,
  HookEvent,
  PostToolUseEvent,
  PreToolUseEvent,
  ResolvedPluginConfig,
  SessionEndEvent,
  SessionStartEvent,
  UserPromptSubmitEvent,
} from "./types.js";
import {
  closeTurnSpan,
  createRootSpan,
  createToolSpan,
  openTurnSpan,
  type CloseTurnInput,
} from "./spans.js";
import { extractPerTurnTokens, extractTotals } from "./transcript.js";
import { detectContext } from "./context.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

interface SessionRecord {
  rootSpan: Span;
  currentTurnSpan: Span | null;
  pendingTools: Map<string, Span>;
  toolCount: number;
  transcriptPath?: string;
  model?: string;
  responseModel?: string;
  turnIndex: number;
  autoTags: AutoTags;
}

const DEFAULT_PORT = 19876;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(body);
}

export function startServer(
  sentry: typeof Sentry,
  config: ResolvedPluginConfig,
  baseAutoTags: AutoTags,
): { close: () => Promise<void> } {
  const sessions = new Map<string, SessionRecord>();
  const port = Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;

  const handleSessionStart = async (event: SessionStartEvent): Promise<void> => {
    if (sessions.has(event.session_id)) return;
    const detected = await detectContext(event.session_id).catch(() => ({} as AutoTags));
    const autoTags: AutoTags = {
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

  const closeCurrentTurn = (record: SessionRecord): void => {
    if (!record.currentTurnSpan) return;
    let tokens: CloseTurnInput["tokens"] = {
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
      if (turn) tokens = turn;
    }
    if (tokens.model) record.responseModel = tokens.model;
    closeTurnSpan(
      record.currentTurnSpan,
      { tokens, responseModel: record.responseModel ?? record.model, response: tokens.response },
      config,
    );
    record.currentTurnSpan = null;
  };

  const handleUserPrompt = (event: UserPromptSubmitEvent): void => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    closeCurrentTurn(record);
    record.turnIndex += 1;
    const prompt = event.prompt ?? event.message ?? null;
    record.currentTurnSpan = openTurnSpan(
      sentry,
      record.rootSpan,
      prompt,
      record.autoTags,
      config,
      record.model,
    );
  };

  const handlePreTool = (event: PreToolUseEvent): void => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    const parent = record.currentTurnSpan ?? record.rootSpan;
    const span = createToolSpan(sentry, parent, event.tool_name, event.tool_input, config);
    const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
    record.pendingTools.set(key, span);
    record.toolCount += 1;
  };

  const handlePostTool = (event: PostToolUseEvent): void => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount - 1}`;
    const span = record.pendingTools.get(key);
    if (!span) return;
    if (config.recordOutputs && event.tool_response !== undefined) {
      try {
        const text = typeof event.tool_response === "string"
          ? event.tool_response
          : JSON.stringify(event.tool_response);
        if (text) {
          span.setAttribute(
            "gen_ai.tool.output",
            text.length > config.maxAttributeLength
              ? `${text.slice(0, config.maxAttributeLength)}...[truncated]`
              : text,
          );
        }
      } catch {
        // ignore
      }
    }
    if (event.tool_error) {
      span.setStatus({ code: 2, message: "tool_error" });
      span.setAttribute("error", true);
    }
    span.end();
    record.pendingTools.delete(key);
  };

  const handleSessionEnd = async (event: SessionEndEvent): Promise<void> => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    closeCurrentTurn(record);
    for (const [, span] of record.pendingTools) {
      try { span.end(); } catch { /* ignore */ }
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
      if (lastModel) record.rootSpan.setAttribute("gen_ai.response.model", lastModel);
    }
    record.rootSpan.end();
    sessions.delete(event.session_id);
    try { await sentry.flush(5000); } catch { /* ignore */ }
  };

  async function handleEvent(event: HookEvent): Promise<void> {
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            send(res, 400, JSON.stringify({ error: "invalid_json" }), "application/json");
            return;
          }
          const event = parsed as { hook_event_name?: string } & HookEvent;
          if (!event || typeof event.hook_event_name !== "string") {
            send(res, 400, JSON.stringify({ error: "missing_hook_event_name" }), "application/json");
            return;
          }
          try {
            await handleEvent(event);
            send(res, 200, "{}", "application/json");
          } catch (err) {
            send(
              res,
              500,
              JSON.stringify({ error: (err as Error).message ?? "unknown" }),
              "application/json",
            );
          }
        })
        .catch(() => send(res, 500, JSON.stringify({ error: "read_error" }), "application/json"));
      return;
    }
    send(res, 404, "not_found");
  });

  server.listen(port, "127.0.0.1");

  const shutdown = async (): Promise<void> => {
    for (const [, record] of sessions) {
      try {
        closeCurrentTurn(record);
        for (const [, span] of record.pendingTools) {
          try { span.end(); } catch { /* ignore */ }
        }
        record.rootSpan.end();
      } catch { /* ignore */ }
    }
    sessions.clear();
    try { await sentry.flush(5000); } catch { /* ignore */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const onSignal = (): void => {
    void shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return { close: shutdown };
}

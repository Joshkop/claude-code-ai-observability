import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  createToolSpan,
  openTurnTransaction,
  type CloseTurnInput,
} from "./spans.js";
import { extractPerTurnTokens } from "./transcript.js";
import { detectContext } from "./context.js";
import { attachSubagentToEvent, createSubagentSession } from "./subagent.js";
import { computeCost, loadPriceTable } from "./cost.js";
import { applyToolError, captureBreadcrumb } from "./errors.js";
import { serialize } from "./serialize.js";
import {
  CACHE_DIR,
  PID_FILE,
  PLUGIN_VERSION,
  type CollectorPidFile,
} from "./plugin-meta.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

interface SessionRecord {
  currentTurnSpan: Span | null;
  pendingTools: Map<string, Span>;
  toolCount: number;
  transcriptPath?: string;
  model?: string;
  responseModel?: string;
  turnIndex: number;
  autoTags: AutoTags;
  lastEventAt: number;
}

const DEFAULT_PORT = 19877;
const FLUSH_INTERVAL_MS = 30_000;
const STALE_SESSION_IDLE_MS = 30 * 60_000;

function writePidFile(port: number, startedAt: number): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const data: CollectorPidFile = {
      pid: process.pid,
      port,
      version: PLUGIN_VERSION,
      startedAt,
    };
    writeFileSync(PID_FILE, JSON.stringify(data, null, 2));
  } catch {
    // ignore
  }
}

function removePidFile(): void {
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

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
  const priceTable = loadPriceTable(null, config);
  const subagentSession = createSubagentSession();

  const handleSessionStart = async (event: SessionStartEvent): Promise<void> => {
    if (sessions.has(event.session_id)) return;
    const detected = await detectContext(event.session_id).catch(() => ({} as AutoTags));
    const autoTags: AutoTags = {
      ...baseAutoTags,
      ...detected,
      "claude_code.session_id": event.session_id,
    };
    sessions.set(event.session_id, {
      currentTurnSpan: null,
      pendingTools: new Map(),
      toolCount: 0,
      transcriptPath: event.transcript_path,
      model: event.model,
      turnIndex: -1,
      autoTags,
      lastEventAt: Date.now(),
    });
  };

  const reapStaleSession = (sessionId: string, record: SessionRecord): void => {
    try { closeCurrentTurn(record); } catch { /* ignore */ }
    for (const [, span] of record.pendingTools) {
      try { span.end(); } catch { /* ignore */ }
    }
    record.pendingTools.clear();
    sessions.delete(sessionId);
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
    const cost = computeCost(
      {
        model: tokens.model ?? record.responseModel ?? record.model ?? null,
        inputTokens: tokens.inputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        outputTokens: tokens.outputTokens,
      },
      priceTable,
    );
    closeTurnSpan(
      record.currentTurnSpan,
      {
        tokens,
        responseModel: record.responseModel ?? record.model,
        response: tokens.response,
        cost,
      },
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
    record.currentTurnSpan = openTurnTransaction(
      sentry,
      event.session_id,
      record.turnIndex,
      prompt,
      record.autoTags,
      config,
      record.model,
    );
  };

  const handlePreTool = (event: PreToolUseEvent): void => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    const parent = record.currentTurnSpan;
    if (
      attachSubagentToEvent(sentry, subagentSession, event, {
        parent: parent ?? undefined,
        maxAttrLen: config.maxAttributeLength,
      })
    ) {
      record.toolCount += 1;
      return;
    }
    const span = createToolSpan(sentry, parent, event.tool_name, event.tool_input, config);
    const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
    record.pendingTools.set(key, span);
    record.toolCount += 1;
  };

  const handlePostTool = (event: PostToolUseEvent): void => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    if (
      attachSubagentToEvent(sentry, subagentSession, event, {
        maxAttrLen: config.maxAttributeLength,
      })
    ) {
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
    if (!span) return;
    if (config.recordOutputs && event.tool_response !== undefined) {
      try {
        const sanitized = serialize(event.tool_response, config.maxAttributeLength);
        if (sanitized) span.setAttribute("gen_ai.tool.output", sanitized);
      } catch {
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

  const handleSessionEnd = async (event: SessionEndEvent): Promise<void> => {
    const record = sessions.get(event.session_id);
    if (!record) return;
    if (event.transcript_path && !record.transcriptPath) {
      record.transcriptPath = event.transcript_path;
    }
    closeCurrentTurn(record);
    for (const [, span] of record.pendingTools) {
      try { span.end(); } catch { /* ignore */ }
    }
    record.pendingTools.clear();
    sessions.delete(event.session_id);
    try { await sentry.flush(5000); } catch { /* ignore */ }
  };

  const touchSession = (event: HookEvent): void => {
    const sid = (event as { session_id?: string }).session_id;
    if (!sid) return;
    const r = sessions.get(sid);
    if (r) r.lastEventAt = Date.now();
  };

  async function handleEvent(event: HookEvent): Promise<void> {
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

  server.on("listening", () => {
    writePidFile(port, startedAt);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(`collector listen error: ${err.message}\n`);
    if (err.code === "EADDRINUSE") {
      process.exit(2);
    }
  });

  server.listen(port, "127.0.0.1");

  const flushTimer: NodeJS.Timeout = setInterval(() => {
    try { void sentry.flush(2000); } catch { /* ignore */ }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();

  const reapTimer: NodeJS.Timeout = setInterval(() => {
    const now = Date.now();
    for (const [sid, record] of sessions) {
      if (now - record.lastEventAt > STALE_SESSION_IDLE_MS) {
        reapStaleSession(sid, record);
      }
    }
    try { void sentry.flush(2000); } catch { /* ignore */ }
  }, FLUSH_INTERVAL_MS);
  reapTimer.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(flushTimer);
    clearInterval(reapTimer);
    for (const [, record] of sessions) {
      try {
        closeCurrentTurn(record);
        for (const [, span] of record.pendingTools) {
          try { span.end(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    sessions.clear();
    removePidFile();
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

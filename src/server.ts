import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type * as Sentry from "@sentry/node";
import type {
  AiobsClientContext,
  AutoTags,
  HookEvent,
  PostToolUseEvent,
  PreToolUseEvent,
  ResolvedPluginConfig,
  SessionEndEvent,
  SessionStartEvent,
  UserPromptSubmitEvent,
} from "./types.js";
import { reportPluginError } from "./sentry-errors.js";
import {
  closeTurnSpan,
  createToolSpan,
  openTurnTransaction,
  type CloseTurnInput,
} from "./spans.js";
import { readTranscript, selectTurn } from "./transcript-reader.js";
import { detectContext } from "./context.js";
import { attachSubagentToEvent, createSubagentSession, findActiveSubagentSpan } from "./subagent.js";
import { computeCost, loadPriceTable } from "./cost.js";
import { applyToolError, captureBreadcrumb, captureDroppedBreadcrumb } from "./errors.js";
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
  /** Unix-seconds start time of the current turn — used as the gen_ai.chat
   *  child span's startTime so it covers the same window as the parent. */
  currentTurnStart: number | null;
  pendingTools: Map<string, { span: Span; startedAt: number; toolName: string }>;
  toolCount: number;
  /** Per-turn tool / subagent counters and tool-name set. Reset on new turn. */
  turnToolCount: number;
  turnSubagentCount: number;
  turnTools: Set<string>;
  transcriptPath?: string;
  model?: string;
  responseModel?: string;
  turnIndex: number;
  /** C1: promptId of the currently-open turn, from UserPromptSubmit. */
  currentPromptId: string | null;
  /** R2: true when this record was synthesized (SessionStart missed). */
  synthesized: boolean;
  autoTags: AutoTags;
  lastEventAt: number;
}

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
export function applyClientContext(
  tags: AutoTags,
  ctx: AiobsClientContext | undefined,
): void {
  if (!ctx) return;
  if (ctx.session_name) tags["claude_code.session_name"] = ctx.session_name;
  if (ctx.parent_session_id) tags["claude_code.parent_session_id"] = ctx.parent_session_id;
  if (ctx.parent_agent_name) tags["claude_code.parent_agent_name"] = ctx.parent_agent_name;
  if (ctx.tmux_window) tags["claude_code.tmux.window"] = ctx.tmux_window;
  if (ctx.tmux_pane) tags["claude_code.tmux.pane"] = ctx.tmux_pane;
  if (ctx.terminal_program) tags["claude_code.terminal.program"] = ctx.terminal_program;
  if (ctx.terminal_session_id) tags["claude_code.terminal.session_id"] = ctx.terminal_session_id;
  if (ctx.username) tags["user.username"] = ctx.username;
  if (ctx.user_id) tags["user.id"] = ctx.user_id;
  if (ctx.cwd) tags["process.cwd"] = ctx.cwd;
}

export function isStaleSession(
  record: { lastEventAt: number },
  now: number,
  idleMs: number = STALE_SESSION_IDLE_MS,
): boolean {
  return now - record.lastEventAt > idleMs;
}

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
): { close: () => Promise<void>; emitHeartbeat: () => void } {
  const sessions = new Map<string, SessionRecord>();
  let droppedTotal = 0;
  const startedAt = Date.now();
  const port = Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;
  const priceTable = loadPriceTable(null, config);
  const subagentSession = createSubagentSession();

  const handleSessionStart = async (event: SessionStartEvent): Promise<void> => {
    if (sessions.has(event.session_id)) return;
    // C4: derive git/cwd from the session's own cwd (sent live by the
    // hook-client), never the long-lived collector's process.cwd().
    const sessionCwd = event._aiobs?.context?.cwd;
    const detected = await detectContext(event.session_id, sessionCwd).catch(
      () => ({} as AutoTags),
    );
    const autoTags: AutoTags = {
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
      currentPromptId: null,
      synthesized: false,
      autoTags,
      lastEventAt: Date.now(),
    });
  };

  const reapStaleSession = (sessionId: string, record: SessionRecord): void => {
    try { closeCurrentTurn(record); } catch { /* ignore */ }
    for (const [, pending] of record.pendingTools) {
      try { pending.span.end(); } catch { /* ignore */ }
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
    let parseDegraded = false;
    let sessionDims: { permissionMode?: string; agentName?: string; entrypoint?: string } = {};
    if (record.transcriptPath) {
      const result = readTranscript(record.transcriptPath);
      parseDegraded = result.degraded;
      sessionDims = result.session;
      // promptId is the primary key; record.turnIndex is the ordinal fallback —
      // it stays 1:1 with transcript-reader's real-turn index because each
      // UserPromptSubmit corresponds to exactly one real (non-sidechain,
      // non-tool_result) user line.
      const turn = selectTurn(result, record.currentPromptId, record.turnIndex);
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
    try {
      if (cost.unpricedModel) {
        record.currentTurnSpan.setAttribute("claude_code.cost.unpriced_model", cost.unpricedModel);
      }
      if (parseDegraded) {
        record.currentTurnSpan.setAttribute("claude_code.transcript.parse_degraded", true);
      }
      if (record.synthesized) {
        record.currentTurnSpan.setAttribute("claude_code.session.synthesized", true);
      }
      if (sessionDims.permissionMode) {
        record.currentTurnSpan.setAttribute("claude_code.permission_mode", sessionDims.permissionMode);
      }
      if (sessionDims.agentName) {
        record.currentTurnSpan.setAttribute("claude_code.agent_name", sessionDims.agentName);
      }
      if (sessionDims.entrypoint) {
        record.currentTurnSpan.setAttribute("claude_code.entrypoint", sessionDims.entrypoint);
      }
    } catch { /* ignore */ }
    closeTurnSpan(
      sentry,
      record.currentTurnSpan,
      {
        tokens,
        responseModel: record.responseModel ?? record.model,
        response: tokens.response,
        cost,
        turnStartTime: record.currentTurnStart ?? undefined,
        sessionId: record.autoTags["claude_code.session_id"],
        toolCount: record.turnToolCount,
        subagentCount: record.turnSubagentCount,
        toolsUsed: Array.from(record.turnTools),
      },
      config,
    );
    record.currentTurnSpan = null;
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
  const getOrCreateSession = (event: HookEvent): SessionRecord => {
    const sid = event.session_id;
    const existing = sessions.get(sid);
    if (existing) return existing;
    const cwd = event._aiobs?.context?.cwd;
    const record: SessionRecord = {
      currentTurnSpan: null,
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

  const handleUserPrompt = (event: UserPromptSubmitEvent): void => {
    const record = getOrCreateSession(event);
    closeCurrentTurn(record);
    record.turnIndex += 1;
    record.currentPromptId = event.prompt_id ?? null;
    const prompt = event.prompt ?? event.message ?? null;
    record.currentTurnStart = Date.now() / 1000;
    record.currentTurnSpan = openTurnTransaction(
      sentry,
      event.session_id,
      record.turnIndex,
      prompt,
      record.autoTags,
      config,
      record.model,
    );
    // R3: touchSession already counted droppedTotal + emitted the breadcrumb
    // for this event, but it ran before this turn's span existed (it saw the
    // prior/closed span or null). Re-stamp the just-opened turn span so the
    // loss is visible on the turn it actually precedes. No double count: only
    // the span attribute is repeated here, not droppedTotal/breadcrumb.
    const droppedNow = event._aiobs?.dropped_since_last;
    if (typeof droppedNow === "number" && droppedNow > 0 && record.currentTurnSpan) {
      try {
        record.currentTurnSpan.setAttribute("claude_code.dropped_since_last", droppedNow);
      } catch { /* ignore */ }
    }
  };

  const handlePreTool = (event: PreToolUseEvent): void => {
    const record = getOrCreateSession(event);
    // Subagent tools can run for >30 min; keep the parent session fresh so the reaper
    // doesn't harvest it mid-flight. touchSession already bumped at the dispatcher,
    // but this is belt-and-suspenders in case the event shape ever loses session_id.
    record.lastEventAt = Date.now();
    const parent = record.currentTurnSpan;
    if (
      attachSubagentToEvent(sentry, subagentSession, event, {
        parent: parent ?? undefined,
        maxAttrLen: config.maxAttributeLength,
        parentTranscriptPath: record.transcriptPath,
      })
    ) {
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
    const span = createToolSpan(
      sentry,
      toolParent,
      event.tool_name,
      event.tool_input,
      config,
      undefined,
      event.tool_use_id,
    );
    const key = event.tool_use_id ?? `${event.tool_name}:${record.toolCount}`;
    record.pendingTools.set(key, { span, startedAt, toolName: event.tool_name });
    record.toolCount += 1;
    record.turnToolCount += 1;
    record.turnTools.add(event.tool_name);
  };

  const handlePostTool = (event: PostToolUseEvent): void => {
    const record = getOrCreateSession(event);
    record.lastEventAt = Date.now();
    if (
      attachSubagentToEvent(sentry, subagentSession, event, {
        maxAttrLen: config.maxAttributeLength,
        parentTranscriptPath: record.transcriptPath,
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
    const pending = record.pendingTools.get(key);
    if (!pending) return;
    const { span, startedAt } = pending;
    if (config.recordOutputs && event.tool_response !== undefined) {
      try {
        const sanitized = serialize(event.tool_response, config.maxAttributeLength);
        if (sanitized) span.setAttribute("gen_ai.tool.output", sanitized);
      } catch {
        // ignore
      }
    }
    try {
      span.setAttribute("gen_ai.tool.duration_ms", Date.now() - startedAt);
    } catch { /* ignore */ }
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
    for (const [, pending] of record.pendingTools) {
      try { pending.span.end(); } catch { /* ignore */ }
    }
    record.pendingTools.clear();
    sessions.delete(event.session_id);
    try { await sentry.flush(5000); } catch { /* ignore */ }
  };

  const touchSession = (event: HookEvent): void => {
    const sid = (event as { session_id?: string }).session_id;
    if (!sid) return;
    const r = sessions.get(sid);
    if (!r) return;
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
      if (r.currentTurnSpan) {
        try {
          r.currentTurnSpan.setAttribute("claude_code.dropped_since_last", dropped);
        } catch { /* ignore */ }
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
            // Surface dispatch failures into the user's own Sentry project so
            // "no traces showing up" is debuggable without local log files.
            reportPluginError(sentry, err, {
              hook_event_name: event.hook_event_name,
              session_id: (event as { session_id?: string }).session_id,
            });
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

  // Timers + PID file are installed only after we've successfully bound. Both
  // need cleanup on shutdown; tying them to the `listening` event keeps the
  // lifecycle symmetric and avoids a phantom PID file if listen fails.
  let flushTimer: NodeJS.Timeout | null = null;
  let reapTimer: NodeJS.Timeout | null = null;

  const emitHeartbeat = (): void => {
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
    } catch { /* ignore */ }
  };

  server.on("listening", () => {
    writePidFile(port, startedAt);
    flushTimer = setInterval(() => {
      emitHeartbeat();
      try { void sentry.flush(2000); } catch { /* ignore */ }
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();

    reapTimer = setInterval(() => {
      const now = Date.now();
      for (const [sid, record] of sessions) {
        if (isStaleSession(record, now)) {
          reapStaleSession(sid, record);
        }
      }
      try { void sentry.flush(2000); } catch { /* ignore */ }
    }, FLUSH_INTERVAL_MS);
    reapTimer.unref?.();
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(`collector listen error: ${err.message}\n`);
    if (err.code === "EADDRINUSE") {
      // We never started listening, so no PID file was written — but call
      // removePidFile defensively in case a sibling's cleanup missed.
      removePidFile();
      process.exit(2);
    }
  });

  server.listen(port, "127.0.0.1");

  const shutdown = async (): Promise<void> => {
    if (flushTimer) clearInterval(flushTimer);
    if (reapTimer) clearInterval(reapTimer);
    for (const [, record] of sessions) {
      try {
        closeCurrentTurn(record);
        for (const [, pending] of record.pendingTools) {
          try { pending.span.end(); } catch { /* ignore */ }
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

  return { close: shutdown, emitHeartbeat };
}

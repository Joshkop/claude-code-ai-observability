import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startServer } from "../src/server.js";
import type { AutoTags, ResolvedPluginConfig } from "../src/types.js";

interface FakeSpan {
  attrs: Record<string, unknown>;
  ended: boolean;
  op?: string;
  name?: string;
  forceTransaction?: boolean;
}

function makeFakeSentry() {
  const spans: FakeSpan[] = [];
  return {
    spans,
    startInactiveSpan(opts: {
      op?: string;
      name?: string;
      attributes?: Record<string, unknown>;
      forceTransaction?: boolean;
    }) {
      const span: FakeSpan = {
        attrs: { ...(opts.attributes ?? {}) },
        ended: false,
        op: opts.op,
        name: opts.name,
        forceTransaction: opts.forceTransaction,
      };
      spans.push(span);
      return {
        setAttribute(k: string, v: unknown) { span.attrs[k] = v; },
        setStatus() {},
        end() { span.ended = true; },
      };
    },
    withActiveSpan<T>(_parent: unknown, fn: () => T): T {
      return fn();
    },
    flush: async () => true,
  };
}

const baseConfig: ResolvedPluginConfig = {
  dsn: "https://key@sentry.io/1",
  tracesSampleRate: 1,
  debug: false,
  recordInputs: false,
  recordOutputs: false,
  maxAttributeLength: 12000,
  tags: {},
};

const baseTags: AutoTags = {
  "host.name": "testhost",
  "os.type": "linux",
};

async function postHook(port: number, payload: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("no port"));
      }
    });
    srv.on("error", reject);
  });
}

describe("server lifecycle: per-turn transaction model", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    close = server.close;
    // wait for listen
    for (let i = 0; i < 25; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
  });

  it("creates one transaction per turn and ends previous on next UserPromptSubmit", async () => {
    const sessionId = "sess-lifecycle-1";

    // SessionStart -> no span
    let r = await postHook(port, { hook_event_name: "SessionStart", session_id: sessionId });
    expect(r.ok).toBe(true);
    expect(sentry.spans).toHaveLength(0);

    // UserPromptSubmit #1 -> one root transaction started
    r = await postHook(port, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt: "first prompt",
    });
    expect(r.ok).toBe(true);
    const turnTransactions = () =>
      sentry.spans.filter((s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true);
    expect(turnTransactions()).toHaveLength(1);
    expect(turnTransactions()[0].attrs["claude_code.turn_index"]).toBe(0);
    expect(turnTransactions()[0].attrs["claude_code.session_id"]).toBe(sessionId);
    expect(turnTransactions()[0].ended).toBe(false);

    // PreToolUse -> child tool span under turn #1
    r = await postHook(port, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_input: { command: "ls" },
    });
    expect(r.ok).toBe(true);
    const toolSpans = () => sentry.spans.filter((s) => s.op === "gen_ai.execute_tool");
    expect(toolSpans()).toHaveLength(1);
    expect(toolSpans()[0].ended).toBe(false);
    // Tool span is NOT a forced transaction (it has a parent)
    expect(toolSpans()[0].forceTransaction).toBeUndefined();

    // PostToolUse -> tool span ended, turn still open
    r = await postHook(port, {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_response: "ok",
      tool_error: false,
    });
    expect(r.ok).toBe(true);
    expect(toolSpans()[0].ended).toBe(true);
    expect(turnTransactions()[0].ended).toBe(false);

    // UserPromptSubmit #2 -> turn #1 ended, turn #2 started
    r = await postHook(port, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt: "second prompt",
    });
    expect(r.ok).toBe(true);
    expect(turnTransactions()).toHaveLength(2);
    expect(turnTransactions()[0].ended).toBe(true);
    expect(turnTransactions()[1].ended).toBe(false);
    expect(turnTransactions()[1].attrs["claude_code.turn_index"]).toBe(1);

    // SessionEnd -> turn #2 ended
    r = await postHook(port, { hook_event_name: "SessionEnd", session_id: sessionId });
    expect(r.ok).toBe(true);
    expect(turnTransactions()[1].ended).toBe(true);

    // Final assertions
    expect(turnTransactions()).toHaveLength(2);
    expect(turnTransactions().every((s) => s.ended)).toBe(true);
    expect(toolSpans()).toHaveLength(1);
    expect(toolSpans()[0].ended).toBe(true);
  });

  it("SessionStart alone creates no span", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "sess-only-start" });
    expect(sentry.spans).toHaveLength(0);
  });
});

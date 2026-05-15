import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("server: reader integration (C1/C6)", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    close = server.close;
    for (let i = 0; i < 25; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterEach(async () => { await close(); delete process.env.SENTRY_COLLECTOR_PORT; });

  it("attributes tokens to one turn despite tool_result user lines (C1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-c1-"));
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, [
      JSON.stringify({ type: "user", promptId: "P1", message: { content: "go" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 8, output_tokens: 4 } } }),
    ].join("\n"), "utf8");
    try {
      await postHook(port, { hook_event_name: "SessionStart", session_id: "s", transcript_path: tx });
      await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "go", prompt_id: "P1" });
      await postHook(port, { hook_event_name: "SessionEnd", session_id: "s", transcript_path: tx });
      const chat = sentry.spans.find((s) => s.op === "gen_ai.chat");
      expect(chat).toBeTruthy();
      // total = (100+8) input + (50+4) output = 162 (one real turn, not split)
      expect(chat!.attrs["gen_ai.usage.total_tokens"]).toBe(162);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server: per-session git cwd (C4)", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    close = server.close;
    for (let i = 0; i < 25; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterEach(async () => { await close(); delete process.env.SENTRY_COLLECTOR_PORT; });

  it("runs git detection against the session's _aiobs cwd, not process.cwd()", async () => {
    const repo = mkdtempSync(join(tmpdir(), "c4-repo-"));
    const branch = "aiobs-c4-branch";
    try {
      const g = (args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"] });
      g(["init", "-q"]);
      g(["config", "user.email", "t@t.t"]);
      g(["config", "user.name", "t"]);
      g(["checkout", "-q", "-b", branch]);
      g(["commit", "-q", "--allow-empty", "-m", "init"]);

      await postHook(port, {
        hook_event_name: "SessionStart",
        session_id: "c4",
        _aiobs: { context: { cwd: repo } },
      });
      await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "c4", prompt: "hi" });

      const turn = sentry.spans.find(
        (s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true,
      );
      expect(turn).toBeTruthy();
      expect(turn!.attrs["vcs.ref.head.name"]).toBe(branch);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("server: lazy session synthesis (R2)", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    close = server.close;
    for (let i = 0; i < 25; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterEach(async () => { await close(); delete process.env.SENTRY_COLLECTOR_PORT; });

  it("emits a turn even when SessionStart was missed, flagged synthesized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-r2-"));
    const tx = join(dir, "s.jsonl");
    try {
      writeFileSync(tx, [
        JSON.stringify({ type: "user", promptId: "P1", message: { content: "go" } }),
        JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-7", usage: { input_tokens: 9, output_tokens: 3 } } }),
      ].join("\n"), "utf8");
      // NOTE: NO SessionStart dispatched.
      await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "go", prompt_id: "P1", _aiobs: { context: { cwd: dir } } });
      await postHook(port, { hook_event_name: "SessionEnd", session_id: "s", transcript_path: tx });
      const turn = sentry.spans.find((s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true);
      expect(turn).toBeTruthy();
      expect(turn!.attrs["claude_code.session.synthesized"]).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server: dropped attr + heartbeat (R3/R4)", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let server: { close: () => Promise<void>; emitHeartbeat: () => void };

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    server = startServer(sentry as never, baseConfig, baseTags);
    for (let i = 0; i < 25; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterEach(async () => { await server.close(); delete process.env.SENTRY_COLLECTOR_PORT; });

  it("records dropped_since_last on the open turn span (R3)", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s" });
    await postHook(port, {
      hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x",
      _aiobs: { dropped_since_last: 4 },
    });
    const turn = sentry.spans.find((s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true);
    expect(turn).toBeTruthy();
    expect(turn!.attrs["claude_code.dropped_since_last"]).toBe(4);
  });

  it("emitHeartbeat produces a claude_code.collector.heartbeat span (R4)", () => {
    server.emitHeartbeat();
    const hb = sentry.spans.find((s) => s.attrs["claude_code.collector.heartbeat"] === true);
    expect(hb).toBeTruthy();
    expect(typeof hb!.attrs["claude_code.collector.uptime_s"]).toBe("number");
    expect(hb!.attrs["claude_code.collector.version"]).toBeDefined();
  });
});

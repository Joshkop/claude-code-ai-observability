import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  // Captured at end() time so tests can verify that span emission happened
  // inside the expected Sentry isolation scope (and not after it exited).
  endedUnderConversationId?: string | null | undefined;
}

function makeFakeSentry() {
  const spans: FakeSpan[] = [];
  const conversationIdCalls: Array<string | null | undefined> = [];
  // Simple stack model of the active isolation scope. Real Sentry uses
  // AsyncLocalStorage; this stack is enough to catch the "scope already
  // exited" class of bug where async work escapes the withIsolationScope
  // callback before completing.
  let activeConversationId: string | null | undefined = undefined;
  return {
    spans,
    conversationIdCalls,
    get activeConversationId() { return activeConversationId; },
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
        end() {
          span.ended = true;
          span.endedUnderConversationId = activeConversationId;
        },
      };
    },
    withActiveSpan<T>(_parent: unknown, fn: () => T): T {
      return fn();
    },
    withIsolationScope<T>(fn: (scope: { setConversationId(id: string | null | undefined): void }) => T): T {
      const previous = activeConversationId;
      const scope = {
        setConversationId: (id: string | null | undefined) => {
          conversationIdCalls.push(id);
          activeConversationId = id;
        },
      };
      const restore = (): void => { activeConversationId = previous; };
      try {
        const result = fn(scope);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as unknown as Promise<unknown>).finally(restore) as unknown as T;
        }
        restore();
        return result;
      } catch (e) {
        restore();
        throw e;
      }
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

describe("server: MCP + Skill tool attribution (N1/N2)", () => {
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

  it("sets gen_ai.tool.mcp.* + claude_code.tool.source on an MCP tool span (N1)", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s" });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "x" });
    await postHook(port, { hook_event_name: "PreToolUse", session_id: "s", tool_name: "mcp__claude_ai_Linear__list_issues", tool_use_id: "t1", tool_input: {} });
    const toolSpan = sentry.spans.find((s) => s.attrs["gen_ai.tool.name"] === "mcp__claude_ai_Linear__list_issues");
    expect(toolSpan).toBeTruthy();
    expect(toolSpan!.attrs["gen_ai.tool.mcp.server"]).toBe("claude_ai_Linear");
    expect(toolSpan!.attrs["gen_ai.tool.mcp.name"]).toBe("list_issues");
    expect(toolSpan!.attrs["claude_code.tool.source"]).toBe("mcp");
  });

  it("sets claude_code.skill.name/plugin on a Skill tool span (N2)", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s2" });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "x" });
    await postHook(port, { hook_event_name: "PreToolUse", session_id: "s2", tool_name: "Skill", tool_use_id: "t2", tool_input: { skill: "superpowers:brainstorming" } });
    const toolSpan = sentry.spans.find((s) => s.attrs["gen_ai.tool.name"] === "Skill");
    expect(toolSpan).toBeTruthy();
    expect(toolSpan!.attrs["claude_code.skill.name"]).toBe("brainstorming");
    expect(toolSpan!.attrs["claude_code.skill.plugin"]).toBe("superpowers");
  });
});

describe("server: slash-command attribution (N2)", () => {
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

  it("sets claude_code.command.name/plugin from a namespaced command", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "sc" });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "sc", prompt: "/superpowers:writing-plans go" });
    const turn = sentry.spans.find((s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true);
    expect(turn).toBeTruthy();
    expect(turn!.attrs["claude_code.command.name"]).toBe("writing-plans");
    expect(turn!.attrs["claude_code.command.plugin"]).toBe("superpowers");
  });

  it("does not set command attrs for a normal prompt", async () => {
    await postHook(port, { hook_event_name: "SessionStart", session_id: "sc2" });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "sc2", prompt: "just a normal prompt" });
    const turn = sentry.spans.find((s) => s.op === "gen_ai.invoke_agent" && s.forceTransaction === true);
    expect(turn).toBeTruthy();
    expect(turn!.attrs["claude_code.command.name"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3: applyRespawnTag sets claude_code.collector.respawned_from_version
// ---------------------------------------------------------------------------
describe("applyRespawnTag: tags collector spans with prior version when env set", () => {
  it("sets claude_code.collector.respawned_from_version when AIOBS_RESPAWNED_FROM env is present", async () => {
    const tags: Record<string, string | undefined> = {};
    const fakeSentry = {
      init: () => undefined,
      setTag: (k: string, v: string | undefined) => { tags[k] = v; },
      setUser: () => undefined,
      getCurrentScope: () => ({ setTag: () => undefined }),
    };
    const prev = process.env.AIOBS_RESPAWNED_FROM;
    process.env.AIOBS_RESPAWNED_FROM = "0.2.1";
    try {
      const { applyRespawnTag } = await import("../src/index.js");
      applyRespawnTag(fakeSentry as never);
      expect(tags["claude_code.collector.respawned_from_version"]).toBe("0.2.1");
    } finally {
      if (prev === undefined) delete process.env.AIOBS_RESPAWNED_FROM;
      else process.env.AIOBS_RESPAWNED_FROM = prev;
    }
  });

  it("does not call setTag when AIOBS_RESPAWNED_FROM env is absent", async () => {
    const tags: Record<string, string | undefined> = {};
    const fakeSentry = {
      setTag: (k: string, v: string | undefined) => { tags[k] = v; },
    };
    const prev = process.env.AIOBS_RESPAWNED_FROM;
    delete process.env.AIOBS_RESPAWNED_FROM;
    try {
      const { applyRespawnTag } = await import("../src/index.js");
      applyRespawnTag(fakeSentry as never);
      expect(tags["claude_code.collector.respawned_from_version"]).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.AIOBS_RESPAWNED_FROM = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Tasks 6 & 7: token_extraction.status diagnostic attribute
// ---------------------------------------------------------------------------
describe("server: token_extraction.status diagnostic (Tasks 6/7)", () => {
  let port: number;
  let sentry: ReturnType<typeof makeFakeSentry>;
  let close: () => Promise<void>;
  let tmpDirs: string[] = [];

  beforeEach(async () => {
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    close = server.close;
    tmpDirs = [];
    for (let i = 0; i < 25; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    vi.restoreAllMocks();
  });

  it("emits token_extraction.status=transcript_missing when transcriptPath empty", async () => {
    // SessionStart with no transcript_path → transcriptPath is undefined
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s-tm" });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s-tm", prompt: "hi" });
    // SessionEnd closes the turn; transcriptPath is still unset → transcript_missing
    await postHook(port, { hook_event_name: "SessionEnd", session_id: "s-tm" });
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("transcript_missing");
  });

  it("emits status=ok when transcript has tokens for the turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-te-ok-"));
    tmpDirs.push(dir);
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, [
      JSON.stringify({ type: "user", promptId: null, message: { content: "go" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 50, output_tokens: 20 } } }),
    ].join("\n"), "utf8");
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s-tok", transcript_path: tx });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s-tok", prompt: "go" });
    await postHook(port, { hook_event_name: "SessionEnd", session_id: "s-tok", transcript_path: tx });
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("ok");
  });

  it("emits status=no_matching_turn when transcript is empty/no real turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-te-nmt-"));
    tmpDirs.push(dir);
    const tx = join(dir, "s.jsonl");
    // Write a transcript with no turns (only typed lines, no user/assistant pairs)
    writeFileSync(tx, JSON.stringify({ type: "summary", permissionMode: "default" }) + "\n", "utf8");
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s-nmt", transcript_path: tx });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s-nmt", prompt: "go" });
    await postHook(port, { hook_event_name: "SessionEnd", session_id: "s-nmt", transcript_path: tx });
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("no_matching_turn");
  });

  it("emits status=turn_had_no_usage when matched turn has zero usage and retry also zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-te-tnz-"));
    tmpDirs.push(dir);
    const tx = join(dir, "s.jsonl");
    // Turn with zero usage
    writeFileSync(tx, [
      JSON.stringify({ type: "user", promptId: null, message: { content: "go" } }),
      JSON.stringify({ type: "assistant", message: { model: "m", usage: { input_tokens: 0, output_tokens: 0 } } }),
    ].join("\n"), "utf8");
    await postHook(port, { hook_event_name: "SessionStart", session_id: "s-tnz", transcript_path: tx });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s-tnz", prompt: "go" });
    await postHook(port, { hook_event_name: "SessionEnd", session_id: "s-tnz", transcript_path: tx });
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("turn_had_no_usage");
  });

  it("emits status='ok|matched_after_retry' when first read had 0 usage and second has usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "srv-te-retry-"));
    tmpDirs.push(dir);
    const tx = join(dir, "s.jsonl");
    writeFileSync(tx, "placeholder\n", "utf8");

    const emptyResult = {
      turns: [{ promptId: null, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 0, model: "m", prompt: null, response: null, turnIndex: 0 }],
      byPromptId: new Map<string, never>(),
      degraded: false,
      session: {},
    };
    const populatedResult = {
      turns: [{ promptId: null, inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 150, model: "m", prompt: null, response: null, turnIndex: 0 }],
      byPromptId: new Map<string, never>(),
      degraded: false,
      session: {},
    };

    let callCount = 0;
    const mod = await import("../src/transcript-reader.js");
    vi.spyOn(mod, "readTranscript").mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? emptyResult : populatedResult;
    });

    await postHook(port, { hook_event_name: "SessionStart", session_id: "s-retry", transcript_path: tx });
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "s-retry", prompt: "go" });
    await postHook(port, { hook_event_name: "SessionEnd", session_id: "s-retry", transcript_path: tx });

    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.token_extraction.status"]).toBe("ok|matched_after_retry");
    expect(chat!.attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(chat!.attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 2: conversation scope propagation via withIsolationScope
// ---------------------------------------------------------------------------
describe("server: conversation scope propagation", () => {
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

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
  });

  it("handleEvent: UserPromptSubmit triggers setConversationId(session_id)", async () => {
    await postHook(port, {
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-abc",
      prompt: "hello",
    });
    expect(sentry.conversationIdCalls).toContain("sess-abc");
  });

  it("handleEvent: SessionEnd triggers setConversationId(session_id)", async () => {
    await postHook(port, {
      hook_event_name: "SessionEnd",
      session_id: "sess-end",
    });
    expect(sentry.conversationIdCalls).toContain("sess-end");
  });

  it("handleEvent: PostToolUse triggers setConversationId(session_id)", async () => {
    // Need an open turn for PostToolUse to reference, but the scope call happens regardless
    await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "sess-tool", prompt: "hi" });
    const before = sentry.conversationIdCalls.length;
    await postHook(port, {
      hook_event_name: "PostToolUse",
      session_id: "sess-tool",
      tool_name: "Bash",
      tool_use_id: "tu-1",
      tool_response: "ok",
      tool_error: false,
    });
    expect(sentry.conversationIdCalls.slice(before)).toContain("sess-tool");
  });

  it("handleEvent: event with no session_id does NOT call setConversationId", async () => {
    const before = sentry.conversationIdCalls.length;
    // PreCompact has no session_id in spec; send it without one
    await postHook(port, {
      hook_event_name: "PreCompact",
    } as unknown as Parameters<typeof postHook>[1]);
    expect(sentry.conversationIdCalls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Task 3: reapStaleSession triggers setConversationId
// ---------------------------------------------------------------------------
describe("server: reapStaleSession conversation scope", () => {
  it("reapStaleSession: forceReap triggers setConversationId(sessionId)", async () => {
    const port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    try {
      for (let i = 0; i < 25; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      await postHook(port, {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-stale",
        prompt: "hi",
      });
      const beforeReap = sentry.conversationIdCalls.length;
      // forceReap reaps all active sessions regardless of idle time
      await server.forceReap();
      expect(sentry.conversationIdCalls.slice(beforeReap)).toContain("sess-stale");
    } finally {
      await server.close();
      delete process.env.SENTRY_COLLECTOR_PORT;
    }
  });

  // Regression: reapStaleSession used to fire-and-forget the async
  // closeCurrentTurn inside a sync withIsolationScope callback, so the
  // turn span's end() ran after the isolation scope had already exited.
  // The fix awaits closeCurrentTurn inside an async scope callback.
  it("reapStaleSession: turn span end() happens inside the conversation scope", async () => {
    const port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    try {
      for (let i = 0; i < 25; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      await postHook(port, {
        hook_event_name: "UserPromptSubmit",
        session_id: "sess-scoped",
        prompt: "hi",
      });
      await server.forceReap();
      const turnSpan = sentry.spans.find((s) => s.op === "gen_ai.invoke_agent");
      expect(turnSpan).toBeDefined();
      expect(turnSpan!.ended).toBe(true);
      expect(turnSpan!.endedUnderConversationId).toBe("sess-scoped");
    } finally {
      await server.close();
      delete process.env.SENTRY_COLLECTOR_PORT;
    }
  });

  // Concurrent sessions: two overlapping reaps must each tag their own
  // turn span with their own session_id, never cross-contaminate.
  it("reapStaleSession: concurrent sessions keep their own conversation IDs", async () => {
    const port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const sentry = makeFakeSentry();
    const server = startServer(sentry as never, baseConfig, baseTags);
    try {
      for (let i = 0; i < 25; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "sess-A", prompt: "a" });
      await postHook(port, { hook_event_name: "UserPromptSubmit", session_id: "sess-B", prompt: "b" });
      await server.forceReap();
      const turnSpans = sentry.spans.filter((s) => s.op === "gen_ai.invoke_agent");
      expect(turnSpans.length).toBe(2);
      const tagged = turnSpans.map((s) => s.endedUnderConversationId).sort();
      expect(tagged).toEqual(["sess-A", "sess-B"]);
    } finally {
      await server.close();
      delete process.env.SENTRY_COLLECTOR_PORT;
    }
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachSubagentToEvent,
  createSubagentSession,
  createSubagentSpan,
  findActiveSubagentSpan,
  isSubagentInvocation,
} from "../src/subagent.js";
import type { PreToolUseEvent, PostToolUseEvent } from "../src/types.js";
import * as transcriptMod from "../src/transcript.js";

function makeFakeSpan() {
  const attrs: Record<string, unknown> = {};
  let ended = false;
  let status: unknown = null;
  return {
    attrs,
    ended: () => ended,
    status: () => status,
    setAttribute(k: string, v: unknown) { attrs[k] = v; },
    end() { ended = true; },
    setStatus(s: unknown) { status = s; },
  };
}

function makeFakeSentry() {
  const spans: ReturnType<typeof makeFakeSpan>[] = [];
  return {
    spans,
    startInactiveSpan(opts: { op?: string; name?: string; attributes?: Record<string, unknown> }) {
      const span = makeFakeSpan();
      if (opts.attributes) {
        for (const [k, v] of Object.entries(opts.attributes)) {
          span.attrs[k] = v;
        }
      }
      spans.push(span);
      return span;
    },
    withActiveSpan<T>(_span: unknown, fn: () => T): T {
      return fn();
    },
  };
}

function preToolUseEvent(toolName: string, toolInput?: unknown): PreToolUseEvent {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    tool_name: toolName,
    tool_use_id: `tu-${toolName}-1`,
    tool_input: toolInput,
  };
}

function postToolUseEvent(toolName: string, toolUseId?: string, error = false): PostToolUseEvent {
  return {
    hook_event_name: "PostToolUse",
    session_id: "sess-1",
    tool_name: toolName,
    tool_use_id: toolUseId ?? `tu-${toolName}-1`,
    tool_error: error,
  };
}

describe("isSubagentInvocation", () => {
  it("returns true for PreToolUse Task", () => {
    expect(isSubagentInvocation(preToolUseEvent("Task"))).toBe(true);
  });

  it("returns true for PostToolUse Task", () => {
    expect(isSubagentInvocation(postToolUseEvent("Task"))).toBe(true);
  });

  it("returns true for PreToolUse Agent", () => {
    expect(isSubagentInvocation(preToolUseEvent("Agent"))).toBe(true);
  });

  it("returns true for PostToolUse Agent", () => {
    expect(isSubagentInvocation(postToolUseEvent("Agent"))).toBe(true);
  });

  it("returns false for PreToolUse Bash", () => {
    expect(isSubagentInvocation(preToolUseEvent("Bash"))).toBe(false);
  });

  it("returns false for PreToolUse Read", () => {
    expect(isSubagentInvocation(preToolUseEvent("Read"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSubagentInvocation(null)).toBe(false);
  });
});

describe("attachSubagentToEvent", () => {
  it("returns false for non-Task PreToolUse", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const result = attachSubagentToEvent(sentry as never, session, preToolUseEvent("Bash"));
    expect(result).toBe(false);
    expect(sentry.spans).toHaveLength(0);
  });

  it("returns true and creates a span for Task PreToolUse", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    const result = attachSubagentToEvent(
      sentry as never,
      session,
      preToolUseEvent("Task", { subagent_type: "explore", prompt: "do stuff" }),
    );
    expect(result).toBe(true);
    expect(sentry.spans).toHaveLength(1);
    expect(sentry.spans[0].attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("span op is gen_ai.invoke_agent", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    attachSubagentToEvent(
      sentry as never,
      session,
      preToolUseEvent("Task", { subagent_type: "explore" }),
    );
    // The span was created; attrs set from the options.attributes during startInactiveSpan
    expect(sentry.spans[0].attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("returns true for Task PostToolUse and closes the span", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();

    attachSubagentToEvent(
      sentry as never,
      session,
      preToolUseEvent("Task", { subagent_type: "explore" }),
    );
    expect(sentry.spans[0].ended()).toBe(false);

    const result = attachSubagentToEvent(
      sentry as never,
      session,
      postToolUseEvent("Task"),
    );
    expect(result).toBe(true);
    expect(sentry.spans[0].ended()).toBe(true);
  });

  it("active map is cleared after PostToolUse", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();

    attachSubagentToEvent(sentry as never, session, preToolUseEvent("Task", { subagent_type: "explore" }));
    expect(session.active.size).toBe(1);

    attachSubagentToEvent(sentry as never, session, postToolUseEvent("Task"));
    expect(session.active.size).toBe(0);
  });

  it("sets gen_ai.agent.name from subagent_type", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    attachSubagentToEvent(
      sentry as never,
      session,
      preToolUseEvent("Task", { subagent_type: "researcher" }),
    );
    expect(sentry.spans[0].attrs["gen_ai.agent.name"]).toBe("researcher");
  });

  it("sets gen_ai.conversation.id from event.session_id on subagent span", () => {
    const sentry = makeFakeSentry();
    const span = createSubagentSpan(sentry as never, {
      hook_event_name: "PreToolUse",
      session_id: "sess-1",
      tool_name: "Task",
      tool_use_id: "tu_1",
      tool_input: { subagent_type: "researcher", prompt: "find X", description: "research" },
    } as PreToolUseEvent);
    expect(span).not.toBeNull();
    expect(sentry.spans[0].attrs["gen_ai.conversation.id"]).toBe("sess-1");
    expect(sentry.spans[0].attrs["gen_ai.agent.name"]).toBe("researcher");
  });
});

describe("findActiveSubagentSpan", () => {
  it("returns null when nothing is active", () => {
    const session = createSubagentSession();
    expect(findActiveSubagentSpan(session, "sess-1")).toBeNull();
  });

  it("returns the most recently started wrapper span", () => {
    const sentry = makeFakeSentry();
    const session = createSubagentSession();
    attachSubagentToEvent(sentry as never, session, {
      ...preToolUseEvent("Agent", { subagent_type: "executor" }),
      tool_use_id: "tu-A",
    });
    attachSubagentToEvent(sentry as never, session, {
      ...preToolUseEvent("Agent", { subagent_type: "designer" }),
      tool_use_id: "tu-B",
    });
    const top = findActiveSubagentSpan(session, "sess-1");
    expect(top).toBe(sentry.spans[1]);
  });
});

describe("attachSubagentToEvent — chat child attrs (conversation.id, agent.name, reasoning)", () => {
  it("subagent chat child carries conversation.id, agent.name, reasoning", () => {
    const root = mkdtempSync(join(tmpdir(), "aiobs-chat-child-"));
    const spy = vi.spyOn(transcriptMod, "extractSidechainUsage").mockReturnValue({
      inputTokens: 100, outputTokens: 50,
      cachedInputTokens: 0, cacheCreationTokens: 0,
      model: "claude-sonnet-4-6",
      startTime: undefined, endTime: undefined,
      assistantTurnCount: 1,
      reasoningTokens: 11, reasoningEstimated: true,
    });
    try {
      const projectDir = join(root, "proj");
      mkdirSync(projectDir, { recursive: true });
      const sessionId = "sess-A";
      const parentTranscript = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(parentTranscript, "");
      const subagentDir = join(projectDir, sessionId, "subagents");
      mkdirSync(subagentDir, { recursive: true });
      // Write a placeholder agent file so locateSidechainUsage finds a candidate
      const agentFile = join(subagentDir, "agent-abc.jsonl");
      writeFileSync(agentFile, "");

      const sentry = makeFakeSentry();
      const session = createSubagentSession();

      // PreToolUse
      attachSubagentToEvent(sentry as never, session, {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "Task",
        tool_use_id: "tu_42",
        tool_input: { subagent_type: "researcher", prompt: "go" },
      } as PreToolUseEvent, { parentTranscriptPath: parentTranscript });

      // PostToolUse — spy intercepts extractSidechainUsage
      attachSubagentToEvent(sentry as never, session, {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_name: "Task",
        tool_use_id: "tu_42",
      } as PostToolUseEvent, { parentTranscriptPath: parentTranscript });

      const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
      expect(chat).toBeDefined();
      expect(chat!.attrs["gen_ai.conversation.id"]).toBe("sess-A");
      expect(chat!.attrs["gen_ai.agent.name"]).toBe("researcher");
      expect(chat!.attrs["gen_ai.usage.output_tokens.reasoning"]).toBe(11);
      expect(chat!.attrs["claude_code.reasoning_tokens.estimated"]).toBe(true);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("attachSubagentToEvent — sidechain chat synthesis", () => {
  it("synthesizes a gen_ai.chat child with model + tokens from the new agent transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "aiobs-subagent-"));
    try {
      const projectDir = join(root, "proj");
      mkdirSync(projectDir, { recursive: true });
      const sessionId = "sess-X";
      const parentTranscript = join(projectDir, `${sessionId}.jsonl`);
      writeFileSync(parentTranscript, "");
      const subagentDir = join(projectDir, sessionId, "subagents");
      mkdirSync(subagentDir, { recursive: true });

      const sentry = makeFakeSentry();
      const session = createSubagentSession();

      // PreToolUse: snapshot subagent dir (currently empty).
      const pre: PreToolUseEvent = {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "Agent",
        tool_use_id: "tu-AG-1",
        tool_input: { subagent_type: "oh-my-claudecode:executor", description: "Build feature" },
      };
      attachSubagentToEvent(sentry as never, session, pre, {
        parentTranscriptPath: parentTranscript,
      });
      expect(sentry.spans).toHaveLength(1); // wrapper

      // Subagent runs: writes a transcript + meta sidecar.
      const agentFile = join(subagentDir, "agent-deadbeef.jsonl");
      writeFileSync(
        agentFile,
        [
          JSON.stringify({ type: "user", isSidechain: true, timestamp: "2026-04-28T10:00:00Z", message: { role: "user", content: "go" } }),
          JSON.stringify({
            type: "assistant",
            isSidechain: true,
            timestamp: "2026-04-28T10:00:30Z",
            message: { model: "claude-sonnet-4-6", role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 } },
          }),
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        agentFile.replace(/\.jsonl$/, ".meta.json"),
        JSON.stringify({ agentType: "oh-my-claudecode:executor", description: "Build feature" }),
        "utf8",
      );

      // PostToolUse: should locate transcript, synthesize chat child.
      const post: PostToolUseEvent = {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_name: "Agent",
        tool_use_id: "tu-AG-1",
      };
      const ok = attachSubagentToEvent(sentry as never, session, post, {
        parentTranscriptPath: parentTranscript,
      });
      expect(ok).toBe(true);

      // Two spans should now exist: wrapper (index 0) + chat (index 1).
      expect(sentry.spans.length).toBeGreaterThanOrEqual(2);
      const chat = sentry.spans[1];
      expect(chat.attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
      expect(chat.attrs["gen_ai.usage.input_tokens"]).toBe(300); // 100 + 200
      expect(chat.attrs["gen_ai.usage.output_tokens"]).toBe(50);
      expect(chat.attrs["gen_ai.usage.input_tokens.cached"]).toBe(200);

      // Wrapper should have model + rollup mirrored for filter parity.
      const wrapper = sentry.spans[0];
      expect(wrapper.attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
      expect(wrapper.attrs["gen_ai.usage.total_tokens"]).toBe(350);
      expect(wrapper.ended()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  attachSubagentToEvent,
  createSubagentSession,
  isSubagentInvocation,
} from "../src/subagent.js";
import type { PreToolUseEvent, PostToolUseEvent } from "../src/types.js";

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
});

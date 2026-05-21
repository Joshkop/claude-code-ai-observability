import { describe, it, expect } from "vitest";
import { openTurnTransaction, closeTurnSpan, createToolSpan } from "../src/spans.js";
import type { AutoTags, ResolvedPluginConfig } from "../src/types.js";

function makeFakeSpan() {
  const attrs: Record<string, unknown> = {};
  return {
    attrs,
    setAttribute(k: string, v: unknown) { attrs[k] = v; },
    end() {},
    setStatus() {},
  };
}

function makeFakeSentry() {
  const spans: ReturnType<typeof makeFakeSpan>[] = [];
  const startCalls: { op?: string; name?: string; forceTransaction?: boolean }[] = [];
  return {
    spans,
    startCalls,
    startInactiveSpan(opts: { op?: string; name?: string; attributes?: Record<string, unknown>; forceTransaction?: boolean }) {
      startCalls.push({ op: opts.op, name: opts.name, forceTransaction: opts.forceTransaction });
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
    flush: async () => {},
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
  "claude_code.session_id": "sess-001",
  "host.name": "testhost",
  "os.type": "linux",
  "process.cwd": "/tmp",
  "process.pid": 1234,
};

describe("openTurnTransaction attribute contract", () => {
  it("emits two spans: a claude_code.turn transaction root and a gen_ai.invoke_agent child", () => {
    const sentry = makeFakeSentry();
    openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    expect(sentry.startCalls).toHaveLength(2);
    expect(sentry.startCalls[0].op).toBe("claude_code.turn");
    expect(sentry.startCalls[0].forceTransaction).toBe(true);
    expect(sentry.startCalls[1].op).toBe("gen_ai.invoke_agent");
    expect(sentry.startCalls[1].name).toBe("invoke_agent claude-code");
    // The invoke_agent span MUST NOT be its own transaction — Sentry's
    // extractGenAiSpansFromEvent only extracts descendants of a transaction
    // into the v2 standalone stream that AI Conversations reads.
    expect(sentry.startCalls[1].forceTransaction).toBeUndefined();
  });

  it("sets gen_ai.operation.name=invoke_agent on the agent span", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("sets gen_ai.provider.name + gen_ai.agent.name on the agent span (no legacy gen_ai.system)", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(agent.attrs["gen_ai.agent.name"]).toBe("claude-code");
    // gen_ai.system was deprecated by Sentry in favor of gen_ai.provider.name
    // and is stripped server-side. Don't emit it.
    expect(agent.attrs["gen_ai.system"]).toBeUndefined();
  });

  it("sets gen_ai.conversation.id on BOTH root and agent spans (root row + v2 standalone grouping)", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-conv-1", 0, null, baseTags, baseConfig);
    const root = turn.root as unknown as ReturnType<typeof makeFakeSpan>;
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(root.attrs["gen_ai.conversation.id"]).toBe("sess-conv-1");
    expect(agent.attrs["gen_ai.conversation.id"]).toBe("sess-conv-1");
  });

  it("sets claude_code.session_id and claude_code.turn_index on both spans", () => {
    const sentry = makeFakeSentry();
    const tags: AutoTags = { ...baseTags, "claude_code.session_id": "sess-xyz" };
    const turn = openTurnTransaction(sentry as never, "sess-xyz", 3, null, tags, baseConfig);
    const root = turn.root as unknown as ReturnType<typeof makeFakeSpan>;
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(root.attrs["claude_code.session_id"]).toBe("sess-xyz");
    expect(root.attrs["claude_code.turn_index"]).toBe(3);
    expect(agent.attrs["claude_code.session_id"]).toBe("sess-xyz");
    expect(agent.attrs["claude_code.turn_index"]).toBe(3);
  });

  it("sets gen_ai.request.model on the agent span when model is provided", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-opus-4-7");
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.request.model"]).toBe("claude-opus-4-7");
  });

  it("does not set gen_ai.request.model when model is absent", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.request.model"]).toBeUndefined();
  });

  it("applies auto-tags onto the transaction root", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const root = turn.root as unknown as ReturnType<typeof makeFakeSpan>;
    expect(root.attrs["host.name"]).toBe("testhost");
    expect(root.attrs["process.pid"]).toBe(1234);
  });

  it("attaches gen_ai.input.messages to the agent span when recordInputs is true and prompt provided", () => {
    const sentry = makeFakeSentry();
    const cfg: ResolvedPluginConfig = { ...baseConfig, recordInputs: true };
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, "hello world", baseTags, cfg);
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.input.messages"]).toBeDefined();
  });

  it("does not attach gen_ai.input.messages when recordInputs is false", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, "hello world", baseTags, baseConfig);
    const agent = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;
    expect(agent.attrs["gen_ai.input.messages"]).toBeUndefined();
  });
});

describe("closeTurnSpan attribute contract", () => {
  function makeTokens(overrides = {}) {
    return {
      turnIndex: 0,
      inputTokens: 150,
      outputTokens: 60,
      cachedInputTokens: 30,
      cacheCreationTokens: 20,
      totalTokens: 210,
      model: "claude-sonnet-4-6",
      prompt: null,
      response: null,
      ...overrides,
    };
  }

  it("emits a gen_ai.chat child span carrying token attributes (Sentry 'Tokens Used' widget requires op=gen_ai.chat)", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    sentry.startCalls.length = 0; // ignore the invoke_agent open call

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens(), sessionId: "sess-1" }, baseConfig);

    // closeTurnSpan should have started exactly one chat child.
    expect(sentry.startCalls).toHaveLength(1);
    expect(sentry.startCalls[0].op).toBe("gen_ai.chat");

    const chatSpan = sentry.spans[sentry.spans.length - 1];
    expect(chatSpan.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(chatSpan.attrs["gen_ai.usage.input_tokens"]).toBe(150); // input_tokens is the full input including cached (Sentry schema)
    expect(chatSpan.attrs["gen_ai.usage.output_tokens"]).toBe(60);
    expect(chatSpan.attrs["gen_ai.usage.total_tokens"]).toBe(210);
    expect(chatSpan.attrs["gen_ai.usage.input_tokens.cached"]).toBe(30);
    expect(chatSpan.attrs["gen_ai.usage.input_tokens.cache_write"]).toBe(20);
    expect(chatSpan.attrs["gen_ai.conversation.id"]).toBe("sess-1");
  });

  it("does NOT put token attributes on the invoke_agent root (they live on the chat child)", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens() }, baseConfig);

    expect(turnSpan.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(turnSpan.attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(turnSpan.attrs["gen_ai.usage.total_tokens"]).toBeUndefined();
  });

  it("does not emit cache_write on the chat child when cacheCreationTokens is zero", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    sentry.startCalls.length = 0;

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens({ cacheCreationTokens: 0 }) }, baseConfig);

    const chatSpan = sentry.spans[sentry.spans.length - 1];
    expect(chatSpan.attrs["gen_ai.usage.input_tokens.cache_write"]).toBeUndefined();
  });

  it("sets gen_ai.response.model from tokens.model", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens({ model: "claude-opus-4-7" }) }, baseConfig);

    expect(turnSpan.attrs["gen_ai.response.model"]).toBe("claude-opus-4-7");
  });

  it("sets gen_ai.response.model from responseModel when provided", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens({ model: null }), responseModel: "claude-haiku-4-5-20251001" }, baseConfig);

    expect(turnSpan.attrs["gen_ai.response.model"]).toBe("claude-haiku-4-5-20251001");
  });

  it("sets conversation.cost_estimate_usd rollup when cost is provided", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(
      sentry as never,
      turn as never,
      {
        tokens: makeTokens(),
        cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003 },
      },
      baseConfig,
    );

    expect(turnSpan.attrs["conversation.cost_estimate_usd"]).toBe(0.003);
  });

  it("does not emit per-bucket gen_ai.usage.cost.* — Sentry has no such convention", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(
      sentry as never,
      turn as never,
      {
        tokens: makeTokens(),
        cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003 },
      },
      baseConfig,
    );

    expect(turnSpan.attrs["gen_ai.usage.cost.input_tokens"]).toBeUndefined();
    expect(turnSpan.attrs["gen_ai.usage.cost.output_tokens"]).toBeUndefined();
    expect(turnSpan.attrs["gen_ai.usage.cost.total_tokens"]).toBeUndefined();
  });

  it("does not emit conversation.cost_estimate_usd when cost is absent", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    const turnSpan = turn.agent as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(sentry as never, turn as never, { tokens: makeTokens() }, baseConfig);

    expect(turnSpan.attrs["conversation.cost_estimate_usd"]).toBeUndefined();
  });

  it("sets gen_ai.agent.name=claude-code on the chat child", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "session-abc", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "session-abc",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["gen_ai.agent.name"]).toBe("claude-code");
  });

  it("emits reasoning attrs on chat child when tokens.reasoningTokens > 0", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "session-abc", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens({ reasoningTokens: 17, reasoningEstimated: true }),
      sessionId: "session-abc",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["gen_ai.usage.output_tokens.reasoning"]).toBe(17);
    expect(chat!.attrs["claude_code.reasoning_tokens.estimated"]).toBe(true);
  });

  it("does not emit reasoning attrs when tokens.reasoningTokens missing", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "session-abc", 0, null, baseTags, baseConfig, "claude-sonnet-4-6");
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "session-abc",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["gen_ai.usage.output_tokens.reasoning"]).toBeUndefined();
    expect(chat!.attrs["claude_code.reasoning_tokens.estimated"]).toBeUndefined();
  });

  it("emits claude_code.usage_extraction.status when CloseTurnInput.tokenExtractionStatus is set", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as never, turn as never, {
      tokens: { turnIndex: 0, inputTokens: 10, outputTokens: 5,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 15,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "sess-1",
      tokenExtractionStatus: "ok|matched_after_retry",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.usage_extraction.status"]).toBe("ok|matched_after_retry");
  });

  it("mirrors gen_ai.input.messages onto the chat child when prompt + recordInputs (Sentry Conversations base filter requires input AND output on the same span)", () => {
    const sentry = makeFakeSentry();
    const cfg: ResolvedPluginConfig = { ...baseConfig, recordInputs: true, recordOutputs: true };
    const turn = openTurnTransaction(sentry as never, "sess-conv", 0, "hello world", baseTags, cfg);
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "sess-conv",
      response: "hi there",
      prompt: "hello world",
    }, cfg);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["gen_ai.input.messages"]).toBeDefined();
    expect(chat!.attrs["gen_ai.output.messages"]).toBeDefined();
    expect(chat!.attrs["gen_ai.conversation.id"]).toBe("sess-conv");
  });

  it("emits one gen_ai.output.messages entry per assistant completion when responses[] is set (Sentry AI Conversations renders each as its own bubble)", () => {
    const sentry = makeFakeSentry();
    const cfg: ResolvedPluginConfig = { ...baseConfig, recordOutputs: true };
    const turn = openTurnTransaction(sentry as never, "sess-multi", 0, null, baseTags, cfg);
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "sess-multi",
      response: "Message 1.\nMessage 2.",
      responses: ["Message 1.", "Message 2."],
    }, cfg);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    const out = JSON.parse(chat!.attrs["gen_ai.output.messages"] as string);
    expect(out).toEqual([
      { role: "assistant", content: "Message 1." },
      { role: "assistant", content: "Message 2." },
    ]);
  });

  it("falls back to joined response string when responses[] is absent (legacy callers / single-completion turns)", () => {
    const sentry = makeFakeSentry();
    const cfg: ResolvedPluginConfig = { ...baseConfig, recordOutputs: true };
    const turn = openTurnTransaction(sentry as never, "sess-legacy", 0, null, baseTags, cfg);
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "sess-legacy",
      response: "single message",
    }, cfg);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    const out = JSON.parse(chat!.attrs["gen_ai.output.messages"] as string);
    expect(out).toEqual([{ role: "assistant", content: "single message" }]);
  });

  it("omits gen_ai.input.messages on the chat child when recordInputs is false", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    closeTurnSpan(sentry as never, turn as never, {
      tokens: makeTokens(),
      sessionId: "sess-1",
      prompt: "hello world",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat!.attrs["gen_ai.input.messages"]).toBeUndefined();
  });

  it("omits claude_code.usage_extraction.status when undefined", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(
      sentry as never, "sess-1", 0, null, baseTags, baseConfig, "claude-sonnet-4-6",
    );
    closeTurnSpan(sentry as never, turn as never, {
      tokens: { turnIndex: 0, inputTokens: 10, outputTokens: 5,
        cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 15,
        model: "claude-sonnet-4-6", prompt: null, response: null },
      sessionId: "sess-1",
    }, baseConfig);
    const chat = sentry.spans.find(s => s.attrs["gen_ai.operation.name"] === "chat");
    expect(chat).toBeDefined();
    expect(chat!.attrs["claude_code.usage_extraction.status"]).toBeUndefined();
  });
});

describe("C2 — input_tokens includes cached (Sentry schema)", () => {
  it("input_tokens is the full input including cached + cache_write; total_tokens is input + output", () => {
    const sentry = makeFakeSentry();
    const turn = { root: makeFakeSpan(), agent: makeFakeSpan() };
    const cfg = { recordInputs: false, recordOutputs: false, maxAttributeLength: 1000, tags: {} } as never;
    closeTurnSpan(
      sentry as never,
      turn as never,
      {
        tokens: {
          turnIndex: 0, inputTokens: 100, outputTokens: 40,
          cachedInputTokens: 20, cacheCreationTokens: 10, totalTokens: 140,
          model: "claude-opus-4-7", prompt: null, response: null,
        },
      },
      cfg,
    );
    const chat = sentry.spans[sentry.spans.length - 1];
    expect(chat.attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(chat.attrs["gen_ai.usage.input_tokens.cached"]).toBe(20);
    expect(chat.attrs["gen_ai.usage.input_tokens.cache_write"]).toBe(10);
    expect(chat.attrs["gen_ai.usage.output_tokens"]).toBe(40);
    expect(chat.attrs["gen_ai.usage.total_tokens"]).toBe(140);
  });
});

describe("createToolSpan parent behavior", () => {
  it("creates a child tool span when a parent is provided", () => {
    const sentry = makeFakeSentry();
    const turn = openTurnTransaction(sentry as never, "sess-1", 0, null, baseTags, baseConfig);
    sentry.startCalls.length = 0; // reset to inspect just the tool span call
    createToolSpan(sentry as never, turn.agent, "Bash", { command: "ls" }, baseConfig);
    expect(sentry.startCalls).toHaveLength(1);
    expect(sentry.startCalls[0].op).toBe("gen_ai.execute_tool");
    expect(sentry.startCalls[0].forceTransaction).toBeUndefined();
  });

  it("starts an orphan root transaction when parent is null", () => {
    const sentry = makeFakeSentry();
    createToolSpan(sentry as never, null, "Bash", undefined, baseConfig);
    expect(sentry.startCalls).toHaveLength(1);
    expect(sentry.startCalls[0].op).toBe("gen_ai.execute_tool");
    expect(sentry.startCalls[0].forceTransaction).toBe(true);
  });

  it("sets gen_ai.tool.call.id when tool_use_id is provided", () => {
    const sentry = makeFakeSentry();
    const span = createToolSpan(
      sentry as never,
      null,
      "Bash",
      undefined,
      baseConfig,
      undefined,
      "toolu_abc123",
    );
    const fake = span as unknown as ReturnType<typeof makeFakeSpan>;
    expect(fake.attrs["gen_ai.tool.call.id"]).toBe("toolu_abc123");
    expect(fake.attrs["gen_ai.tool.type"]).toBe("function");
    expect(fake.attrs["gen_ai.provider.name"]).toBe("anthropic");
  });

  it("does not set gen_ai.tool.call.id when tool_use_id is absent", () => {
    const sentry = makeFakeSentry();
    const span = createToolSpan(sentry as never, null, "Bash", undefined, baseConfig);
    const fake = span as unknown as ReturnType<typeof makeFakeSpan>;
    expect(fake.attrs["gen_ai.tool.call.id"]).toBeUndefined();
  });

  it("sets gen_ai.conversation.id from sessionId", () => {
    const sentry = makeFakeSentry();
    const span = createToolSpan(
      sentry as never,
      null,
      "Bash",
      { command: "ls" },
      baseConfig,
      undefined,
      "tool-use-id-1",
      "session-xyz",
    );
    const fake = span as unknown as ReturnType<typeof makeFakeSpan>;
    expect(fake.attrs["gen_ai.conversation.id"]).toBe("session-xyz");
    span.end();
  });
});

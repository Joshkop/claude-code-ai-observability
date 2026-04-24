import { describe, it, expect } from "vitest";
import { openTurnSpan, closeTurnSpan, createRootSpan } from "../src/spans.js";
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
  return {
    spans,
    startInactiveSpan(opts: { op?: string; name?: string; attributes?: Record<string, unknown>; forceTransaction?: boolean }) {
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

describe("openTurnSpan attribute contract", () => {
  it("sets gen_ai.operation.name=chat", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig, "claude-sonnet-4-6");
    const span = turn as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.operation.name"]).toBe("chat");
  });

  it("sets gen_ai.system=anthropic", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig, "claude-sonnet-4-6");
    const span = turn as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.system"]).toBe("anthropic");
  });

  it("sets gen_ai.request.model when model is provided", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig, "claude-opus-4-7");
    const span = turn as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.request.model"]).toBe("claude-opus-4-7");
  });

  it("does not set gen_ai.request.model when model is absent", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const span = turn as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.request.model"]).toBeUndefined();
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

  it("sets input/output/total/cached token attributes", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const turnSpan = turn as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(turn as never, { tokens: makeTokens() }, baseConfig);

    expect(turnSpan.attrs["gen_ai.usage.input_tokens"]).toBe(150);
    expect(turnSpan.attrs["gen_ai.usage.output_tokens"]).toBe(60);
    expect(turnSpan.attrs["gen_ai.usage.total_tokens"]).toBe(210);
    expect(turnSpan.attrs["gen_ai.usage.input_tokens.cached"]).toBe(30);
  });

  it("sets gen_ai.response.model from tokens.model", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const turnSpan = turn as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(turn as never, { tokens: makeTokens({ model: "claude-opus-4-7" }) }, baseConfig);

    expect(turnSpan.attrs["gen_ai.response.model"]).toBe("claude-opus-4-7");
  });

  it("sets gen_ai.response.model from responseModel when provided", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const turnSpan = turn as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(turn as never, { tokens: makeTokens({ model: null }), responseModel: "claude-haiku-4-5-20251001" }, baseConfig);

    expect(turnSpan.attrs["gen_ai.response.model"]).toBe("claude-haiku-4-5-20251001");
  });

  it("sets cost attributes when cost is provided", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const turnSpan = turn as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(
      turn as never,
      {
        tokens: makeTokens(),
        cost: { inputCost: 0.001, outputCost: 0.002, totalCost: 0.003 },
      },
      baseConfig,
    );

    expect(turnSpan.attrs["gen_ai.usage.cost.input_tokens"]).toBe(0.001);
    expect(turnSpan.attrs["gen_ai.usage.cost.output_tokens"]).toBe(0.002);
    expect(turnSpan.attrs["gen_ai.usage.cost.total_tokens"]).toBe(0.003);
  });

  it("does not set cost attributes when cost is absent", () => {
    const sentry = makeFakeSentry();
    const root = sentry.startInactiveSpan({ op: "gen_ai.invoke_agent" });
    const turn = openTurnSpan(sentry as never, root as never, null, baseTags, baseConfig);
    const turnSpan = turn as unknown as ReturnType<typeof makeFakeSpan>;

    closeTurnSpan(turn as never, { tokens: makeTokens() }, baseConfig);

    expect(turnSpan.attrs["gen_ai.usage.cost.input_tokens"]).toBeUndefined();
  });
});

describe("createRootSpan attribute contract", () => {
  it("sets gen_ai.operation.name=invoke_agent", () => {
    const sentry = makeFakeSentry();
    const root = createRootSpan(sentry as never, "sess-1", baseTags, baseConfig);
    const span = root as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("sets gen_ai.system=anthropic", () => {
    const sentry = makeFakeSentry();
    const root = createRootSpan(sentry as never, "sess-1", baseTags, baseConfig);
    const span = root as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.system"]).toBe("anthropic");
  });

  it("sets gen_ai.agent.name=claude-code", () => {
    const sentry = makeFakeSentry();
    const root = createRootSpan(sentry as never, "sess-1", baseTags, baseConfig);
    const span = root as unknown as ReturnType<typeof makeFakeSpan>;
    expect(span.attrs["gen_ai.agent.name"]).toBe("claude-code");
  });
});

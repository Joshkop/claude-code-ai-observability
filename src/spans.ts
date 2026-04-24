import type * as Sentry from "@sentry/node";
import type { TurnTokens, AutoTags, ResolvedPluginConfig } from "./types.js";
import { serialize } from "./serialize.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

type SentryNs = typeof Sentry;

function applyTags(span: Span, tags: AutoTags, userTags: Record<string, string>): void {
  for (const [k, v] of Object.entries(tags)) {
    if (v !== undefined && v !== null) span.setAttribute(k, v as string | number);
  }
  for (const [k, v] of Object.entries(userTags)) {
    if (v !== undefined && v !== null) span.setAttribute(k, v);
  }
}

export function openTurnTransaction(
  sentry: SentryNs,
  sessionId: string,
  turnIndex: number,
  prompt: string | null,
  tags: AutoTags,
  config: ResolvedPluginConfig,
  model?: string,
  startTime?: number,
): Span {
  const span = sentry.startInactiveSpan({
    op: "gen_ai.invoke_agent",
    name: "invoke_agent claude-code",
    forceTransaction: true,
    startTime,
    attributes: {
      "gen_ai.agent.name": "claude-code",
      "gen_ai.system": "anthropic",
      "gen_ai.operation.name": "invoke_agent",
      "claude_code.session_id": sessionId,
      "claude_code.turn_index": turnIndex,
      ...(model ? { "gen_ai.request.model": model } : {}),
    },
  });
  applyTags(span, tags, config.tags);
  if (config.recordInputs && prompt) {
    const messages = serialize(
      [{ role: "user", content: prompt }],
      config.maxAttributeLength,
    );
    span.setAttribute("gen_ai.request.messages", messages);
  }
  return span;
}

export interface CloseTurnInput {
  tokens: TurnTokens;
  responseModel?: string;
  cost?: { inputCost: number; outputCost: number; totalCost: number };
  response?: string | null;
}

export function closeTurnSpan(
  turnSpan: Span,
  input: CloseTurnInput,
  config: ResolvedPluginConfig,
  endTime?: number,
): void {
  const { tokens, responseModel, cost, response } = input;
  turnSpan.setAttribute("gen_ai.usage.input_tokens", tokens.inputTokens);
  turnSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
  turnSpan.setAttribute(
    "gen_ai.usage.total_tokens",
    tokens.inputTokens + tokens.outputTokens,
  );
  turnSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
  if (tokens.cacheCreationTokens) {
    turnSpan.setAttribute("gen_ai.usage.input_tokens.cache_creation", tokens.cacheCreationTokens);
  }
  const respModel = responseModel ?? tokens.model ?? undefined;
  if (respModel) {
    turnSpan.setAttribute("gen_ai.response.model", respModel);
  }
  if (cost) {
    turnSpan.setAttribute("gen_ai.usage.cost.input_tokens", cost.inputCost);
    turnSpan.setAttribute("gen_ai.usage.cost.output_tokens", cost.outputCost);
    turnSpan.setAttribute("gen_ai.usage.cost.total_tokens", cost.totalCost);
  }
  if (config.recordOutputs && response) {
    turnSpan.setAttribute(
      "gen_ai.response.text",
      serialize(response, config.maxAttributeLength),
    );
  }
  turnSpan.end(endTime);
}

export function createToolSpan(
  sentry: SentryNs,
  parentSpan: Span | null,
  toolName: string,
  input: unknown,
  config: ResolvedPluginConfig,
  startTime?: number,
): Span {
  const start = (): Span => {
    const span = sentry.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      startTime,
      ...(parentSpan ? {} : { forceTransaction: true }),
      attributes: {
        "gen_ai.tool.name": toolName,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.system": "anthropic",
      },
    });
    if (config.recordInputs && input !== undefined) {
      span.setAttribute(
        "gen_ai.tool.input",
        serialize(input, config.maxAttributeLength),
      );
    }
    return span;
  };
  if (parentSpan) {
    return sentry.withActiveSpan(parentSpan, start);
  }
  return start();
}

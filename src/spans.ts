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
      "gen_ai.provider.name": "anthropic",
      "gen_ai.system": "anthropic",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.conversation.id": sessionId,
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
  /** Unix-seconds start time of the turn, used as the chat child's startTime. */
  turnStartTime?: number;
  /** Session id, replicated onto the chat child for filter parity. */
  sessionId?: string;
}

export function closeTurnSpan(
  sentry: SentryNs,
  turnSpan: Span,
  input: CloseTurnInput,
  config: ResolvedPluginConfig,
  endTime?: number,
): void {
  const { tokens, responseModel, cost, response, turnStartTime, sessionId } = input;
  const respModel = responseModel ?? tokens.model ?? undefined;

  // Sentry's "AI Agents → Tokens Used" widget filters by op=gen_ai.chat;
  // putting tokens only on the invoke_agent root yields "No Data" in that
  // widget even though the per-span detail panel shows them correctly. The
  // canonical Sentry pattern is invoke_agent (root) → chat (child carrying
  // the LLM-call aggregate). Claude Code hooks don't expose individual API
  // calls, so we synthesize one chat child per turn that holds the rollup.
  const chatSpan = sentry.withActiveSpan(turnSpan, () =>
    sentry.startInactiveSpan({
      op: "gen_ai.chat",
      name: respModel ? `chat ${respModel}` : "chat",
      startTime: turnStartTime,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        ...(sessionId ? { "gen_ai.conversation.id": sessionId } : {}),
        ...(sessionId ? { "claude_code.session_id": sessionId } : {}),
        ...(respModel ? { "gen_ai.request.model": respModel } : {}),
        ...(respModel ? { "gen_ai.response.model": respModel } : {}),
      },
    }),
  );
  chatSpan.setAttribute("gen_ai.usage.input_tokens", tokens.inputTokens);
  chatSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
  chatSpan.setAttribute(
    "gen_ai.usage.total_tokens",
    tokens.inputTokens + tokens.outputTokens,
  );
  chatSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
  if (tokens.cacheCreationTokens) {
    // Sentry-python's canonical name for Anthropic prompt-cache writes.
    chatSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cacheCreationTokens);
  }
  if (config.recordOutputs && response) {
    chatSpan.setAttribute(
      "gen_ai.response.text",
      serialize(response, config.maxAttributeLength),
    );
  }
  chatSpan.end(endTime);

  if (respModel) {
    turnSpan.setAttribute("gen_ai.response.model", respModel);
  }
  if (cost) {
    // Sentry's manual-monitoring example pattern: a single rollup attribute
    // on the agent root. Sentry computes its own server-side gen_ai.cost.*
    // values from the token attrs on the chat child, so this rollup is
    // additive — it lets you query plugin-priced totals when the model
    // isn't in Sentry's price table.
    turnSpan.setAttribute("conversation.cost_estimate_usd", cost.totalCost);
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
  toolUseId?: string,
): Span {
  const start = (): Span => {
    const span = sentry.startInactiveSpan({
      op: "gen_ai.execute_tool",
      name: `execute_tool ${toolName}`,
      startTime,
      ...(parentSpan ? {} : { forceTransaction: true }),
      attributes: {
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.type": "function",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.system": "anthropic",
        ...(toolUseId ? { "gen_ai.tool.call.id": toolUseId } : {}),
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

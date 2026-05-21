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

export interface TurnSpans {
  /** Per-turn transaction root. Carries claude_code.* attributes and is what
   *  the Trace Explorer surfaces as one row per turn. */
  root: Span;
  /** gen_ai.invoke_agent span nested under the root. Sentry's
   *  extractGenAiSpansFromEvent only pulls descendants into the v2 standalone
   *  stream that the "AI Conversations" view reads — the root transaction
   *  itself is filtered out. Wrapping invoke_agent inside `root` is what
   *  makes it eligible for extraction and surfaces it in Conversations. */
  agent: Span;
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
): TurnSpans {
  const root = sentry.startInactiveSpan({
    op: "claude_code.turn",
    name: `turn ${turnIndex}`,
    forceTransaction: true,
    startTime,
    attributes: {
      "claude_code.session_id": sessionId,
      "claude_code.turn_index": turnIndex,
      "gen_ai.conversation.id": sessionId,
    },
  });
  applyTags(root, tags, config.tags);

  const agent = sentry.withActiveSpan(root, () =>
    sentry.startInactiveSpan({
      op: "gen_ai.invoke_agent",
      name: "invoke_agent claude-code",
      startTime,
      attributes: {
        "gen_ai.agent.name": "claude-code",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.conversation.id": sessionId,
        "claude_code.session_id": sessionId,
        "claude_code.turn_index": turnIndex,
        ...(model ? { "gen_ai.request.model": model } : {}),
      },
    }),
  );
  if (config.recordInputs && prompt) {
    const messages = serialize(
      [{ role: "user", content: prompt }],
      config.maxAttributeLength,
    );
    agent.setAttribute("gen_ai.request.messages", messages);
  }
  return { root, agent };
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
  /** Number of regular tools invoked during this turn. */
  toolCount?: number;
  /** Number of subagent (Task tool) invocations during this turn. */
  subagentCount?: number;
  /** De-duplicated list of tool names used in this turn. */
  toolsUsed?: string[];
  /** Diagnostic: why per-turn tokens were or were not extracted from transcript.
   *  See spec docs/superpowers/specs/2026-05-20-collector-self-heal-and-zero-cost-diagnostics-design.md */
  tokenExtractionStatus?: string;
  /** Original user prompt for this turn. Sentry's AI Conversations endpoint
   *  filters for spans that carry input AND output messages together, so the
   *  prompt must be mirrored onto the chat child (which already holds the
   *  response). Without this the chat span has output but no input, the
   *  agent span has input but no output, and no single span satisfies the
   *  base filter — Conversations stays empty. */
  prompt?: string | null;
}

export function closeTurnSpan(
  sentry: SentryNs,
  turnSpans: TurnSpans,
  input: CloseTurnInput,
  config: ResolvedPluginConfig,
  endTime?: number,
): void {
  const { root: rootSpan, agent: turnSpan } = turnSpans;
  const { tokens, responseModel, cost, response, turnStartTime, sessionId, toolCount, subagentCount, toolsUsed, tokenExtractionStatus, prompt } = input;
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
        "gen_ai.agent.name": "claude-code",
        ...(sessionId ? { "gen_ai.conversation.id": sessionId } : {}),
        ...(sessionId ? { "claude_code.session_id": sessionId } : {}),
        ...(respModel ? { "gen_ai.request.model": respModel } : {}),
        ...(respModel ? { "gen_ai.response.model": respModel } : {}),
      },
    }),
  );
  // Sentry schema: gen_ai.usage.input_tokens is the FULL input INCLUDING
  // cached tokens (cached is a subset). Sentry computes server-side cost as
  // (input_tokens - cached) * rate + cached * cached_rate, so input_tokens
  // MUST include cached or gen_ai.cost.* goes negative. tokens.inputTokens
  // is already the full raw sum (non-cached + cache_read + cache_write).
  chatSpan.setAttribute("gen_ai.usage.input_tokens", tokens.inputTokens);
  chatSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
  chatSpan.setAttribute(
    "gen_ai.usage.total_tokens",
    tokens.inputTokens + tokens.outputTokens,
  );
  chatSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
  if (tokens.cacheCreationTokens) {
    chatSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cacheCreationTokens);
  }
  if (tokens.reasoningTokens && tokens.reasoningTokens > 0) {
    chatSpan.setAttribute(
      "gen_ai.usage.output_tokens.reasoning",
      tokens.reasoningTokens,
    );
    if (tokens.reasoningEstimated) {
      chatSpan.setAttribute(
        "claude_code.reasoning_tokens.estimated",
        true,
      );
    }
  }
  if (config.recordInputs && prompt) {
    chatSpan.setAttribute(
      "gen_ai.request.messages",
      serialize(
        [{ role: "user", content: prompt }],
        config.maxAttributeLength,
      ),
    );
  }
  if (config.recordOutputs && response) {
    chatSpan.setAttribute(
      "gen_ai.response.text",
      serialize(response, config.maxAttributeLength),
    );
  }
  if (tokenExtractionStatus) {
    chatSpan.setAttribute(
      "claude_code.token_extraction.status",
      tokenExtractionStatus,
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
  // Per-turn rollups: useful for "which turns are tool-heavy" / "which turns
  // spawned subagents" without having to fan out into every child span.
  if (typeof toolCount === "number") {
    turnSpan.setAttribute("claude_code.turn.tool_count", toolCount);
  }
  if (typeof subagentCount === "number") {
    turnSpan.setAttribute("claude_code.turn.subagent_count", subagentCount);
  }
  if (toolsUsed && toolsUsed.length) {
    // Comma-joined string — Sentry attribute values must be primitive.
    turnSpan.setAttribute("claude_code.turn.tools_used", toolsUsed.join(","));
  }
  // Mirror per-turn rollups onto the transaction root so Trace Explorer
  // surfaces them on the row, not buried in the invoke_agent child.
  if (typeof toolCount === "number") {
    rootSpan.setAttribute("claude_code.turn.tool_count", toolCount);
  }
  if (typeof subagentCount === "number") {
    rootSpan.setAttribute("claude_code.turn.subagent_count", subagentCount);
  }
  if (toolsUsed && toolsUsed.length) {
    rootSpan.setAttribute("claude_code.turn.tools_used", toolsUsed.join(","));
  }
  if (cost) {
    rootSpan.setAttribute("conversation.cost_estimate_usd", cost.totalCost);
  }
  turnSpan.end(endTime);
  rootSpan.end(endTime);
}

export function createToolSpan(
  sentry: SentryNs,
  parentSpan: Span | null,
  toolName: string,
  input: unknown,
  config: ResolvedPluginConfig,
  startTime?: number,
  toolUseId?: string,
  sessionId?: string,
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
        ...(sessionId ? { "gen_ai.conversation.id": sessionId } : {}),
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

import { serialize } from "./serialize.js";
function applyTags(span, tags, userTags) {
    for (const [k, v] of Object.entries(tags)) {
        if (v !== undefined && v !== null)
            span.setAttribute(k, v);
    }
    for (const [k, v] of Object.entries(userTags)) {
        if (v !== undefined && v !== null)
            span.setAttribute(k, v);
    }
}
export function openTurnTransaction(sentry, sessionId, turnIndex, prompt, tags, config, model, startTime) {
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
    const agent = sentry.withActiveSpan(root, () => sentry.startInactiveSpan({
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
    }));
    if (config.recordInputs && prompt) {
        const messages = serialize([{ role: "user", content: prompt }], config.maxAttributeLength);
        agent.setAttribute("gen_ai.input.messages", messages);
    }
    return { root, agent };
}
export function closeTurnSpan(sentry, turnSpans, input, config, endTime) {
    const { root: rootSpan, agent: turnSpan } = turnSpans;
    const { tokens, responseModel, cost, response, responses, turnStartTime, sessionId, toolCount, subagentCount, toolsUsed, tokenExtractionStatus, prompt } = input;
    const respModel = responseModel ?? tokens.model ?? undefined;
    // Sentry's "AI Agents → Tokens Used" widget filters by op=gen_ai.chat;
    // putting tokens only on the invoke_agent root yields "No Data" in that
    // widget even though the per-span detail panel shows them correctly. The
    // canonical Sentry pattern is invoke_agent (root) → chat (child carrying
    // the LLM-call aggregate). Claude Code hooks don't expose individual API
    // calls, so we synthesize one chat child per turn that holds the rollup.
    const chatSpan = sentry.withActiveSpan(turnSpan, () => sentry.startInactiveSpan({
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
    }));
    // Sentry schema: gen_ai.usage.input_tokens is the FULL input INCLUDING
    // cached tokens (cached is a subset). Sentry computes server-side cost as
    // (input_tokens - cached) * rate + cached * cached_rate, so input_tokens
    // MUST include cached or gen_ai.cost.* goes negative. tokens.inputTokens
    // is already the full raw sum (non-cached + cache_read + cache_write).
    chatSpan.setAttribute("gen_ai.usage.input_tokens", tokens.inputTokens);
    chatSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
    chatSpan.setAttribute("gen_ai.usage.total_tokens", tokens.inputTokens + tokens.outputTokens);
    chatSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
    if (tokens.cacheCreationTokens) {
        chatSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cacheCreationTokens);
    }
    if (tokens.reasoningTokens && tokens.reasoningTokens > 0) {
        chatSpan.setAttribute("gen_ai.usage.output_tokens.reasoning", tokens.reasoningTokens);
        if (tokens.reasoningEstimated) {
            chatSpan.setAttribute("claude_code.reasoning_tokens.estimated", true);
        }
    }
    if (config.recordInputs && prompt) {
        chatSpan.setAttribute("gen_ai.input.messages", serialize([{ role: "user", content: prompt }], config.maxAttributeLength));
    }
    if (config.recordOutputs) {
        // Prefer one entry per assistant API completion — a tool-using turn
        // (text → tool_use → text) lands as multiple completions in the
        // transcript, and Sentry AI Conversations renders each entry as its own
        // bubble. Collapsing them into one joined-string entry hides every text
        // after the first newline.
        const messages = responses && responses.length > 0
            ? responses.map((content) => ({ role: "assistant", content }))
            : response
                ? [{ role: "assistant", content: response }]
                : null;
        if (messages) {
            chatSpan.setAttribute("gen_ai.output.messages", serialize(messages, config.maxAttributeLength));
        }
    }
    if (tokenExtractionStatus) {
        chatSpan.setAttribute("claude_code.usage_extraction.status", tokenExtractionStatus);
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
export function createToolSpan(sentry, parentSpan, toolName, input, config, startTime, toolUseId, sessionId) {
    const start = () => {
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
            span.setAttribute("gen_ai.tool.input", serialize(input, config.maxAttributeLength));
        }
        return span;
    };
    if (parentSpan) {
        return sentry.withActiveSpan(parentSpan, start);
    }
    return start();
}

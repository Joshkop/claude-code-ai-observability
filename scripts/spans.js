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
        const messages = serialize([{ role: "user", content: prompt }], config.maxAttributeLength);
        span.setAttribute("gen_ai.request.messages", messages);
    }
    return span;
}
export function closeTurnSpan(turnSpan, input, config, endTime) {
    const { tokens, responseModel, cost, response } = input;
    turnSpan.setAttribute("gen_ai.usage.input_tokens", tokens.inputTokens);
    turnSpan.setAttribute("gen_ai.usage.output_tokens", tokens.outputTokens);
    turnSpan.setAttribute("gen_ai.usage.total_tokens", tokens.inputTokens + tokens.outputTokens);
    turnSpan.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cachedInputTokens);
    if (tokens.cacheCreationTokens) {
        // Sentry-python's canonical attribute name for Anthropic prompt-cache
        // writes. Sentry-javascript also accepts the alias `cache_creation_input_tokens`.
        turnSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", tokens.cacheCreationTokens);
    }
    const respModel = responseModel ?? tokens.model ?? undefined;
    if (respModel) {
        turnSpan.setAttribute("gen_ai.response.model", respModel);
    }
    if (cost) {
        // Sentry's manual-monitoring example uses a single rollup attr that the
        // Insights dashboard surfaces. Per-bucket costs are not a Sentry convention
        // and Sentry computes its own totals server-side from the token attrs.
        turnSpan.setAttribute("conversation.cost_estimate_usd", cost.totalCost);
    }
    if (config.recordOutputs && response) {
        turnSpan.setAttribute("gen_ai.response.text", serialize(response, config.maxAttributeLength));
    }
    turnSpan.end(endTime);
}
export function createToolSpan(sentry, parentSpan, toolName, input, config, startTime, toolUseId) {
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

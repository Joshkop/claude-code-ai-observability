import type * as Sentry from "@sentry/node";
import type { TurnTokens, AutoTags, ResolvedPluginConfig } from "./types.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

export function createRootSpan(
  sessionId: string,
  tags: AutoTags,
  config: ResolvedPluginConfig,
  startTime?: number,
): Span {
  throw new Error("not implemented");
}

export function openTurnSpan(
  rootSpan: Span,
  prompt: string | null,
  config: ResolvedPluginConfig,
  startTime?: number,
): Span {
  throw new Error("not implemented");
}

export function closeTurnSpan(
  turnSpan: Span,
  tokens: TurnTokens,
  config: ResolvedPluginConfig,
  endTime?: number,
): void {
  throw new Error("not implemented");
}

export function createToolSpan(
  parentSpan: Span,
  toolName: string,
  input: unknown,
  config: ResolvedPluginConfig,
  startTime?: number,
): Span {
  throw new Error("not implemented");
}

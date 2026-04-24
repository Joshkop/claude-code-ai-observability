import type * as Sentry from "@sentry/node";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

export function createSubagentSpan(
  parentSpan: Span,
  taskInput: unknown,
  startTime?: number,
): Span {
  throw new Error("not implemented");
}

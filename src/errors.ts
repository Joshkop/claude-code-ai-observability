import type * as Sentry from "@sentry/node";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;

export function markSpanError(span: Span, message: string): void {
  throw new Error("not implemented");
}

import type * as Sentry from "@sentry/node";
import type { PostToolUseEvent } from "./types.js";
import { scrubString } from "./serialize.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;
type SentryLike = typeof Sentry;

const ERROR_MESSAGE_LIMIT = 1024;

export function applyToolError(span: Span | null | undefined, event: PostToolUseEvent): void {
  if (!span) return;
  trySetStatus(span, { code: 2, message: "tool_error" });
  trySetAttribute(span, "gen_ai.tool.error", true);
  const msg = coerceMessage(event.tool_response, ERROR_MESSAGE_LIMIT);
  if (msg) trySetAttribute(span, "gen_ai.tool.error.message", msg);
}

export interface BreadcrumbInput {
  event: PostToolUseEvent;
  session?: { sessionId?: string; sessionName?: string };
}

export function captureBreadcrumb(sentry: SentryLike, input: BreadcrumbInput): void {
  const fn = (sentry as unknown as {
    addBreadcrumb?: (b: unknown) => void;
  }).addBreadcrumb;
  if (typeof fn !== "function") return;

  const data: Record<string, unknown> = {
    tool_name: input.event.tool_name,
  };
  if (input.event.tool_use_id) data.tool_use_id = input.event.tool_use_id;
  if (input.session?.sessionId) data["claude_code.session_id"] = input.session.sessionId;
  if (input.session?.sessionName) data["claude_code.session_name"] = input.session.sessionName;
  const msg = coerceMessage(input.event.tool_response, 256);
  if (msg) data.message = msg;

  try {
    fn.call(sentry, {
      category: "gen_ai.tool",
      level: "error",
      message: `tool_error: ${input.event.tool_name}`,
      data,
    });
  } catch {
    /* ignore */
  }
}

function coerceMessage(value: unknown, max: number): string | null {
  if (value == null) return null;
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (!s) return null;
  return scrubString(s.length <= max ? s : s.slice(0, max) + "…");
}

function trySetStatus(span: Span, status: { code: number; message: string }): void {
  const fn = (span as unknown as { setStatus?: (s: unknown) => void }).setStatus;
  if (typeof fn === "function") {
    try {
      fn.call(span, status);
    } catch {
      /* ignore */
    }
  }
}

function trySetAttribute(span: Span, key: string, value: unknown): void {
  const fn = (span as unknown as { setAttribute?: (k: string, v: unknown) => void }).setAttribute;
  if (typeof fn === "function") {
    try {
      fn.call(span, key, value);
    } catch {
      /* ignore */
    }
  }
}

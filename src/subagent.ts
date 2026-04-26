import type * as Sentry from "@sentry/node";
import type { HookEvent, PreToolUseEvent, PostToolUseEvent } from "./types.js";
import { scrubString } from "./serialize.js";

type Span = ReturnType<typeof Sentry.startInactiveSpan>;
type SentryLike = typeof Sentry;

interface ActiveSubagent {
  span: Span;
  subagentType: string;
  toolUseId?: string;
}

export interface SubagentSession {
  active: Map<string, ActiveSubagent>;
}

export interface CreateSubagentSpanOptions {
  parent?: Span;
  maxAttrLen?: number;
}

export function createSubagentSession(): SubagentSession {
  return { active: new Map() };
}

export function isSubagentInvocation(event: HookEvent | undefined | null): boolean {
  if (!event) return false;
  if (event.hook_event_name !== "PreToolUse" && event.hook_event_name !== "PostToolUse") {
    return false;
  }
  return (event as PreToolUseEvent | PostToolUseEvent).tool_name === "Task";
}

export function createSubagentSpan(
  sentry: SentryLike,
  event: PreToolUseEvent,
  options: CreateSubagentSpanOptions = {},
): Span | null {
  const maxAttrLen = options.maxAttrLen ?? 12000;
  const { subagentType, prompt, description } = readTaskInput(event.tool_input);

  const name = `invoke_agent ${subagentType ?? "subagent"}`;
  const attributes: Record<string, string> = {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.system": "anthropic",
    "gen_ai.operation.name": "invoke_agent",
  };
  if (subagentType) attributes["gen_ai.agent.name"] = subagentType;
  if (description) attributes["gen_ai.agent.description"] = scrubString(truncate(description, maxAttrLen));
  if (prompt) attributes["gen_ai.request.messages"] = scrubString(truncate(prompt, maxAttrLen));
  if (event.tool_use_id) attributes["gen_ai.tool.call.id"] = event.tool_use_id;

  const startSpan = (sentry as unknown as {
    startInactiveSpan?: (opts: unknown) => Span;
  }).startInactiveSpan;
  if (typeof startSpan !== "function") return null;

  try {
    return startSpan.call(sentry, {
      name,
      op: "gen_ai.invoke_agent",
      attributes,
      ...(options.parent ? { parentSpan: options.parent } : {}),
    });
  } catch {
    return null;
  }
}

export function attachSubagentToEvent(
  sentry: SentryLike,
  session: SubagentSession,
  event: HookEvent,
  options: { parent?: Span; maxAttrLen?: number } = {},
): boolean {
  if (!isSubagentInvocation(event)) return false;

  if (event.hook_event_name === "PreToolUse") {
    const pre = event as PreToolUseEvent;
    const span = createSubagentSpan(sentry, pre, options);
    if (!span) return true;
    const key = pre.tool_use_id ?? `${pre.session_id}:${session.active.size}`;
    const { subagentType } = readTaskInput(pre.tool_input);
    session.active.set(key, {
      span,
      subagentType: subagentType ?? "subagent",
      toolUseId: pre.tool_use_id,
    });
    return true;
  }

  if (event.hook_event_name === "PostToolUse") {
    const post = event as PostToolUseEvent;
    const key = post.tool_use_id ?? findFirstKey(session.active);
    if (!key) return true;
    const entry = session.active.get(key);
    if (!entry) return true;
    session.active.delete(key);

    if (post.tool_error) {
      trySetStatus(entry.span, "internal_error");
      trySetAttribute(entry.span, "gen_ai.tool.error", true);
      const msg = coerceErrorMessage(post.tool_response, options.maxAttrLen ?? 1024);
      if (msg) trySetAttribute(entry.span, "gen_ai.tool.error.message", msg);
    } else {
      trySetStatus(entry.span, "ok");
    }
    tryEnd(entry.span);
    return true;
  }

  return false;
}

function readTaskInput(input: unknown): {
  subagentType?: string;
  prompt?: string;
  description?: string;
} {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  return {
    subagentType: typeof o.subagent_type === "string" ? o.subagent_type : undefined,
    prompt: typeof o.prompt === "string" ? o.prompt : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
  };
}

function truncate(s: string, max: number): string {
  if (typeof s !== "string") return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function coerceErrorMessage(value: unknown, max: number): string | null {
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
  return scrubString(truncate(s, max));
}

function findFirstKey(m: Map<string, unknown>): string | undefined {
  const it = m.keys().next();
  return it.done ? undefined : it.value;
}

function trySetStatus(span: Span, status: string): void {
  const fn = (span as unknown as { setStatus?: (s: unknown) => void }).setStatus;
  if (typeof fn === "function") {
    try {
      fn.call(span, { code: status === "ok" ? 1 : 2, message: status });
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

function tryEnd(span: Span): void {
  const fn = (span as unknown as { end?: () => void }).end;
  if (typeof fn === "function") {
    try {
      fn.call(span);
    } catch {
      /* ignore */
    }
  }
}

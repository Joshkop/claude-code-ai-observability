import type * as Sentry from "@sentry/node";

type SentryLike = typeof Sentry;

/**
 * Forward a plugin-internal error into Sentry as an event tagged
 * `claude_code.plugin_error: true`. Lets users debug "why aren't traces
 * showing up?" inside the very Sentry project they configured the DSN for —
 * no extra tooling required.
 *
 * Always swallows its own exceptions: error reporting must never escalate
 * the original failure into Claude Code itself.
 */
export function reportPluginError(
  sentry: SentryLike,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    const fn = (sentry as unknown as {
      captureException?: (e: unknown, hint?: unknown) => void;
    }).captureException;
    if (typeof fn !== "function") return;
    fn.call(sentry, err, {
      mechanism: { type: "claude_code_ai_observability", handled: true },
      tags: { "claude_code.plugin_error": "true" },
      extra: context ?? {},
    });
  } catch {
    /* never throw from the error reporter */
  }
}

/** Lower-severity counterpart for non-exceptional warnings (e.g. dropped event). */
export function reportPluginMessage(
  sentry: SentryLike,
  message: string,
  level: "info" | "warning" | "error" = "warning",
  context?: Record<string, unknown>,
): void {
  try {
    const fn = (sentry as unknown as {
      captureMessage?: (m: string, hint?: unknown) => void;
    }).captureMessage;
    if (typeof fn !== "function") return;
    fn.call(sentry, message, {
      level,
      tags: { "claude_code.plugin_error": "true" },
      extra: context ?? {},
    });
  } catch {
    /* ignore */
  }
}

/**
 * Install process-level error handlers that route uncaught exceptions and
 * unhandled rejections into Sentry before the collector dies. Without this,
 * a crash in the collector child process leaves zero diagnostic trail in
 * Sentry — only a stale `~/.cache/.../collector.err.log` line.
 */
export function installGlobalHandlers(sentry: SentryLike): void {
  process.on("uncaughtException", (err) => {
    reportPluginError(sentry, err, { source: "uncaughtException" });
    try {
      const flush = (sentry as unknown as { flush?: (n: number) => Promise<unknown> }).flush;
      if (typeof flush === "function") void flush.call(sentry, 2000);
    } catch { /* ignore */ }
  });
  process.on("unhandledRejection", (reason) => {
    reportPluginError(sentry, reason, { source: "unhandledRejection" });
  });
}

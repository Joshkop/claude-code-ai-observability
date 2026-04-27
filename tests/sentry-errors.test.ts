import { describe, expect, it, vi } from "vitest";
import { reportPluginError, reportPluginMessage } from "../src/sentry-errors.js";

function makeFakeSentry() {
  return {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
}

describe("reportPluginError", () => {
  it("calls captureException with claude_code.plugin_error tag and extra context", () => {
    const sentry = makeFakeSentry();
    const err = new Error("boom");
    reportPluginError(sentry as never, err, { hook_event_name: "PreToolUse" });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [reportedErr, hint] = sentry.captureException.mock.calls[0];
    expect(reportedErr).toBe(err);
    expect(hint.tags["claude_code.plugin_error"]).toBe("true");
    expect(hint.extra.hook_event_name).toBe("PreToolUse");
    expect(hint.mechanism.type).toBe("claude_code_ai_observability");
  });

  it("swallows captureException throws without re-raising", () => {
    const sentry = {
      captureException: vi.fn(() => {
        throw new Error("sentry init failed");
      }),
    };
    expect(() => reportPluginError(sentry as never, new Error("x"))).not.toThrow();
  });

  it("is a no-op when sentry has no captureException method", () => {
    const sentry = {};
    expect(() => reportPluginError(sentry as never, new Error("x"))).not.toThrow();
  });
});

describe("reportPluginMessage", () => {
  it("forwards level to captureMessage", () => {
    const sentry = makeFakeSentry();
    reportPluginMessage(sentry as never, "stale collector", "warning");
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      "stale collector",
      expect.objectContaining({ level: "warning" }),
    );
  });
});

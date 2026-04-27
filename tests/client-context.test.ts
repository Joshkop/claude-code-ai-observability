import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClientContext, _resetClientContextCache } from "../src/client-context.js";

const ENV_KEYS = [
  "CLAUDE_SESSION_NAME",
  "CLAUDE_PARENT_SESSION_ID",
  "CLAUDE_PARENT_AGENT_NAME",
  "TMUX",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "TERM_PROGRAM",
  "WEZTERM_PANE",
  "KITTY_WINDOW_ID",
  "ITERM_SESSION_ID",
  "WT_SESSION",
  "VSCODE_PID",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  _resetClientContextCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetClientContextCache();
});

describe("detectClientContext", () => {
  it("prefers CLAUDE_SESSION_NAME over tmux/screen", () => {
    process.env.CLAUDE_SESSION_NAME = "my-explicit-session";
    process.env.TMUX = "/tmp/tmux-1000/default,1,0";
    const ctx = detectClientContext();
    expect(ctx.session_name).toBe("my-explicit-session");
  });

  it("falls back to screen STY when present and tmux is not", () => {
    process.env.STY = "12345.my-screen-session";
    const ctx = detectClientContext();
    expect(ctx.session_name).toBe("my-screen-session");
  });

  it("captures parent session linkage from env", () => {
    process.env.CLAUDE_PARENT_SESSION_ID = "parent-uuid";
    process.env.CLAUDE_PARENT_AGENT_NAME = "executor";
    const ctx = detectClientContext();
    expect(ctx.parent_session_id).toBe("parent-uuid");
    expect(ctx.parent_agent_name).toBe("executor");
  });

  it("always populates cwd, ppid, and captured_at_ms", () => {
    const ctx = detectClientContext();
    expect(typeof ctx.cwd).toBe("string");
    expect(typeof ctx.ppid).toBe("number");
    expect(typeof ctx.captured_at_ms).toBe("number");
  });

  it("uses ZELLIJ_SESSION_NAME without forking", () => {
    process.env.ZELLIJ_SESSION_NAME = "my-zellij-session";
    process.env.ZELLIJ = "0.39.2";
    const ctx = detectClientContext();
    expect(ctx.session_name).toBe("my-zellij-session");
    expect(ctx.terminal_program).toBe("zellij");
  });

  it("captures opaque terminal_session_id for unnamed terminals", () => {
    process.env.WT_SESSION = "abcd-1234-windows-terminal";
    process.env.TERM_PROGRAM = "WindowsTerminal";
    const ctx = detectClientContext();
    expect(ctx.session_name).toBeUndefined(); // no named session
    expect(ctx.terminal_program).toBe("WindowsTerminal");
    expect(ctx.terminal_session_id).toBe("abcd-1234-windows-terminal");
  });

  it("respects iTerm2 / WezTerm / kitty pane ids in priority order", () => {
    process.env.ITERM_SESSION_ID = "iterm-id";
    process.env.WEZTERM_PANE = "wez-id";
    const ctx = detectClientContext();
    expect(ctx.terminal_session_id).toBe("iterm-id"); // ITERM beats WezTerm
  });

  it("caches per process — second call is byte-identical", () => {
    process.env.CLAUDE_SESSION_NAME = "first";
    const a = detectClientContext();
    process.env.CLAUDE_SESSION_NAME = "second"; // changed env
    const b = detectClientContext();
    // Cached: still "first", proves we didn't re-read env on second call.
    expect(b.session_name).toBe("first");
    expect(a).toBe(b);
  });
});

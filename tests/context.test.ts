import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(new Error("not found"), "");
    return {};
  }),
}));

import { detectContext } from "../src/context.js";

describe("detectContext (smoke)", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_SESSION_NAME;
    delete process.env.TMUX_PANE;
    delete process.env.STY;
    delete process.env.CLAUDE_CODE_VERSION;
  });

  it("does not throw when git and tmux are absent", async () => {
    await expect(detectContext("test-session-id")).resolves.not.toThrow();
  });

  it("always includes claude_code.session_id", async () => {
    const tags = await detectContext("my-session-123");
    expect(tags["claude_code.session_id"]).toBe("my-session-123");
  });

  it("always includes host.name", async () => {
    const tags = await detectContext("s1");
    expect(typeof tags["host.name"]).toBe("string");
    expect(tags["host.name"]!.length).toBeGreaterThan(0);
  });

  it("always includes os.type", async () => {
    const tags = await detectContext("s1");
    expect(typeof tags["os.type"]).toBe("string");
  });

  it("always includes process.cwd", async () => {
    const tags = await detectContext("s1");
    expect(typeof tags["process.cwd"]).toBe("string");
  });

  it("always includes process.pid", async () => {
    const tags = await detectContext("s1");
    expect(typeof tags["process.pid"]).toBe("number");
  });

  it("gracefully omits vcs tags when git fails", async () => {
    const tags = await detectContext("s1");
    // These should be undefined (not throw)
    expect(tags["vcs.repository.name"]).toBeUndefined();
    expect(tags["vcs.ref.head.name"]).toBeUndefined();
    expect(tags["vcs.ref.head.revision"]).toBeUndefined();
  });

  it("reads CLAUDE_SESSION_NAME from env", async () => {
    process.env.CLAUDE_SESSION_NAME = "my-tmux-session";
    const tags = await detectContext("s1");
    expect(tags["claude_code.session_name"]).toBe("my-tmux-session");
  });

  it("reads CLAUDE_CODE_VERSION from env", async () => {
    process.env.CLAUDE_CODE_VERSION = "1.2.3";
    const tags = await detectContext("s1");
    expect(tags["claude_code.version"]).toBe("1.2.3");
  });
});

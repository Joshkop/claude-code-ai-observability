import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect homedir to /tmp/nonexistent so loadConfig never finds the real user config
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  return { ...real, homedir: () => "/tmp/__aiobs_fake_home__" };
});

const ENV_KEYS = [
  "CLAUDE_SENTRY_DSN", "SENTRY_DSN", "CLAUDE_SENTRY_CONFIG",
  "CLAUDE_SENTRY_TRACES_SAMPLE_RATE", "CLAUDE_SENTRY_RECORD_INPUTS",
  "CLAUDE_SENTRY_RECORD_OUTPUTS", "CLAUDE_SENTRY_MAX_ATTRIBUTE_LENGTH",
  "CLAUDE_SENTRY_DEBUG", "CLAUDE_SENTRY_TAGS", "CLAUDE_SENTRY_ENVIRONMENT",
  "SENTRY_ENVIRONMENT", "CLAUDE_SENTRY_RELEASE", "SENTRY_RELEASE",
];

function saveEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe("loadConfig", () => {
  let savedEnv: Record<string, string | undefined>;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    for (const f of tmpFiles.splice(0)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it("returns null when no DSN is set", async () => {
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result).toBeNull();
  });

  it("reads DSN from CLAUDE_SENTRY_DSN env", async () => {
    process.env.CLAUDE_SENTRY_DSN = "https://key@sentry.io/123";
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result).not.toBeNull();
    expect(result!.dsn).toBe("https://key@sentry.io/123");
  });

  it("reads DSN from SENTRY_DSN env fallback", async () => {
    process.env.SENTRY_DSN = "https://key2@sentry.io/456";
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result!.dsn).toBe("https://key2@sentry.io/456");
  });

  it("reads config from CLAUDE_SENTRY_CONFIG path", async () => {
    const p = join(tmpdir(), `aiobs-config-${Date.now()}.json`);
    tmpFiles.push(p);
    writeFileSync(p, JSON.stringify({ dsn: "https://fromfile@sentry.io/1", debug: true }), "utf8");
    process.env.CLAUDE_SENTRY_CONFIG = p;
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result!.dsn).toBe("https://fromfile@sentry.io/1");
    expect(result!.debug).toBe(true);
  });

  it("env CLAUDE_SENTRY_DEBUG overrides file config", async () => {
    const p = join(tmpdir(), `aiobs-config-${Date.now()}.json`);
    tmpFiles.push(p);
    writeFileSync(p, JSON.stringify({ dsn: "https://x@sentry.io/1", debug: false }), "utf8");
    process.env.CLAUDE_SENTRY_CONFIG = p;
    process.env.CLAUDE_SENTRY_DEBUG = "true";
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result!.debug).toBe(true);
  });

  it("env CLAUDE_SENTRY_RECORD_INPUTS=false overrides default", async () => {
    process.env.CLAUDE_SENTRY_DSN = "https://key@sentry.io/1";
    process.env.CLAUDE_SENTRY_RECORD_INPUTS = "false";
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result!.recordInputs).toBe(false);
  });

  it("applies defaults for missing optional fields", async () => {
    process.env.CLAUDE_SENTRY_DSN = "https://key@sentry.io/1";
    const { loadConfig } = await import("../src/config.js");
    const result = await loadConfig();
    expect(result!.tracesSampleRate).toBe(1);
    expect(result!.recordInputs).toBe(true);
    expect(result!.recordOutputs).toBe(true);
    expect(result!.maxAttributeLength).toBe(12000);
    expect(result!.debug).toBe(false);
  });

  it("resolveDefaults merges tags correctly", async () => {
    const { resolveDefaults } = await import("../src/config.js");
    const resolved = resolveDefaults({ dsn: "https://x@s.io/1", tags: { env: "prod" } });
    expect(resolved.tags).toEqual({ env: "prod" });
  });
});

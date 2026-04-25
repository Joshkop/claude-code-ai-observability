/**
 * Tests for new v0.1.2 HTTP endpoint behaviors and PID-file lifecycle.
 *
 * Covers:
 *   - GET /health returns JSON { ok, pid, port, version, startedAt, sessions }
 *   - GET /version returns JSON { version }
 *   - PID file is written on listen and removed on shutdown
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import type { AutoTags, ResolvedPluginConfig } from "../src/types.js";
import { CACHE_DIR, PID_FILE, PLUGIN_VERSION } from "../src/plugin-meta.js";

// ---------------------------------------------------------------------------
// Fake Sentry
// ---------------------------------------------------------------------------
function makeFakeSentry() {
  return {
    startInactiveSpan(opts: {
      op?: string;
      name?: string;
      attributes?: Record<string, unknown>;
      forceTransaction?: boolean;
    }) {
      return {
        setAttribute(_k: string, _v: unknown) {},
        setStatus() {},
        end() {},
      };
    },
    withActiveSpan<T>(_parent: unknown, fn: () => T): T {
      return fn();
    },
    flush: async () => true,
  };
}

const baseConfig: ResolvedPluginConfig = {
  dsn: "https://key@sentry.io/1",
  tracesSampleRate: 1,
  debug: false,
  recordInputs: false,
  recordOutputs: false,
  maxAttributeLength: 12000,
  tags: {},
};

const baseTags: AutoTags = {
  "host.name": "testhost",
  "os.type": "linux",
};

// ---------------------------------------------------------------------------
// Port helper (same as existing tests)
// ---------------------------------------------------------------------------
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("no port"));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForServer(port: number, maxMs = 2000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("server did not start in time");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function removePidFileIfExists(): void {
  try { unlinkSync(PID_FILE); } catch { /* already absent */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("GET /health returns structured JSON", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    removePidFileIfExists();
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const server = startServer(makeFakeSentry() as never, baseConfig, baseTags);
    close = server.close;
    await waitForServer(port);
  });

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
    removePidFileIfExists();
  });

  it("returns HTTP 200 with Content-Type application/json", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("response body includes ok: true", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("response body includes pid matching process.pid", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.pid).toBe(process.pid);
  });

  it("response body includes port matching the listening port", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.port).toBe(port);
  });

  it("response body includes version matching PLUGIN_VERSION", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe(PLUGIN_VERSION);
  });

  it("response body includes startedAt as a positive number", async () => {
    const before = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.startedAt).toBe("number");
    expect(body.startedAt as number).toBeGreaterThan(before - 5000);
    expect(body.startedAt as number).toBeLessThanOrEqual(Date.now());
  });

  it("response body includes sessions count as a non-negative integer", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.sessions).toBe("number");
    expect(body.sessions as number).toBeGreaterThanOrEqual(0);
  });

  it("sessions count increments after a SessionStart event", async () => {
    // Send a SessionStart to create a session record.
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-health-1" }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessions as number).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe("GET /version returns { version }", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    removePidFileIfExists();
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const server = startServer(makeFakeSentry() as never, baseConfig, baseTags);
    close = server.close;
    await waitForServer(port);
  });

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
    removePidFileIfExists();
  });

  it("returns HTTP 200 with Content-Type application/json", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns an object with a version field matching PLUGIN_VERSION", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/version`);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("version");
    expect(body.version).toBe(PLUGIN_VERSION);
  });

  it("does not include extra fields beyond version", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/version`);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["version"]);
  });
});

// ---------------------------------------------------------------------------

describe("PID file lifecycle", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    removePidFileIfExists();
    port = await findFreePort();
    process.env.SENTRY_COLLECTOR_PORT = String(port);
    const server = startServer(makeFakeSentry() as never, baseConfig, baseTags);
    close = server.close;
    await waitForServer(port);
  });

  afterEach(async () => {
    await close();
    delete process.env.SENTRY_COLLECTOR_PORT;
    removePidFileIfExists();
  });

  it("creates the PID file once the server is listening", () => {
    expect(existsSync(PID_FILE)).toBe(true);
  });

  it("PID file contains valid JSON with pid, port, version, startedAt fields", () => {
    const raw = readFileSync(PID_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof data.pid).toBe("number");
    expect(typeof data.port).toBe("number");
    expect(typeof data.version).toBe("string");
    expect(typeof data.startedAt).toBe("number");
  });

  it("PID file pid matches process.pid", () => {
    const raw = readFileSync(PID_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.pid).toBe(process.pid);
  });

  it("PID file port matches the listening port", () => {
    const raw = readFileSync(PID_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.port).toBe(port);
  });

  it("PID file version matches PLUGIN_VERSION", () => {
    const raw = readFileSync(PID_FILE, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.version).toBe(PLUGIN_VERSION);
  });

  it("removes the PID file after shutdown", async () => {
    expect(existsSync(PID_FILE)).toBe(true);
    await close();
    // Prevent double-close in afterEach
    close = async () => {};
    expect(existsSync(PID_FILE)).toBe(false);
  });
});

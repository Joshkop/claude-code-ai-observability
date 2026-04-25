/**
 * Unit tests for hook-client helper functions.
 *
 * Covers:
 *   - probeHealth: legacy "ok" plain-text response handling and JSON parsing
 *   - readPidFile: tolerates missing file, malformed JSON, and structurally
 *     invalid data; returns correct data when the file is well-formed
 *
 * We do NOT test the spawn path (ensureServerRunning) to avoid child-process
 * side effects in tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { probeHealth, readPidFile } from "../src/hook-client.js";
import { PID_FILE, CACHE_DIR, PLUGIN_VERSION } from "../src/plugin-meta.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function removePidFileIfExists(): void {
  try { unlinkSync(PID_FILE); } catch { /* already absent */ }
}

function writePidFileContent(content: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(PID_FILE, content, "utf8");
}

/** Start a minimal HTTP server that responds with a fixed body. */
async function startFakeServer(
  responseBody: string,
  contentType = "text/plain",
): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = createServer((_req, res) => {
      res.setHeader("Content-Type", contentType);
      res.end(responseBody);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") {
        srv.close();
        reject(new Error("no address"));
        return;
      }
      resolve({
        port: addr.port,
        stop: () => new Promise<void>((res) => srv.close(() => res())),
      });
    });
    srv.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// probeHealth tests
// ---------------------------------------------------------------------------
describe("probeHealth: legacy plain-text 'ok' response", () => {
  let port: number;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    ({ port, stop } = await startFakeServer("ok", "text/plain"));
  });

  afterEach(async () => {
    await stop();
  });

  it("returns { ok: true } when body is the string 'ok'", async () => {
    const result = await probeHealth(port, 1000);
    expect(result).toEqual({ ok: true });
  });

  it("returned object has no version field (legacy means version-less)", async () => {
    const result = await probeHealth(port, 1000);
    expect(result?.version).toBeUndefined();
  });
});

describe("probeHealth: JSON response parsing", () => {
  let port: number;
  let stop: () => Promise<void>;

  afterEach(async () => {
    await stop();
  });

  it("parses a well-formed JSON health response and returns the object", async () => {
    const payload = JSON.stringify({
      ok: true,
      pid: 12345,
      port: 19877,
      version: PLUGIN_VERSION,
      startedAt: 1700000000000,
      sessions: 2,
    });
    ({ port, stop } = await startFakeServer(payload, "application/json"));
    const result = await probeHealth(port, 1000);
    expect(result).toBeTruthy();
    expect(result?.ok).toBe(true);
    expect(result?.version).toBe(PLUGIN_VERSION);
    expect(result?.pid).toBe(12345);
    expect(result?.sessions).toBe(2);
  });

  it("returns null when the server responds with a non-200 status", async () => {
    // A server that responds 500 — probeHealth checks res.ok.
    const srv = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("error");
    });
    await new Promise<void>((resolve, reject) => {
      srv.listen(0, "127.0.0.1", () => resolve());
      srv.on("error", reject);
    });
    const addr = srv.address() as { port: number };
    stop = () => new Promise<void>((res) => srv.close(() => res()));
    port = addr.port;

    const result = await probeHealth(port, 1000);
    expect(result).toBeNull();
  });

  it("flags 'occupied' when a 200-OK body is not JSON and not 'ok' (stranger holds the port)", async () => {
    ({ port, stop } = await startFakeServer("not-json-at-all", "text/plain"));
    const result = await probeHealth(port, 1000);
    expect(result).toEqual({ ok: false, occupied: true });
  });

  it("flags 'occupied' when JSON parses but lacks ok:true", async () => {
    ({ port, stop } = await startFakeServer(JSON.stringify({ evil: true }), "application/json"));
    const result = await probeHealth(port, 1000);
    expect(result).toEqual({ ok: false, occupied: true });
  });

  it("returns null when no server is listening (connection refused)", async () => {
    // Use a port that is almost certainly not in use.
    const result = await probeHealth(19876, 200);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readPidFile tests
// ---------------------------------------------------------------------------
describe("readPidFile: tolerates missing or malformed files", () => {
  beforeEach(() => {
    removePidFileIfExists();
  });

  afterEach(() => {
    removePidFileIfExists();
  });

  it("returns null when the PID file does not exist", () => {
    expect(existsSync(PID_FILE)).toBe(false);
    const result = readPidFile();
    expect(result).toBeNull();
  });

  it("returns null when the PID file contains malformed JSON", () => {
    writePidFileContent("{ this is not json }");
    const result = readPidFile();
    expect(result).toBeNull();
  });

  it("returns null when the PID file is empty", () => {
    writePidFileContent("");
    const result = readPidFile();
    expect(result).toBeNull();
  });

  it("returns null when the PID file JSON lacks a numeric pid field", () => {
    writePidFileContent(JSON.stringify({ port: 19877, version: "1.0.0", startedAt: 1700000000000 }));
    const result = readPidFile();
    expect(result).toBeNull();
  });

  it("returns null when pid is a string instead of a number", () => {
    writePidFileContent(JSON.stringify({ pid: "12345", port: 19877, version: "1.0.0", startedAt: 1700000000000 }));
    const result = readPidFile();
    expect(result).toBeNull();
  });
});

describe("readPidFile: returns correct data for a well-formed file", () => {
  const sample = {
    pid: 99999,
    port: 19877,
    version: "0.1.2",
    startedAt: 1700000000000,
  };

  beforeEach(() => {
    removePidFileIfExists();
    writePidFileContent(JSON.stringify(sample));
  });

  afterEach(() => {
    removePidFileIfExists();
  });

  it("returns an object with the correct pid", () => {
    const result = readPidFile();
    expect(result?.pid).toBe(sample.pid);
  });

  it("returns an object with the correct port", () => {
    const result = readPidFile();
    expect(result?.port).toBe(sample.port);
  });

  it("returns an object with the correct version string", () => {
    const result = readPidFile();
    expect(result?.version).toBe(sample.version);
  });

  it("returns an object with the correct startedAt timestamp", () => {
    const result = readPidFile();
    expect(result?.startedAt).toBe(sample.startedAt);
  });
});

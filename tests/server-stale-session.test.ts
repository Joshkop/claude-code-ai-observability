/**
 * Unit tests for the stale-session reaper predicate.
 *
 * The reaper timer itself runs every FLUSH_INTERVAL_MS (30 s) and cannot be
 * tested directly without time-mocking. Instead we export `isStaleSession` as
 * a pure function and verify its predicate logic here.
 */
import { describe, it, expect } from "vitest";
import { isStaleSession } from "../src/server.js";

describe("isStaleSession predicate", () => {
  it("returns false when the session was active just now", () => {
    const now = Date.now();
    const record = { lastEventAt: now };
    expect(isStaleSession(record, now, 30 * 60_000)).toBe(false);
  });

  it("returns false when idle time is exactly equal to the threshold", () => {
    const idleMs = 30 * 60_000;
    const now = Date.now();
    // Exactly at the boundary: not strictly greater, so not stale.
    const record = { lastEventAt: now - idleMs };
    expect(isStaleSession(record, now, idleMs)).toBe(false);
  });

  it("returns true when idle time exceeds the threshold by 1 ms", () => {
    const idleMs = 30 * 60_000;
    const now = Date.now();
    const record = { lastEventAt: now - idleMs - 1 };
    expect(isStaleSession(record, now, idleMs)).toBe(true);
  });

  it("returns true for a session idle for longer than the threshold", () => {
    const idleMs = 60_000; // 1 minute for this test
    const now = Date.now();
    const record = { lastEventAt: now - 2 * idleMs };
    expect(isStaleSession(record, now, idleMs)).toBe(true);
  });

  it("uses the default 30-minute threshold when idleMs is omitted", () => {
    const thirtyMinutesMs = 30 * 60_000;
    const now = Date.now();
    // Just inside the default window — not stale.
    const fresh = { lastEventAt: now - (thirtyMinutesMs - 1000) };
    expect(isStaleSession(fresh, now)).toBe(false);
    // Just outside the default window — stale.
    const stale = { lastEventAt: now - (thirtyMinutesMs + 1) };
    expect(isStaleSession(stale, now)).toBe(true);
  });
});

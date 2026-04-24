import { describe, it, expect } from "vitest";
import { serialize, scrubString } from "../src/serialize.js";

describe("scrubString — value patterns", () => {
  it("redacts Bearer tokens", () => {
    const out = scrubString("Authorization: Bearer abc.DEF-123_xyz/foo+bar=");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc.DEF-123_xyz");
  });

  it("redacts Basic auth headers", () => {
    const out = scrubString("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).toContain("Basic [REDACTED]");
    expect(out).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  it("redacts password=, token=, secret= assignments", () => {
    expect(scrubString("password=hunter2")).toContain("[REDACTED]");
    expect(scrubString("password=hunter2")).not.toContain("hunter2");
    expect(scrubString("API_KEY=abcd1234")).toContain("[REDACTED]");
    expect(scrubString('SECRET="quoted value"')).toContain("[REDACTED]");
    expect(scrubString("token: tok_alpha123")).toContain("[REDACTED]");
  });

  it("redacts userinfo from URIs", () => {
    const out = scrubString("connect to postgres://alice:s3cret@db.host:5432/db");
    expect(out).toContain("[REDACTED]:[REDACTED]@");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("s3cret");
  });

  it("redacts Stripe live keys", () => {
    expect(scrubString("sk_live_abcdef0123456789")).toContain("[REDACTED:stripe-live-key]");
    expect(scrubString("rk_live_abcdef0123456789")).toContain("[REDACTED:stripe-restricted-key]");
  });

  it("redacts modern GitHub tokens (ghu_, ghs_)", () => {
    expect(scrubString("ghu_abcdefghij1234567890")).toContain("[REDACTED:github-user]");
    expect(scrubString("ghs_abcdefghij1234567890")).toContain("[REDACTED:github-server]");
  });

  it("preserves non-secret content unchanged", () => {
    const safe = "git checkout main && npm run build";
    expect(scrubString(safe)).toBe(safe);
  });

  it("anthropic key beats generic openai key (longer pattern wins)", () => {
    // Order matters: sk-ant- must scrub first, otherwise sk- catches it as openai.
    const out = scrubString("sk-ant-foobar01234567890123456789");
    expect(out).toContain("[REDACTED:anthropic-key]");
    expect(out).not.toContain("[REDACTED:openai-key]");
  });
});

describe("serialize — combines key-based and value-based redaction", () => {
  it("redacts sensitive keys at object level", () => {
    const out = serialize({ apiKey: "anything", message: "hello" }, 1000);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("anything");
    expect(out).toContain("hello");
  });

  it("redacts secrets that appear inside non-sensitive string values", () => {
    // tool_response is a plain string like Bash output — scrubbing must apply.
    const out = serialize("logged in with Bearer abc123def456ghi789", 1000);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abc123def456ghi789");
  });

  it("truncates after redaction", () => {
    const out = serialize("x".repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(80); // 50 + truncation marker overhead
    expect(out).toContain("truncated");
  });

  it("returns plain string for primitives", () => {
    expect(serialize("hello", 100)).toBe("hello");
    expect(serialize(42, 100)).toBe("42");
  });
});

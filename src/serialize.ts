const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|passwd|authorization|cookie|session|bearer|x[-_]?api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|refresh[-_]?token|aws[-_]?secret|gh[-_]?token|github[-_]?token|slack[-_]?token|signing[-_]?key|salt|hmac|jwt|otp|pin|credential)/i;

const VALUE_SCRUB_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:anthropic-key]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:openai-key]"],
  [/sk_live_[A-Za-z0-9]{16,}/g, "[REDACTED:stripe-live-key]"],
  [/rk_live_[A-Za-z0-9]{16,}/g, "[REDACTED:stripe-restricted-key]"],
  [/ghp_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]"],
  [/gho_[A-Za-z0-9]{20,}/g, "[REDACTED:github-oauth]"],
  [/ghu_[A-Za-z0-9]{20,}/g, "[REDACTED:github-user]"],
  [/ghs_[A-Za-z0-9]{20,}/g, "[REDACTED:github-server]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key-id]"],
  [/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED:google-key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED:jwt]"],
  [/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]"],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]"],
  [/(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi, "$1[REDACTED]"],
  [/([a-z][a-z0-9+.\-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@"],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of VALUE_SCRUB_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) return "[DepthLimit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redact(nested, seen, depth + 1);
  }
  return output;
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`;
}

export function serialize(value: unknown, maxLength: number): string {
  const redacted = redact(value, new WeakSet(), 0);
  if (typeof redacted === "string") {
    return truncate(redacted, maxLength);
  }
  try {
    return truncate(JSON.stringify(redacted), maxLength);
  } catch {
    return "[Unserializable]";
  }
}

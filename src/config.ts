import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginConfig, ResolvedPluginConfig } from "./types.js";

const DEFAULTS = {
  tracesSampleRate: 1,
  debug: false,
  recordInputs: true,
  recordOutputs: true,
  maxAttributeLength: 12000,
  tags: {} as Record<string, string>,
};

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"\\])\/\/.*$/gm, "$1");
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
  if (t === "false" || t === "0" || t === "no" || t === "off") return false;
  return undefined;
}

function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseTags(v: string | undefined): Record<string, string> | undefined {
  if (!v) return undefined;
  const out: Record<string, string> = {};
  for (const pair of v.split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (k) out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export function resolveDefaults(raw: PluginConfig): ResolvedPluginConfig {
  return {
    dsn: raw.dsn,
    environment: raw.environment,
    release: raw.release,
    tracesSampleRate: raw.tracesSampleRate ?? DEFAULTS.tracesSampleRate,
    debug: raw.debug ?? DEFAULTS.debug,
    recordInputs: raw.recordInputs ?? DEFAULTS.recordInputs,
    recordOutputs: raw.recordOutputs ?? DEFAULTS.recordOutputs,
    maxAttributeLength: raw.maxAttributeLength ?? DEFAULTS.maxAttributeLength,
    tags: { ...DEFAULTS.tags, ...(raw.tags ?? {}) },
    prices: raw.prices,
  };
}

function applyEnvOverrides(raw: PluginConfig): PluginConfig {
  const env = process.env;
  const dsn = env.CLAUDE_SENTRY_DSN || env.SENTRY_DSN || raw.dsn;
  const tracesSampleRate = parseNumber(env.CLAUDE_SENTRY_TRACES_SAMPLE_RATE) ?? raw.tracesSampleRate;
  const recordInputs = parseBool(env.CLAUDE_SENTRY_RECORD_INPUTS) ?? raw.recordInputs;
  const recordOutputs = parseBool(env.CLAUDE_SENTRY_RECORD_OUTPUTS) ?? raw.recordOutputs;
  const maxAttributeLength = parseNumber(env.CLAUDE_SENTRY_MAX_ATTRIBUTE_LENGTH) ?? raw.maxAttributeLength;
  const debug = parseBool(env.CLAUDE_SENTRY_DEBUG) ?? raw.debug;
  const envTags = parseTags(env.CLAUDE_SENTRY_TAGS);
  const tags = envTags ? { ...(raw.tags ?? {}), ...envTags } : raw.tags;
  const environment = env.CLAUDE_SENTRY_ENVIRONMENT || env.SENTRY_ENVIRONMENT || raw.environment;
  const release = env.CLAUDE_SENTRY_RELEASE || env.SENTRY_RELEASE || raw.release;
  return {
    ...raw,
    dsn,
    tracesSampleRate,
    recordInputs,
    recordOutputs,
    maxAttributeLength,
    debug,
    tags,
    environment,
    release,
  };
}

export async function loadConfig(): Promise<ResolvedPluginConfig | null> {
  let raw: Partial<PluginConfig> | null = null;

  const envPath = process.env.CLAUDE_SENTRY_CONFIG;
  if (envPath) {
    raw = (await readJsonFile(envPath)) as Partial<PluginConfig> | null;
  }

  if (!raw) {
    const home = homedir();
    const candidates = [
      join(home, ".config", "claude-code", "sentry-monitor.jsonc"),
      join(home, ".config", "claude-code", "sentry-monitor.json"),
      join(home, ".config", "sentry-claude", "config"),
    ];
    for (const candidate of candidates) {
      const content = await readJsonFile(candidate);
      if (content) {
        raw = content as Partial<PluginConfig>;
        break;
      }
    }
  }

  const base: PluginConfig = {
    dsn: raw?.dsn ?? "",
    tracesSampleRate: raw?.tracesSampleRate,
    environment: raw?.environment,
    release: raw?.release,
    debug: raw?.debug,
    recordInputs: raw?.recordInputs,
    recordOutputs: raw?.recordOutputs,
    maxAttributeLength: raw?.maxAttributeLength,
    tags: raw?.tags,
    prices: raw?.prices,
  };

  const withEnv = applyEnvOverrides(base);
  if (!withEnv.dsn) return null;
  return resolveDefaults(withEnv);
}

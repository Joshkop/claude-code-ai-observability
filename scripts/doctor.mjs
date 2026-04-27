#!/usr/bin/env node
// Cross-platform diagnostic for claude-code-ai-observability.
// Replaces doctor.sh — runs on Windows PowerShell, native macOS, Linux, WSL.
// Probes: plugin version, installed plugin entry, collector /health, PID file,
// listening process (per-OS), DSN config resolution, recent error logs,
// relevant Sentry env vars (DSN-shaped values masked).

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..");
const CACHE_DIR = join(homedir(), ".cache", "claude-code-ai-observability");
const PORT = Number(process.env.SENTRY_COLLECTOR_PORT) || 19877;
const IS_WIN = platform() === "win32";

function header(title) {
  console.log(`\n=== ${title} ===`);
}

function tryRead(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function tryReadJson(path) {
  const text = tryRead(path);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function tryRun(cmd, args, timeoutMs = 1500) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
  } catch {
    return null;
  }
}

function tail(text, n) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).filter(Boolean).join("\n");
}

// --- Plugin version (manifest) ---
header("Plugin Version");
const manifest = tryReadJson(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
console.log(manifest?.version ?? "plugin.json not found");

// --- Installed plugin info ---
header("Installed Plugin Info");
const installed = tryReadJson(join(homedir(), ".claude", "plugins", "installed_plugins.json"));
if (installed) {
  const table = installed.plugins ?? installed;
  const raw = table?.["claude-code-ai-observability@joshkop"];
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (entry) {
    console.log(`Version: ${entry.version}`);
    console.log(`Path: ${entry.installPath}`);
  } else {
    console.log("not installed via plugin manager");
  }
} else {
  console.log("not installed via plugin manager");
}

// --- Collector /health ---
header("Collector Status");
let healthData = null;
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
    signal: AbortSignal.timeout(1000),
  });
  if (res.ok) {
    const text = await res.text();
    try { healthData = JSON.parse(text); } catch { healthData = { raw: text }; }
    console.log(JSON.stringify(healthData, null, 2));
  } else {
    console.log(`HTTP ${res.status}`);
  }
} catch (err) {
  console.log(`not running on port ${PORT} (${err?.code || err?.message || "unknown"})`);
}

// --- PID file ---
header("PID File");
const pidFile = join(CACHE_DIR, "collector.pid");
const pidText = tryRead(pidFile);
console.log(pidText ?? "no pid file");

// --- Listening process ---
header("Listening Process");
let listenerOut = null;
if (IS_WIN) {
  // PowerShell only — netstat.exe may not be on PATH for restricted users
  listenerOut = tryRun("powershell.exe", [
    "-NoProfile", "-Command",
    `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -First 1 LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String`,
  ]);
} else {
  listenerOut =
    tryRun("lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN"]) ||
    tryRun("ss", ["-tlnp", `sport = :${PORT}`]) ||
    tryRun("fuser", [`${PORT}/tcp`]);
}
if (listenerOut && listenerOut.trim()) {
  console.log(listenerOut.trim().split("\n").slice(-3).join("\n"));
} else {
  console.log("no listening process found (lsof/ss/fuser/Get-NetTCPConnection unavailable or empty)");
}

// --- DSN config resolution ---
header("DSN Configuration");
const candidates = [];
if (process.env.CLAUDE_SENTRY_CONFIG) candidates.push([process.env.CLAUDE_SENTRY_CONFIG, "via CLAUDE_SENTRY_CONFIG"]);
candidates.push([join(homedir(), ".config", "claude-code", "sentry-monitor.jsonc"), "default"]);
candidates.push([join(homedir(), ".config", "claude-code", "sentry-monitor.json"), "default"]);
candidates.push([join(homedir(), ".config", "sentry-claude", "config"), "legacy"]);

let found = null;
for (const [path, label] of candidates) {
  if (existsSync(path)) { found = [path, label]; break; }
}
if (found) {
  console.log(`Found: ${found[0]} (${found[1]})`);
  const cfg = tryReadJson(found[0]);
  if (cfg && typeof cfg.dsn === "string") {
    const masked = cfg.dsn.length > 12 ? cfg.dsn.slice(0, 12) + "…" : cfg.dsn;
    console.log(`dsn=${masked}`);
  } else if (cfg) {
    console.log("(file is valid JSON but contains no dsn field)");
  }
} else {
  console.log("no DSN configured (set CLAUDE_SENTRY_CONFIG or create ~/.config/claude-code/sentry-monitor.json)");
}
if (process.env.CLAUDE_SENTRY_DSN) console.log("CLAUDE_SENTRY_DSN env is set (value masked)");

// --- Recent hook + collector errors ---
for (const [label, file] of [
  ["Recent Hook Errors", join(CACHE_DIR, "hook.err.log")],
  ["Recent Collector Errors", join(CACHE_DIR, "collector.err.log")],
]) {
  header(label);
  if (existsSync(file)) {
    const txt = tryRead(file);
    const out = tail(txt, 20);
    console.log(out || "(empty)");
    try {
      const stat = statSync(file);
      console.log(`-- ${file} (${stat.size} bytes)`);
    } catch { /* ignore */ }
  } else {
    console.log(`no ${label.toLowerCase().includes("hook") ? "hook" : "collector"} errors logged`);
  }
}

// --- Sentry env vars (DSN-shaped masked) ---
header("Sentry Environment Variables");
const envKeys = Object.keys(process.env)
  .filter((k) => k.startsWith("SENTRY_") || k.startsWith("CLAUDE_SENTRY_"))
  .sort();
if (envKeys.length === 0) {
  console.log("(none set)");
} else {
  for (const k of envKeys) {
    const v = process.env[k] ?? "";
    const isDsn = /dsn/i.test(k);
    const display = isDsn && v.length > 12 ? v.slice(0, 12) + "…" : v;
    console.log(`${k}=${display}`);
  }
}

// --- Summary ---
header("Summary");
const okHealth = healthData && healthData.ok === true;
if (okHealth && found) {
  console.log(`OK: collector reachable, version ${healthData.version ?? "?"}, pid ${healthData.pid ?? "?"}`);
  process.exit(0);
} else {
  const issues = [];
  if (!okHealth) issues.push("collector not running");
  if (!found) issues.push("no DSN configured");
  console.log(`NOT OK: ${issues.join(", ")}`);
  process.exit(1);
}

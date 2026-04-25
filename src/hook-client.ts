import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { HookEvent } from "./types.js";
import {
  CACHE_DIR,
  PID_FILE,
  PLUGIN_VERSION,
  type CollectorHealth,
  type CollectorPidFile,
} from "./plugin-meta.js";

const DEFAULT_PORT = 19877;

function getPort(): number {
  return Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function probeHealth(port: number, timeoutMs = 500): Promise<CollectorHealth | null> {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const trimmed = text.trim();
    // Legacy collectors return plain "ok" — treat as version-less.
    if (trimmed === "ok") return { ok: true };
    try {
      const parsed = JSON.parse(trimmed) as CollectorHealth;
      if (parsed && typeof parsed === "object" && parsed.ok === true) return parsed;
    } catch {
      // Not JSON — fall through; port is held by a stranger (e.g. a dev web server).
    }
    // 200 OK but not a recognized collector body. Port is occupied by something else.
    return { ok: false, occupied: true };
  } catch {
    return null;
  }
}

export async function sendHookEvent(event: HookEvent, port: number): Promise<void> {
  try {
    await fetch(`${baseUrl(port)}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500),
    });
  } catch {
    // Realtime best-effort: never block the hook.
  }
}

function logDir(): string {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
  return CACHE_DIR;
}

export function readPidFile(): CollectorPidFile | null {
  try {
    const text = readFileSync(PID_FILE, "utf8");
    const data = JSON.parse(text) as CollectorPidFile;
    if (
      data &&
      typeof data.pid === "number" &&
      typeof data.port === "number" &&
      typeof data.version === "string" &&
      typeof data.startedAt === "number"
    ) {
      return data;
    }
  } catch {
    // ignore
  }
  return null;
}

function findListenerPid(port: number): number | null {
  const tries: Array<[string, string[], (out: string) => number | null]> = [
    ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (out) => {
      const n = Number(out.split("\n").find((s) => s.trim().length > 0));
      return Number.isFinite(n) && n > 0 ? n : null;
    }],
    ["ss", ["-tlnpH", `sport = :${port}`], (out) => {
      const m = out.match(/pid=(\d+)/);
      const n = m ? Number(m[1]) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    }],
    ["fuser", [`${port}/tcp`], (out) => {
      const n = Number(out.trim().split(/\s+/).find((s) => s.length > 0));
      return Number.isFinite(n) && n > 0 ? n : null;
    }],
  ];
  for (const [bin, args, parse] of tries) {
    try {
      const out = execFileSync(bin, args, {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pid = parse(out);
      if (pid && pid !== process.pid) return pid;
    } catch {
      // try next
    }
  }
  return null;
}

async function killStaleCollector(
  reason: string,
  info: CollectorHealth | null,
  port: number,
): Promise<void> {
  let pid = info?.pid;
  if (!pid) {
    const pidFile = readPidFile();
    pid = pidFile?.pid;
  }
  if (!pid) {
    const found = findListenerPid(port);
    if (found) pid = found;
  }
  process.stderr.write(
    `claude-code-ai-observability: replacing stale collector (${reason}); pid=${pid ?? "unknown"}\n`,
  );
  if (!pid) return;

  // Guard against PID reuse: if we can verify the listener, confirm it's still our target
  // before signalling. When findListenerPid returns null (missing lsof/ss/fuser), fall
  // through — we can't verify, so accept the informational risk.
  const currentOwner = findListenerPid(port);
  if (currentOwner !== null && currentOwner !== pid) {
    process.stderr.write(
      `claude-code-ai-observability: abort SIGTERM — port ${port} now owned by pid ${currentOwner}, not ${pid}\n`,
    );
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead — fine
    return;
  }
  // Wait up to ~2s for graceful shutdown.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return;
    }
  }

  // Before SIGKILL, re-verify the PID still holds the port. Another process could have
  // claimed it during the 2 s wait (kernel reuses PIDs fast on busy systems).
  const stillOwns = findListenerPid(port);
  if (stillOwns !== null && stillOwns !== pid) {
    process.stderr.write(
      `claude-code-ai-observability: abort SIGKILL — port ${port} no longer owned by pid ${pid}\n`,
    );
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
}

function lockFilePath(port: number): string {
  return join(CACHE_DIR, `eviction-${port}.lock`);
}

interface LockData {
  pid: number;
  ts: number;
}

/** Atomically create the lock file (O_CREAT|O_EXCL). Returns true if acquired. */
function tryAcquireLock(lockPath: string): boolean {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function readLock(lockPath: string): LockData | null {
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf8")) as LockData;
    if (data && typeof data.pid === "number" && typeof data.ts === "number") return data;
  } catch { /* ignore */ }
  return null;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function spawnCollector(port: number, configJson: string): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexPath = resolve(here, "index.js");
  if (!existsSync(indexPath)) return;
  const dir = logDir();
  const out = openSync(join(dir, "collector.log"), "a");
  const err = openSync(join(dir, "collector.err.log"), "a");
  try {
    const child = spawn(process.execPath, [indexPath, "--serve", configJson], {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // ignore
  } finally {
    try { closeSync(out); } catch { /* ignore */ }
    try { closeSync(err); } catch { /* ignore */ }
  }
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const next = await probeHealth(port, 200);
    if (next && next.version === PLUGIN_VERSION) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function isHealthyMatch(info: CollectorHealth | null): boolean {
  if (!info?.ok) return false;
  if (info.version !== PLUGIN_VERSION) return false;
  // On shared hosts two users with the same plugin version can otherwise accept each
  // other's collector as healthy and cross-wire events into the wrong Sentry DSN.
  const myUid = process.getuid?.();
  if (typeof myUid === "number" && typeof info.uid === "number" && info.uid !== myUid) {
    return false;
  }
  return true;
}

async function passiveWaitForHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const info = await probeHealth(port, 200);
    if (isHealthyMatch(info)) return true;
  }
  return false;
}

export async function ensureServerRunning(port: number, configJson: string): Promise<void> {
  const lockPath = lockFilePath(port);
  const MAX_LOCK_ATTEMPTS = 3;
  let occupiedBailWarned = false;

  try {
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
      // Step 1: Fast path — already healthy, version-matched, same user.
      const info = await probeHealth(port, 500);
      if (isHealthyMatch(info)) return;

      // Port returned 200 with a non-collector body. Don't try to spawn over it —
      // our spawn would just hit EADDRINUSE. Warn once and let the user reassign.
      if (info?.occupied) {
        if (!occupiedBailWarned) {
          process.stderr.write(
            `claude-code-ai-observability: port ${port} occupied by a non-collector process; ` +
              `set SENTRY_COLLECTOR_PORT to a free port or stop the squatter.\n`,
          );
          occupiedBailWarned = true;
        }
        return;
      }

      // Step 2: Try to acquire the advisory lock.
      if (tryAcquireLock(lockPath)) {
        try {
          // Step 3a: Re-probe — a peer may have just rebirthed the collector.
          const recheck = await probeHealth(port, 500);
          if (isHealthyMatch(recheck)) return;
          if (recheck?.occupied) return;

          // Step 3b: Kill stale (if any) then spawn fresh.
          const toEvict = recheck?.ok ? recheck : info?.ok ? info : null;
          if (toEvict) {
            await killStaleCollector(
              toEvict.version
                ? `version mismatch (running=${toEvict.version}, expected=${PLUGIN_VERSION})`
                : "legacy collector without version metadata",
              toEvict,
              port,
            );
          }
          await spawnCollector(port, configJson);
        } finally {
          releaseLock(lockPath);
        }
        return;
      }

      // Step 4: Lock not acquired — someone else owns it.
      const lockData = readLock(lockPath);
      if (!lockData) {
        // Lock vanished between acquire attempt and read — retry immediately.
        continue;
      }
      const stale = !isPidAlive(lockData.pid) || Date.now() - lockData.ts > 5000;
      if (stale) {
        // Remove stale lock and retry (bounded by MAX_LOCK_ATTEMPTS).
        releaseLock(lockPath);
        continue;
      }

      // Step 4b: Peer is actively working — wait up to 3 s for a healthy collector.
      // This is the terminal branch: we've observed a live peer and handed off to it.
      await passiveWaitForHealthy(port, 3000);
      return;
    }

    // Attempts exhausted — one last passive wait, then give up silently.
    await passiveWaitForHealthy(port, 3000);
  } catch {
    // Eviction is best-effort; never throw to the caller.
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function loadConfigJson(): Promise<string> {
  const envPath = process.env.CLAUDE_SENTRY_CONFIG;
  if (envPath && existsSync(envPath)) {
    try { return readFileSync(envPath, "utf8"); } catch { /* ignore */ }
  }
  const candidates = [
    join(homedir(), ".config", "claude-code", "sentry-monitor.jsonc"),
    join(homedir(), ".config", "claude-code", "sentry-monitor.json"),
    join(homedir(), ".config", "sentry-claude", "config"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try { return readFileSync(c, "utf8"); } catch { /* ignore */ }
    }
  }
  return "{}";
}

async function main(): Promise<void> {
  const stdin = await readStdin();
  let event: HookEvent;
  try {
    event = JSON.parse(stdin) as HookEvent;
  } catch {
    return;
  }
  const port = getPort();
  if (event.hook_event_name === "SessionStart") {
    const configJson = await loadConfigJson();
    await ensureServerRunning(port, configJson);
  }
  await sendHookEvent(event, port);
}

const isEntry = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntry) {
  main().catch(() => process.exit(0));
}

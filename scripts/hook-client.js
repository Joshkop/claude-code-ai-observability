import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CACHE_DIR, PID_FILE, PLUGIN_VERSION, } from "./plugin-meta.js";
const DEFAULT_PORT = 19877;
function getPort() {
    return Number(process.env.SENTRY_COLLECTOR_PORT) || DEFAULT_PORT;
}
function baseUrl(port) {
    return `http://127.0.0.1:${port}`;
}
async function probeHealth(port, timeoutMs = 500) {
    try {
        const res = await fetch(`${baseUrl(port)}/health`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return null;
        const text = await res.text();
        const trimmed = text.trim();
        // Legacy collectors return plain "ok" — treat as version-less.
        if (trimmed === "ok")
            return { ok: true };
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object")
                return parsed;
        }
        catch {
            // ignore parse failures
        }
        return null;
    }
    catch {
        return null;
    }
}
export async function sendHookEvent(event, port) {
    try {
        await fetch(`${baseUrl(port)}/hook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(500),
        });
    }
    catch {
        // Realtime best-effort: never block the hook.
    }
}
function logDir() {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
    }
    catch { /* ignore */ }
    return CACHE_DIR;
}
function readPidFile() {
    try {
        const text = readFileSync(PID_FILE, "utf8");
        const data = JSON.parse(text);
        if (data && typeof data.pid === "number")
            return data;
    }
    catch {
        // ignore
    }
    return null;
}
function findListenerPid(port) {
    const tries = [
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
            if (pid && pid !== process.pid)
                return pid;
        }
        catch {
            // try next
        }
    }
    return null;
}
async function killStaleCollector(reason, info, port) {
    let pid = info?.pid;
    if (!pid) {
        const pidFile = readPidFile();
        pid = pidFile?.pid;
    }
    if (!pid) {
        const found = findListenerPid(port);
        if (found)
            pid = found;
    }
    process.stderr.write(`claude-code-ai-observability: replacing stale collector (${reason}); pid=${pid ?? "unknown"}\n`);
    if (!pid)
        return;
    try {
        process.kill(pid, "SIGTERM");
    }
    catch {
        // already dead — fine
        return;
    }
    // Wait up to ~2s for graceful shutdown.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
            await new Promise((r) => setTimeout(r, 100));
        }
        catch {
            return;
        }
    }
    // Last resort.
    try {
        process.kill(pid, "SIGKILL");
    }
    catch { /* ignore */ }
}
export async function ensureServerRunning(port, configJson) {
    const info = await probeHealth(port, 500);
    if (info && info.version === PLUGIN_VERSION)
        return;
    if (info) {
        await killStaleCollector(info.version
            ? `version mismatch (running=${info.version}, expected=${PLUGIN_VERSION})`
            : "legacy collector without version metadata", info, port);
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const indexPath = resolve(here, "index.js");
    if (!existsSync(indexPath))
        return;
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
    }
    catch {
        // ignore
    }
    finally {
        try {
            closeSync(out);
        }
        catch { /* ignore */ }
        try {
            closeSync(err);
        }
        catch { /* ignore */ }
    }
    const start = Date.now();
    while (Date.now() - start < 2000) {
        const next = await probeHealth(port, 200);
        if (next && next.version === PLUGIN_VERSION)
            return;
        await new Promise((r) => setTimeout(r, 100));
    }
}
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (c) => chunks.push(c));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
    });
}
async function loadConfigJson() {
    const envPath = process.env.CLAUDE_SENTRY_CONFIG;
    if (envPath && existsSync(envPath)) {
        try {
            return readFileSync(envPath, "utf8");
        }
        catch { /* ignore */ }
    }
    const candidates = [
        join(homedir(), ".config", "claude-code", "sentry-monitor.jsonc"),
        join(homedir(), ".config", "claude-code", "sentry-monitor.json"),
        join(homedir(), ".config", "sentry-claude", "config"),
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            try {
                return readFileSync(c, "utf8");
            }
            catch { /* ignore */ }
        }
    }
    return "{}";
}
async function main() {
    const stdin = await readStdin();
    let event;
    try {
        event = JSON.parse(stdin);
    }
    catch {
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
    }
    catch {
        return false;
    }
})();
if (isEntry) {
    main().catch(() => process.exit(0));
}

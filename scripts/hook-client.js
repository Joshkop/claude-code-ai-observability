import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
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
            return false;
        const text = await res.text();
        return text.trim() === "ok";
    }
    catch {
        return false;
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
    const dir = join(homedir(), ".cache", "claude-code-ai-observability");
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch { /* ignore */ }
    return dir;
}
export async function ensureServerRunning(port, configJson) {
    if (await probeHealth(port, 500))
        return;
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
    // Brief wait so the first event lands cleanly.
    const start = Date.now();
    while (Date.now() - start < 1000) {
        if (await probeHealth(port, 200))
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

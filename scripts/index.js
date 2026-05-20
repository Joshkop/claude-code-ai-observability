import { createRequire } from "node:module";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveDefaults } from "./config.js";
import { startServer } from "./server.js";
import { installGlobalHandlers } from "./sentry-errors.js";
const require = createRequire(import.meta.url);
function loadSentry() {
    return require("@sentry/node");
}
function parseInlineConfig(jsonText) {
    try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed.dsn !== "string" || !parsed.dsn)
            return null;
        return resolveDefaults(parsed);
    }
    catch {
        return null;
    }
}
const RESPAWN_TAG_TTL_MS = 60_000;
export function applyRespawnTag(sentry) {
    const fromVersion = process.env.AIOBS_RESPAWNED_FROM;
    if (!fromVersion)
        return;
    try {
        sentry.setTag("claude_code.collector.respawned_from_version", fromVersion);
    }
    catch {
        return;
    }
    const timer = setTimeout(() => {
        try {
            sentry.setTag("claude_code.collector.respawned_from_version", undefined);
        }
        catch { /* ignore */ }
    }, RESPAWN_TAG_TTL_MS);
    // Don't keep the process alive past its natural lifetime.
    if (typeof timer.unref === "function")
        timer.unref();
}
async function startCollector(config) {
    const Sentry = loadSentry();
    Sentry.init({
        dsn: config.dsn,
        tracesSampleRate: config.tracesSampleRate,
        environment: config.environment,
        release: config.release,
        debug: config.debug,
        // Required for Sentry's AI Agents → Conversations view to populate.
        // Without this flag the SDK still emits gen_ai.conversation.id on
        // spans (so traces / span detail work), but Sentry's Conversations
        // data pipeline never receives them and the view stays empty. Added
        // in @sentry/node 10.53.0; see PR getsentry/sentry-javascript#20785.
        streamGenAiSpans: true,
    });
    // Promote user-configured tags (e.g. `developer`) to the isolation scope
    // BEFORE any spans are created, so they propagate to every child span
    // (gen_ai.chat, gen_ai.execute_tool, ...) — not just the gen_ai.invoke_agent
    // root. Span-level setAttribute does not propagate to children, which is
    // why filtering `span.op:gen_ai.chat developer:<name>` returned nothing.
    for (const [k, v] of Object.entries(config.tags)) {
        if (v !== undefined && v !== null)
            Sentry.setTag(k, v);
    }
    // Tag every event with the operating-system user so Sentry's built-in
    // "user" filter splits traces by developer on shared hosts. We deliberately
    // avoid email / IP — those would be PII without the user opting in.
    try {
        const ui = os.userInfo();
        if (ui.username) {
            Sentry.setUser({
                username: ui.username,
                ...(typeof ui.uid === "number" && ui.uid >= 0 ? { id: String(ui.uid) } : {}),
            });
        }
    }
    catch {
        // os.userInfo can throw on sandboxes with no uid mapping; skip silently.
    }
    // Route collector-side crashes into the same Sentry project — otherwise
    // users have no idea why traces stopped appearing.
    installGlobalHandlers(Sentry);
    applyRespawnTag(Sentry);
    startServer(Sentry, config, {});
}
async function main() {
    const argv = process.argv.slice(2);
    const serveIdx = argv.indexOf("--serve");
    let config = null;
    if (serveIdx !== -1 && argv[serveIdx + 1]) {
        config = parseInlineConfig(argv[serveIdx + 1]);
    }
    if (!config) {
        config = await loadConfig();
    }
    if (!config) {
        process.stderr.write("claude-code-ai-observability: no DSN configured; collector exiting.\n");
        process.exit(0);
    }
    await startCollector(config);
}
// Only auto-run main() when this module is the process entry point. Importing
// it from tests (or any other code) must NOT spawn the collector or trigger
// process.exit — under vitest those calls are intercepted and re-thrown,
// which then cascades into a second process.exit(1) and crashes the test run.
const isEntry = (() => {
    try {
        return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
    }
    catch {
        return false;
    }
})();
if (isEntry) {
    main().catch((err) => {
        process.stderr.write(`collector failed: ${err.message ?? err}\n`);
        process.exit(1);
    });
}

import { createRequire } from "node:module";
import os from "node:os";
import { loadConfig, resolveDefaults } from "./config.js";
import { startServer } from "./server.js";
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
async function startCollector(config) {
    const Sentry = loadSentry();
    Sentry.init({
        dsn: config.dsn,
        tracesSampleRate: config.tracesSampleRate,
        environment: config.environment,
        release: config.release,
        debug: config.debug,
    });
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
main().catch((err) => {
    process.stderr.write(`collector failed: ${err.message ?? err}\n`);
    process.exit(1);
});

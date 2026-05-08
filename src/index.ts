import { createRequire } from "node:module";
import os from "node:os";
import type * as SentryNS from "@sentry/node";
import { loadConfig, resolveDefaults } from "./config.js";
import { startServer } from "./server.js";
import { installGlobalHandlers } from "./sentry-errors.js";
import type { PluginConfig, ResolvedPluginConfig } from "./types.js";

const require = createRequire(import.meta.url);

function loadSentry(): typeof SentryNS {
  return require("@sentry/node") as typeof SentryNS;
}

function parseInlineConfig(jsonText: string): ResolvedPluginConfig | null {
  try {
    const parsed = JSON.parse(jsonText) as Partial<PluginConfig>;
    if (!parsed || typeof parsed.dsn !== "string" || !parsed.dsn) return null;
    return resolveDefaults(parsed as PluginConfig);
  } catch {
    return null;
  }
}

async function startCollector(config: ResolvedPluginConfig): Promise<void> {
  const Sentry = loadSentry();
  Sentry.init({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
  });
  // Promote user-configured tags (e.g. `developer`) to the isolation scope
  // BEFORE any spans are created, so they propagate to every child span
  // (gen_ai.chat, gen_ai.execute_tool, ...) — not just the gen_ai.invoke_agent
  // root. Span-level setAttribute does not propagate to children, which is
  // why filtering `span.op:gen_ai.chat developer:<name>` returned nothing.
  for (const [k, v] of Object.entries(config.tags)) {
    if (v !== undefined && v !== null) Sentry.setTag(k, v);
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
  } catch {
    // os.userInfo can throw on sandboxes with no uid mapping; skip silently.
  }
  // Route collector-side crashes into the same Sentry project — otherwise
  // users have no idea why traces stopped appearing.
  installGlobalHandlers(Sentry);
  startServer(Sentry, config, {});
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const serveIdx = argv.indexOf("--serve");
  let config: ResolvedPluginConfig | null = null;
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
  process.stderr.write(`collector failed: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});

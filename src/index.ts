import { createRequire } from "node:module";
import type * as SentryNS from "@sentry/node";
import { loadConfig, resolveDefaults } from "./config.js";
import { startServer } from "./server.js";
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

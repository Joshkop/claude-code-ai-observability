import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function readVersion() {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const manifest = join(here, "..", ".claude-plugin", "plugin.json");
        const data = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof data.version === "string" && data.version)
            return data.version;
    }
    catch {
        // ignore — fall through to "unknown"
    }
    return "unknown";
}
export const PLUGIN_VERSION = readVersion();
// CACHE_DIR is overridable so sandboxed/multi-tenant hosts (and parallel test
// workers) can isolate the collector's pid/lock/counter files instead of
// sharing one global path.
export const CACHE_DIR = process.env.CLAUDE_AIOBS_CACHE_DIR || join(homedir(), ".cache", "claude-code-ai-observability");
export const PID_FILE = process.env.CLAUDE_AIOBS_PID_FILE || join(CACHE_DIR, "collector.pid");

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = join(here, "..", ".claude-plugin", "plugin.json");
    const data = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
    if (typeof data.version === "string" && data.version) return data.version;
  } catch {
    // ignore — fall through to "unknown"
  }
  return "unknown";
}

export const PLUGIN_VERSION: string = readVersion();
export const CACHE_DIR: string = join(homedir(), ".cache", "claude-code-ai-observability");
export const PID_FILE: string = join(CACHE_DIR, "collector.pid");

export interface CollectorPidFile {
  pid: number;
  port: number;
  version: string;
  startedAt: number;
}

export interface CollectorHealth {
  ok: boolean;
  pid?: number;
  port?: number;
  version?: string;
  startedAt?: number;
  sessions?: number;
  /** Unix uid of the collector process; used to reject cross-user collectors on shared hosts. */
  uid?: number;
  /** True when /health returned 200 with a body that doesn't look like a collector response. */
  occupied?: boolean;
}

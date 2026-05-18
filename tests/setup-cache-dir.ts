// Give every vitest worker its own collector cache dir so the real-server
// integration tests (server-endpoints, server-lifecycle, hook-client) don't
// race on the shared global ~/.cache/.../collector.pid (and dropped.count,
// eviction lock) across parallel workers. Runs before any test module — and
// thus before src/plugin-meta.ts evaluates CACHE_DIR/PID_FILE.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set once per worker process (env persists across the worker's test files,
// matching plugin-meta's module-cached PID_FILE for that worker).
if (!process.env.CLAUDE_AIOBS_CACHE_DIR) {
  const workerId =
    process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid);
  process.env.CLAUDE_AIOBS_CACHE_DIR = mkdtempSync(
    join(tmpdir(), `aiobs-test-w${workerId}-`),
  );
}

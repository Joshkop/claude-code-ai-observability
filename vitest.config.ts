import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-worker isolated CACHE_DIR; must load before any test module so
    // src/plugin-meta.ts reads the override when it evaluates PID_FILE.
    setupFiles: ["tests/setup-cache-dir.ts"],
  },
});

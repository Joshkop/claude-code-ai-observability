#!/bin/bash
# AI observability hook for Claude Code
# Reads hook event JSON from stdin, forwards to Node hook-client.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${HOME}/.cache/claude-code-ai-observability"
mkdir -p "$LOG_DIR" 2>/dev/null || true
ERR_LOG="${LOG_DIR}/hook.err.log"

# Auto-install dependencies on first run.
if [ ! -d "${SCRIPT_DIR}/node_modules/@sentry/node" ]; then
  (cd "$SCRIPT_DIR" && npm install --no-fund --no-audit --silent 2>>"$ERR_LOG") || true
fi

# Read hook event JSON from stdin.
INPUT=$(cat)

# Forward to compiled hook client. Errors are appended to hook.err.log so
# port collisions, stale collectors, and crashes leave a trail rather than
# vanishing into /dev/null.
echo "$INPUT" | node "$SCRIPT_DIR/hook-client.js" 2>>"$ERR_LOG" || true

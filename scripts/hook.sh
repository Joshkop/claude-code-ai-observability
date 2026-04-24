#!/bin/bash
# AI observability hook for Claude Code
# Reads hook event JSON from stdin, forwards to Node hook-client.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-install dependencies on first run
if [ ! -d "${SCRIPT_DIR}/node_modules/@sentry/node" ]; then
  (cd "$SCRIPT_DIR" && npm install --no-fund --no-audit --silent 2>/dev/null) || true
fi

# Read hook event JSON from stdin
INPUT=$(cat)

# Forward to compiled hook client
echo "$INPUT" | node "$SCRIPT_DIR/hook-client.js" 2>/dev/null || true

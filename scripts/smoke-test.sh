#!/usr/bin/env bash
set -euo pipefail

# Always test the source default port. Allow an explicit AIOBS_SMOKE_PORT
# override for CI environments where 19877 is taken; do NOT inherit
# SENTRY_COLLECTOR_PORT from the parent shell (would mask src changes).
SMOKE_PORT="${AIOBS_SMOKE_PORT:-19877}"
export SENTRY_COLLECTOR_PORT="$SMOKE_PORT"
BASE_URL="http://127.0.0.1:${SMOKE_PORT}"
TRANSCRIPT_PATH="/tmp/aiobs-smoke-transcript.jsonl"
DUMMY_DSN='{"dsn":"https://dummy@o0.ingest.sentry.io/0","tracesSampleRate":0}'
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TRANSCRIPT_PATH"
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Write a minimal synthetic transcript
cat > "$TRANSCRIPT_PATH" <<'TRANSCRIPT'
{"type":"user","message":{"content":"Hello, run a command for me"}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":5},"content":"Sure!"}}
{"type":"user","message":{"content":"Now do something else"}}
{"type":"assistant","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":20,"output_tokens":8},"content":"Done!"}}
TRANSCRIPT

# Start the collector in background
node "$SCRIPT_DIR/index.js" --serve "$DUMMY_DSN" &
SERVER_PID=$!

# Poll /health up to 5 seconds
echo "Waiting for collector on port ${SMOKE_PORT}..."
for i in $(seq 1 25); do
  if curl -sf "${BASE_URL}/health" -o /dev/null 2>/dev/null; then
    echo "Collector is up."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: collector process exited early." >&2
    exit 1
  fi
  sleep 0.2
  if [ "$i" -eq 25 ]; then
    echo "ERROR: collector did not become healthy within 5s." >&2
    exit 1
  fi
done

post_hook() {
  local payload="$1"
  local response
  response=$(curl -sf -X POST "${BASE_URL}/hook" \
    -H "Content-Type: application/json" \
    -d "$payload")
  if [ "$response" != "{}" ]; then
    echo "ERROR: unexpected response from /hook: $response" >&2
    exit 1
  fi
}

SESSION_ID="smoke-test-session-$$"

# SessionStart
post_hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}"

# Turn 1
post_hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"${SESSION_ID}\",\"prompt\":\"Hello, run a command for me\"}"
post_hook "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Bash\",\"tool_use_id\":\"tu-1\",\"tool_input\":{\"command\":\"echo hi\"}}"
post_hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Bash\",\"tool_use_id\":\"tu-1\",\"tool_response\":\"hi\",\"tool_error\":false}"

# Turn 2 — with a Task (subagent) invocation
post_hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"${SESSION_ID}\",\"prompt\":\"Now do something else\"}"
post_hook "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Task\",\"tool_use_id\":\"tu-2\",\"tool_input\":{\"subagent_type\":\"explore\",\"prompt\":\"explore the repo\"}}"
post_hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Task\",\"tool_use_id\":\"tu-2\",\"tool_response\":\"done\",\"tool_error\":false}"

# Turn 3 — with an Agent (subagent) invocation (newer harness tool name)
post_hook "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Agent\",\"tool_use_id\":\"tu-3\",\"tool_input\":{\"subagent_type\":\"oh-my-claudecode:executor\",\"prompt\":\"do executor work\"}}"
post_hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"${SESSION_ID}\",\"tool_name\":\"Agent\",\"tool_use_id\":\"tu-3\",\"tool_response\":\"done\",\"tool_error\":false}"

# SessionEnd
post_hook "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\"}"

# Verify the process is still alive
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: collector process crashed during test." >&2
  exit 1
fi

echo "Smoke test PASSED."

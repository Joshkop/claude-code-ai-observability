#!/bin/bash
# Diagnostic helper for claude-code-ai-observability plugin
# Probes collector, PID file, DSN config, and logs to help debug setup issues

set -euo pipefail

# Colors for output (disabled for now, per constraints)
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${HOME}/.cache/claude-code-ai-observability"
PORT="${SENTRY_COLLECTOR_PORT:-19877}"

echo "=== Plugin Version ==="
if [ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]; then
  VERSION=$(node -e "console.log(require('$PLUGIN_DIR/.claude-plugin/plugin.json').version)")
  echo "$VERSION"
else
  echo "plugin.json not found"
fi

echo ""
echo "=== Installed Plugin Info ==="
INSTALLED_PLUGINS="${HOME}/.claude/plugins/installed_plugins.json"
if [ -f "$INSTALLED_PLUGINS" ]; then
  PLUGIN_INFO=$(node -e "
    try {
      const installed = require('$INSTALLED_PLUGINS');
      const table = installed && installed.plugins ? installed.plugins : installed;
      const raw = table && table['claude-code-ai-observability@joshkop'];
      const entry = Array.isArray(raw) ? raw[0] : raw;
      if (entry) {
        console.log('Version: ' + entry.version);
        console.log('Path: ' + entry.installPath);
      } else {
        console.log('not installed via plugin manager');
      }
    } catch {
      console.log('error reading installed_plugins.json');
    }
  ")
  echo "$PLUGIN_INFO"
else
  echo "not installed via plugin manager"
fi

echo ""
echo "=== Collector Status ==="
HEALTH_JSON=$(curl -s -m 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null || echo "")
if [ -n "$HEALTH_JSON" ]; then
  echo "$HEALTH_JSON" | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0, 'utf-8')), null, 2))" 2>/dev/null || echo "$HEALTH_JSON"
else
  echo "not running on port ${PORT}"
fi

echo ""
echo "=== PID File ==="
PID_FILE="${CACHE_DIR}/collector.pid"
if [ -f "$PID_FILE" ]; then
  cat "$PID_FILE"
else
  echo "no pid file"
fi

echo ""
echo "=== Listening Process ==="
LSOF_OUTPUT=$(lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$LSOF_OUTPUT" ]; then
  echo "$LSOF_OUTPUT" | tail -1
else
  SS_OUTPUT=$(ss -tlnp 2>/dev/null | grep ":${PORT}" || true)
  if [ -n "$SS_OUTPUT" ]; then
    echo "$SS_OUTPUT"
  else
    echo "no listening process found (lsof and ss unavailable or not found)"
  fi
fi

echo ""
echo "=== DSN Configuration ==="
DSN_RESOLVED=""
if [ -n "${CLAUDE_SENTRY_CONFIG:-}" ]; then
  if [ -f "$CLAUDE_SENTRY_CONFIG" ]; then
    DSN_RESOLVED="$CLAUDE_SENTRY_CONFIG (via CLAUDE_SENTRY_CONFIG env)"
  fi
fi
if [ -z "$DSN_RESOLVED" ]; then
  CANDIDATE1="${HOME}/.config/claude-code/sentry-monitor.jsonc"
  CANDIDATE2="${HOME}/.config/claude-code/sentry-monitor.json"
  CANDIDATE3="${HOME}/.config/sentry-claude/config"
  if [ -f "$CANDIDATE1" ]; then
    DSN_RESOLVED="$CANDIDATE1"
  elif [ -f "$CANDIDATE2" ]; then
    DSN_RESOLVED="$CANDIDATE2"
  elif [ -f "$CANDIDATE3" ]; then
    DSN_RESOLVED="$CANDIDATE3"
  fi
fi
if [ -n "$DSN_RESOLVED" ]; then
  echo "Found: $DSN_RESOLVED"
else
  echo "no DSN configured (set CLAUDE_SENTRY_CONFIG or create ~/.config/claude-code/sentry-monitor.json)"
fi

if [ -n "${CLAUDE_SENTRY_DSN:-}" ]; then
  echo "CLAUDE_SENTRY_DSN env is set (value masked)"
fi

echo ""
echo "=== Recent Hook Errors ==="
HOOK_ERR="${CACHE_DIR}/hook.err.log"
if [ -f "$HOOK_ERR" ]; then
  tail -20 "$HOOK_ERR"
else
  echo "no hook errors logged"
fi

echo ""
echo "=== Recent Collector Errors ==="
COLLECTOR_ERR="${CACHE_DIR}/collector.err.log"
if [ -f "$COLLECTOR_ERR" ]; then
  tail -20 "$COLLECTOR_ERR"
else
  echo "no collector errors logged"
fi

echo ""
echo "=== Sentry Environment Variables ==="
ENV_VARS_FOUND=0
for var in "${!SENTRY_@}" "${!CLAUDE_SENTRY_@}"; do
  VALUE="${!var}"
  # Mask DSN-shaped values: show first 12 chars + ellipsis
  if [[ "$var" == *"DSN"* ]] || [[ "$var" == *"dsn"* ]]; then
    if [ ${#VALUE} -gt 12 ]; then
      MASKED="${VALUE:0:12}…"
    else
      MASKED="$VALUE"
    fi
    echo "$var=$MASKED"
  else
    echo "$var=$VALUE"
  fi
  ENV_VARS_FOUND=1
done
if [ $ENV_VARS_FOUND -eq 0 ]; then
  echo "(none set)"
fi

echo ""
echo "=== Summary ==="
if [ -n "$HEALTH_JSON" ] && [ -n "$DSN_RESOLVED" ]; then
  PID=$(echo "$HEALTH_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')).pid)" 2>/dev/null || echo "")
  VER=$(echo "$HEALTH_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf-8')).version)" 2>/dev/null || echo "")
  echo "OK: collector reachable, version $VER, pid $PID"
else
  ISSUES=""
  [ -z "$HEALTH_JSON" ] && ISSUES="${ISSUES}collector not running, "
  [ -z "$DSN_RESOLVED" ] && ISSUES="${ISSUES}no DSN configured, "
  ISSUES="${ISSUES%%, }"
  echo "NOT OK: $ISSUES"
fi

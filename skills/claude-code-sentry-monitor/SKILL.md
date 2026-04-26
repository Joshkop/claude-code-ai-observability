---
name: claude-code-sentry-monitor
description: Set up Sentry observability for Claude Code sessions. Use when someone says "set up Sentry monitoring", "add observability to Claude Code", "configure claude-code-ai-observability", "trace Claude Code sessions", "monitor Claude Code with Sentry", or "instrument Claude Code". Interactively collects DSN and preferences, then writes the config file.
---

# claude-code-ai-observability Setup Wizard

You are setting up the `claude-code-ai-observability` plugin, which instruments Claude Code sessions as realtime distributed traces in Sentry. This is a developer-level tool — the config is global (per-machine), not per-project.

## What you will do

1. Detect and clean up any legacy `sergical/claude-code-sentry-monitor` install
2. Check for an existing config file — offer to update it if found
3. Auto-detect developer identity
4. Ask the user a small set of questions
5. Write the config file to `~/.config/claude-code/sentry-monitor.json`
6. Run the doctor and report status

---

## Step 0 — Detect & clean up legacy upstream install

Before touching config, look for any leftovers from `sergical/claude-code-sentry-monitor`. The upstream plugin and this fork can fight over the collector port and double-fire hooks if both are active.

Run these probes (silently — only surface output if something is found):

```bash
# A. Is the upstream plugin still installed via the marketplace?
node -e '
  try {
    const j = require(require("os").homedir() + "/.claude/plugins/installed_plugins.json");
    const t = j.plugins || j;
    const found = Object.keys(t).find(k => k.startsWith("claude-code-sentry-monitor@"));
    console.log(found || "");
  } catch { console.log(""); }
'

# B. Is anything listening on the upstream default port 19876?
( lsof -ti tcp:19876 2>/dev/null || ss -tlnp 2>/dev/null | awk -F'[ :]+' '/:19876 /{for(i=1;i<=NF;i++)if($i~/pid=/){gsub(/pid=|,.*/,"",$i);print $i}}' ) | head -1

# C. Stale cache from upstream?
ls -1 ~/.cache/claude-code-sentry-monitor/ 2>/dev/null
```

**If any of A/B/C returns non-empty**, tell the user what you found and ask: **"I see leftovers from the upstream `sergical/claude-code-sentry-monitor` plugin. Want me to clean them up so the new install can take over cleanly?"** Default to yes.

If they confirm, run the cleanup:

```bash
# Kill any upstream collector on port 19876
PID="$(lsof -ti tcp:19876 2>/dev/null | head -1)"
[ -n "$PID" ] && kill "$PID" 2>/dev/null && sleep 0.5
[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null

# Wipe upstream cache
rm -rf ~/.cache/claude-code-sentry-monitor 2>/dev/null

# Also evict any stale collector for this fork (any version mismatch with the installed plugin)
PID2="$(cat ~/.cache/claude-code-ai-observability/collector.pid 2>/dev/null | node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(j.pid||"")}catch{console.log("")}')"
[ -n "$PID2" ] && kill "$PID2" 2>/dev/null
rm -f ~/.cache/claude-code-ai-observability/collector.pid 2>/dev/null
```

If the user is on **native Windows (PowerShell, not WSL)** — detectable via `$env:OS -eq 'Windows_NT'` and the absence of `bash`/`lsof` — use these instead:

```powershell
Get-NetTCPConnection -LocalPort 19876 -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\claude-code-sentry-monitor" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.cache\claude-code-ai-observability\collector.pid" -ErrorAction SilentlyContinue
```

**Important:** the upstream plugin itself must be removed via Claude Code slash commands (`/plugin marketplace remove sergical` then `/plugin uninstall claude-code-sentry-monitor`) — those cannot be invoked from inside this skill. If A returned a non-empty result, **tell the user** to run those two commands in their next message and re-invoke the skill afterwards. Do not proceed to Step 1 in that case.

If A was empty (only B/C had leftovers — i.e. the user already uninstalled the plugin but processes/cache remained), proceed to Step 1 after cleanup.

---

## Step 1 — Check for existing config

Look for an existing config in these locations (in order):
1. `CLAUDE_SENTRY_CONFIG` env var (if set)
2. `~/.config/claude-code/sentry-monitor.json` (main config)
3. `~/.config/claude-code/sentry-monitor.jsonc` (with-comments variant)
4. `~/.config/sentry-claude/config` (legacy KEY=VALUE format)

Use the `read` tool to check each. If one exists, show the current config and ask: **"A config already exists — do you want to update it or leave it as-is?"**

If a legacy config exists at `~/.config/sentry-claude/config`, offer to migrate it to the new JSON format.

---

## Step 2 — Auto-detect context

Before asking questions, silently gather:

**Developer identity** — try each in order, use the first that returns a value:
```bash
gh api user --jq .login 2>/dev/null        # GitHub username
git config user.email 2>/dev/null           # fallback: git email
git config user.name 2>/dev/null            # fallback: git name
whoami                                      # last resort
```

---

## Step 3 — Ask questions

Ask these questions, showing auto-detected values as defaults:

1. **Sentry DSN** *(required)* — "Paste your DSN from Sentry → Project Settings → Client Keys. Looks like: `https://abc123@o456.ingest.sentry.io/789`"

2. **Developer tag** — "We detected your identity as `<detected-identity>`. Want to tag your traces with this? It lets you filter Sentry data by developer. (yes/no, default: yes)"

3. **Environment** *(optional)* — "What environment name should appear on traces? e.g. `development`, `production`. Leave blank to omit."

4. **Record tool inputs/outputs** — "Record tool inputs and outputs as span attributes? Useful for debugging but can be verbose. Output is secret-redacted before upload. (yes/no, default: yes)"

5. **Traces sample rate** *(optional)* — "What fraction of sessions to trace? `1` = 100%, `0.5` = 50%. Leave blank for the default (1)."

---

## Step 4 — Write the config file

Build the config from the answers. Only include fields that differ from defaults or were explicitly set. Defaults are: `tracesSampleRate: 1`, `recordInputs: true`, `recordOutputs: true`.

Always write to `~/.config/claude-code/sentry-monitor.json`. Create `~/.config/claude-code/` if it doesn't exist.

If the user confirmed the developer tag, add it under `tags`:
```json
{
  "tags": {
    "developer": "<detected-identity>"
  }
}
```

Example minimal config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "tags": {
    "developer": "joshkop"
  }
}
```

Example fuller config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "environment": "development",
  "recordOutputs": false,
  "tracesSampleRate": 0.5,
  "tags": {
    "developer": "joshkop"
  }
}
```

---

## Step 5 — Run doctor & confirm

Show the user the config that was written and where it was saved, then **run the doctor automatically** (don't ask):

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/doctor.sh"
```

On native Windows (no bash), run the equivalent inline check:

```powershell
node -e "fetch('http://127.0.0.1:' + (process.env.SENTRY_COLLECTOR_PORT || 19877) + '/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2))).catch(e=>console.log('collector not running:', e.message))"
```

Report the result to the user:

- **Doctor ends with `OK: collector reachable…`** → tell them: *"You're set. Open a fresh Claude Code session — your next turn will appear in Sentry's AI Agents dashboard within seconds. Each user turn becomes a `gen_ai.invoke_agent` transaction with per-turn token counts, USD cost, and tool spans."*
- **Doctor ends with `NOT OK: collector not running`** → that's expected if no Claude Code session has started yet. Tell the user: *"Config is written. The collector starts on demand from the first hook of your next Claude Code session — open a new terminal and run `claude` to spin it up, then re-run the doctor to confirm."*
- **`NOT OK: no DSN configured`** → something went wrong with the file write. Re-check the file path and contents, then re-run.

---

## Config reference

| Field | Default | Description |
|-------|---------|-------------|
| `dsn` | required | Sentry DSN |
| `environment` | — | Environment tag |
| `release` | — | Release tag |
| `recordInputs` | `true` | Capture tool input args as span attributes |
| `recordOutputs` | `true` | Capture tool output as span attributes (secret-redacted) |
| `tracesSampleRate` | `1` | Fraction of sessions to trace (0–1) |
| `maxAttributeLength` | `12000` | Max chars per span attribute |
| `debug` | `false` | Enable Sentry SDK debug logging |
| `tags` | `{}` | Custom tags on every span |
| `prices` | — | Per-model price overrides for `gen_ai.usage.cost.*` |

The plugin is realtime-only as of v0.1.0 — there is no `mode` field. Each turn flushes its own root transaction; there is no session-end batch.

## Troubleshooting

**No traces appearing** — Check the DSN, ensure `tracesSampleRate` is `1`. Run `bash $CLAUDE_PLUGIN_ROOT/scripts/doctor.sh` for a full diagnostic (collector health, PID file, listening process, DSN path, recent hook + collector errors).

**Plugin not loading** — Install via `/plugin marketplace add Joshkop/claude-code-ai-observability` then `/plugin install claude-code-ai-observability`, or clone manually and register the hooks in `.claude/settings.json` per the plugin README.

**Stale collector squatting on the port** — v0.1.2+ auto-evicts collectors with a mismatched version. If you upgraded from an older fork, run `kill $(cat ~/.cache/claude-code-ai-observability/collector.pid)` and start a fresh session.

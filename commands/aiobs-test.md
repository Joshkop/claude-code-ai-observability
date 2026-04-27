---
description: Smoke-test the claude-code-ai-observability collector end-to-end and report whether your live config can reach Sentry.
---

# /aiobs-test — Verify the Sentry trace pipeline is wired up

Run this when you've installed the plugin and want to confirm traces are actually flowing to Sentry without needing to manually start a real session and stare at the dashboard.

## What you do

1. **Run the cross-platform doctor first** — it surfaces config and listener issues fast:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs"
   ```

   Show the user the full output. If `Summary` says `NOT OK: no DSN configured`, stop and tell the user to run `/aiobs-setup`. If it says `NOT OK: collector not running`, that's expected when no Claude session has fired a hook yet — proceed; the smoke test will spawn one.

2. **Run the smoke test** — drives a complete fake session (`SessionStart` → 2 turns → `Bash` tool → `Task` subagent → `SessionEnd`) against a freshly-spawned collector with a dummy DSN, asserting every hook returns `200 {}`:

   ```bash
   bash "$CLAUDE_PLUGIN_ROOT/scripts/smoke-test.sh"
   ```

   This uses a dummy DSN by design (`tracesSampleRate: 0`) so it does **not** consume Sentry quota — it only validates the local hook pipeline shape.

3. **Optional — verify against the user's real Sentry project.** Only do this if the user explicitly asks. Tell them: "The smoke test uses a dummy DSN by design so it doesn't burn quota. To verify against your real Sentry project, just open a fresh Claude Code session and send any short message — your turn appears in the **AI Agents** dashboard within ~10 s, tagged with your `user.username`, `claude_code.session_name`, and `vcs.ref.head.name`."

## Reporting back

Summarize for the user:
- Doctor: OK / NOT OK + the failing checks.
- Smoke test: PASSED / FAILED.
- If they ran the real-DSN variant, remind them the test span is tagged `claude_code.test=true` so they can filter for it.

## Failure triage shortcuts

| Symptom | Most likely cause | Fix |
|---|---|---|
| `Summary: NOT OK: no DSN configured` | No `~/.config/claude-code/sentry-monitor.json` | Run `/aiobs-setup` |
| `Listening Process` empty *and* `Collector Status` says not running | First Claude session of the day hasn't fired SessionStart yet | Open a new terminal, run `claude`, send any message, re-test |
| `Listening Process` shows a PID but `Collector Status` says not running | Stale collector squatting on the port | `kill $(cat ~/.cache/claude-code-ai-observability/collector.pid)` then re-test |
| `Recent Hook Errors` shows repeated entries | Usually a stale plugin path captured at session start | Close the terminal, open a fresh one, retry |
| Smoke test `PASSED` but no traces in Sentry after a real session | Wrong DSN (project / org), or `tracesSampleRate: 0` | Re-check `~/.config/claude-code/sentry-monitor.json` |

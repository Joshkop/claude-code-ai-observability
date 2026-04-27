---
description: Configure the claude-code-ai-observability plugin (Sentry DSN, environment, developer tag, sample rate). Use this for first-time setup or to update an existing config.
---

# /aiobs-setup — Configure Sentry observability

This command is a thin alias for the bundled setup wizard skill. Invoke the skill directly so the user gets the full interactive flow (legacy-cleanup probe, identity auto-detect, DSN prompt, write to `~/.config/claude-code/sentry-monitor.json`, doctor verification).

## What you do

1. Tell the user one sentence: "Walking you through the Sentry observability setup — I'll detect any leftover upstream install, ask for your DSN and a few preferences, write the config, and run the doctor to confirm."

2. Invoke the bundled skill via the Skill tool:

   ```
   Skill(skill="claude-code-ai-observability:claude-code-sentry-monitor")
   ```

   That skill is self-contained — it owns the wizard prompts, the file writes, the cross-platform branches, and the final doctor invocation. Do **not** duplicate any of its steps inline; route everything through it.

3. After the skill returns, if the doctor reported `NOT OK`, suggest the user follow up with `/aiobs-test` for a deeper end-to-end check.

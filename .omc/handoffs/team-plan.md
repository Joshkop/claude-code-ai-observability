## Handoff: team-plan → team-exec

- **Decided**:
  - Fork of sergical/claude-code-sentry-monitor at Joshkop/claude-code-ai-observability (MIT, upstream remote preserved for optional PR-back).
  - Plugin slug: `claude-code-ai-observability`; team slug: `ai-observability-plugin`.
  - Realtime-only (batch mode dropped). Hook client POSTs to localhost HTTP server; server builds spans via `@sentry/node`.
  - Span conventions follow OTel GenAI semconv per https://develop.sentry.dev/sdk/telemetry/traces/modules/ai-agents/:
    - Root span: op `gen_ai.invoke_agent`, name `invoke_agent claude-code`, `forceTransaction: true`.
    - Turn span: op `gen_ai.chat` (NOT `gen_ai.request`), with `gen_ai.operation.name = "chat"`, `gen_ai.request.model`, `gen_ai.response.model`.
    - Tool span: op `gen_ai.execute_tool`, name `execute_tool <tool>`.
    - Subagent (Task tool): op `gen_ai.invoke_agent` under the turn span.
  - Token attrs MUST live on the chat spans (dashboard aggregates from there): `gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `input_tokens.cached`.
  - Cost attrs on chat + root: `gen_ai.usage.cost.input_tokens`, `cost.output_tokens`, `cost.total_tokens` (USD).
  - Auto-tags on every span: `claude_code.session_id/session_name/version`, `vcs.repository.name/url`, `vcs.ref.head.name/revision`, `host.name`, `os.type`, `process.cwd/pid`. All detections non-blocking, cached once per session, degrade gracefully when git/tmux missing.

- **Rejected**:
  - Minimum fix (user chose full plugin).
  - Clean rewrite without attribution — we keep upstream remote + MIT notice.
  - MCP in-session viewer + Dash Studio export — separate projects.
  - Batch mode — redundant once realtime is correct; drop to simplify.

- **Risks**:
  - Subagent detection: `tool_name == "Task"` may not include spawned agent's type; may need transcript post-hoc association. If infeasible in realtime, fall back to representing Task calls as regular tool spans.
  - Cost table staleness — mitigate with env override `CLAUDE_AIOBS_PRICE_OVERRIDES`.
  - WSL2 SYN-drop on unbound localhost ports — hook client MUST use `AbortSignal.timeout(500)` on the health probe to avoid hanging past the hook timeout.
  - Plugin update overwriting our collector — we own the fork; plugin install path is canonical and stable per version.

- **Files**: `/home/joshkop/projects/claude-code-ai-observability` (fork cloned, branch=main, remotes: origin=Joshkop fork, upstream=sergical original).

- **Remaining**: 5 subtasks below; see `~/.claude/tasks/ai-observability-plugin/*.json` for details.

## Subtask Plan

1. **Scaffold** — plugin manifest + package.json + tsconfig + src/ skeleton with exported interfaces + hooks/ skeleton + README stub. Commit. Blocks 2/3/4/5.
2. **Runtime core** — `src/server.ts`, `src/spans.ts`, `src/transcript.ts`, `src/config.ts`, `src/index.ts`. Realtime HTTP server, event router, turn-span lifecycle, per-turn token extraction. Depends on 1.
3. **Context / auto-tagger** — `src/context.ts`. Detect session/git/host/os once per session with graceful degradation. Depends on 1.
4. **Instrumentation extras** — `src/subagent.ts`, `src/errors.ts`, `src/cost.ts`. Subagent spans, tool error status, USD cost calculator with env overrides. Depends on 1 + 2.
5. **Tests + docs + smoke test** — Vitest unit tests, README, CHANGELOG, synthetic-session smoke test script. Depends on 2, 3, 4.

## Attribute Contract (must hold for Sentry "Tokens Used" and cost widgets to render)

Chat span (`op: "gen_ai.chat"`):
- `gen_ai.operation.name = "chat"`
- `gen_ai.system = "anthropic"`
- `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.usage.input_tokens` (raw + cache_creation + cache_read per OTel rule: include cached in input)
- `gen_ai.usage.input_tokens.cached` (from `cache_read_input_tokens`)
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.total_tokens`
- `gen_ai.usage.cost.input_tokens`, `cost.output_tokens`, `cost.total_tokens`
- Optional: `gen_ai.request.messages` (serialized user prompt, redacted)

Root span (`op: "gen_ai.invoke_agent"`):
- `gen_ai.agent.name = "claude-code"`, `gen_ai.system = "anthropic"`, `gen_ai.operation.name = "invoke_agent"`
- Aggregate `gen_ai.usage.*` across all turns
- `gen_ai.tool.call_count`
- All auto-tags

## Auto-tag Contract (on root; propagates to children via `forceTransaction` + `startInactiveSpan` inheritance)

- `claude_code.session_id`, `claude_code.session_name`, `claude_code.version`
- `vcs.repository.name`, `vcs.repository.url`, `vcs.ref.head.name`, `vcs.ref.head.revision`
- `host.name`, `os.type`, `process.cwd`, `process.pid`

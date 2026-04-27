export interface SessionState {
  sessionId: string;
  sessionName?: string;
  startTime: number;
  toolCount: number;
  turnCount: number;
}

export interface TurnTokens {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  model: string | null;
  prompt: string | null;
  response: string | null;
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface ModelPriceEntry {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export type PriceTable = Record<string, ModelPriceEntry>;

export interface ToolSpan {
  toolName: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  input?: unknown;
  output?: unknown;
  isError: boolean;
  isSubagent: boolean;
}

export interface PluginConfig {
  dsn: string;
  tracesSampleRate?: number;
  environment?: string;
  release?: string;
  debug?: boolean;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  maxAttributeLength?: number;
  tags?: Record<string, string>;
  prices?: PriceTable;
}

export interface ResolvedPluginConfig
  extends Required<Omit<PluginConfig, "environment" | "release" | "prices">> {
  environment?: string;
  release?: string;
  prices?: PriceTable;
}

/**
 * Dynamic context captured in the hook-client process. Sent on every hook
 * event so the long-lived collector can override its own (frozen-at-spawn)
 * env-derived attributes. See src/client-context.ts.
 */
export interface AiobsClientContext {
  session_name?: string;
  parent_session_id?: string;
  parent_agent_name?: string;
  tmux_window?: string;
  tmux_pane?: string;
  terminal_program?: string;
  terminal_session_id?: string;
  username?: string;
  user_id?: string;
  cwd?: string;
  ppid?: number;
  captured_at_ms?: number;
}

/** Wrapper field added by the hook-client to every outbound hook event. */
export interface AiobsEnvelope {
  _aiobs?: { context?: AiobsClientContext };
}

export interface SessionStartEvent extends AiobsEnvelope {
  hook_event_name: "SessionStart";
  session_id: string;
  model?: string;
  transcript_path?: string;
}

export interface UserPromptSubmitEvent extends AiobsEnvelope {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt?: string;
  message?: string;
}

export interface PreToolUseEvent extends AiobsEnvelope {
  hook_event_name: "PreToolUse";
  session_id: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface PostToolUseEvent extends AiobsEnvelope {
  hook_event_name: "PostToolUse";
  session_id: string;
  tool_name: string;
  tool_use_id?: string;
  tool_response?: unknown;
  tool_error?: boolean;
}

export interface SessionEndEvent extends AiobsEnvelope {
  hook_event_name: "SessionEnd";
  session_id: string;
  transcript_path?: string;
}

export interface PreCompactEvent extends AiobsEnvelope {
  hook_event_name: "PreCompact";
  session_id: string;
  transcript_path?: string;
}

export interface StopEvent extends AiobsEnvelope {
  hook_event_name: "Stop";
  session_id: string;
}

export type HookEvent =
  | SessionStartEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | SessionEndEvent
  | PreCompactEvent
  | StopEvent;

export interface AutoTags {
  "claude_code.session_id"?: string;
  "claude_code.session_name"?: string;
  "claude_code.version"?: string;
  "claude_code.parent_session_id"?: string;
  "claude_code.parent_agent_name"?: string;
  "claude_code.tmux.window"?: string;
  "claude_code.tmux.pane"?: string;
  "claude_code.terminal.program"?: string;
  "claude_code.terminal.session_id"?: string;
  "gen_ai.conversation.id"?: string;
  "vcs.repository.name"?: string;
  "vcs.repository.url"?: string;
  "vcs.ref.head.name"?: string;
  "vcs.ref.head.revision"?: string;
  "service.name"?: string;
  "service.version"?: string;
  "host.name"?: string;
  "host.arch"?: string;
  "os.type"?: string;
  "os.version"?: string;
  "user.username"?: string;
  "user.id"?: string;
  "process.cwd"?: string;
  "process.pid"?: number;
  "process.runtime.name"?: string;
  "process.runtime.version"?: string;
  "process.executable.path"?: string;
}


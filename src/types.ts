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

export interface SessionStartEvent {
  hook_event_name: "SessionStart";
  session_id: string;
  model?: string;
  transcript_path?: string;
}

export interface UserPromptSubmitEvent {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  prompt?: string;
  message?: string;
}

export interface PreToolUseEvent {
  hook_event_name: "PreToolUse";
  session_id: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

export interface PostToolUseEvent {
  hook_event_name: "PostToolUse";
  session_id: string;
  tool_name: string;
  tool_use_id?: string;
  tool_response?: unknown;
  tool_error?: boolean;
}

export interface SessionEndEvent {
  hook_event_name: "SessionEnd";
  session_id: string;
  transcript_path?: string;
}

export interface PreCompactEvent {
  hook_event_name: "PreCompact";
  session_id: string;
  transcript_path?: string;
}

export interface StopEvent {
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


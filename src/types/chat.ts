export type MessageRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  isPending: boolean;
}

export interface ImageBlock {
  type: "image";
  data: string;      // base64
  mediaType: string; // "image/png" | ...
}

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  result?: string;
  isError?: boolean;
  isPending: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | SubagentBlock;

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** 纯展示用的模型选项——值和名字完全由 provider 决定，核心层不关心具体是什么模型 */
export interface ModelOption {
  value: string;
  displayName: string;
}

/** 当前会话的上下文窗口用量——每轮结束后由 sidecar 刷新一次。 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

/** 待办任务项——provider-agnostic，跟 agent-sidecar/src/types.ts 里的同名类型镜像。 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp: number;
  /** assistant 消息正在流式生成中（用于续写判定，替代对象身份比较） */
  streaming?: boolean;
  /** 这条 assistant 消息这一轮的 token 用量 + 费用 */
  usage?: TurnUsage;
}

export interface PermissionRequest {
  id: string;
  name: string;
  input: unknown;
}

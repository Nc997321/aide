/** 新建对话模式。纯聊天由会话能力档案识别，日常/工程沿用工作区归属判定。
 * 统一判定见 usePaneLayout.chatModeOf；能力装配策略见 sidecar sessionProfile。
 */
export type ChatMode = "daily" | "project" | "chat";

export interface ChatModeSpec {
  readonly id: ChatMode;
  readonly label: string;
}

export const CHAT_MODES: readonly ChatModeSpec[] = [
  { id: "chat", label: "纯聊天" },
  { id: "daily", label: "日常" },
  { id: "project", label: "工程" },
];

export const DEFAULT_CHAT_MODE: ChatMode = "daily";

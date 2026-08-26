// 协议类型——镜像桌面侧 src-tauri/src/remote/protocol.rs 与 src-tauri/src/commands/mod.rs。
// 中继是哑管道：只做字节级转发，不理解这些消息。

// ── 中继层首条消息（路由用）──
export type RelayConnect =
  | { type: "connect"; code: string }
  | { type: "connect"; device_id: string; token: string };

// ── 应用层：手机 → 桌面 ──
export type PhoneToDesktop =
  | { type: "pair"; code: string }
  | { type: "auth"; token: string }
  | {
      type: "send_message";
      session_id?: string | null;
      prompt: string;
      /** 目标工作区（编码 key，与 list_workspaces 返回一致）；缺省 = 桌面当前活动工作区 */
      workspace_key?: string;
    }
  | { type: "load_messages"; session_id: string }
  | { type: "list_sessions"; workspace_key?: string }
  | { type: "list_workspaces" };

// ── 应用层：桌面 → 手机 ──
export type DesktopToPhone =
  | { type: "pair_ok"; device_id: string; token: string }
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "event"; event: ChatEvent }
  | { type: "error"; message: string }
  | { type: "sessions"; sessions: Session[] }
  | { type: "workspaces"; workspaces: Workspace[] }
  | { type: "messages"; messages: LoadMessagesResult };

// ── ChatEvent：桌面透传的 sidecar 事件（对齐桌面 useChatSession.ts 处理的事件）──
export type ChatEvent =
  | { type: "text_delta"; session_id?: string; delta: string }
  | { type: "thinking"; session_id?: string; text: string }
  | { type: "thinking_delta"; session_id?: string; delta: string }
  | {
      type: "tool_use_start";
      session_id?: string;
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      session_id?: string;
      id: string;
      content: string;
      is_error: boolean;
    }
  | { type: "message_stop"; session_id?: string; usage?: unknown; effort?: string }
  | {
      type: "subagent";
      session_id?: string;
      id: string;
      agentName: string;
      description: string;
      prompt?: string;
    }
  | { type: "subagent_text_delta"; session_id?: string; id: string; delta: string }
  | { type: "subagent_thinking_delta"; session_id?: string; id: string; delta: string }
  | { type: "error"; session_id?: string; message: string; fatal?: boolean }
  | { type: "image"; session_id?: string; data: string; mediaType: string };

// ── 数据形状（镜像 src-tauri/src/commands/mod.rs）──
export interface Session {
  id: string;
  name: string;
  timestamp: number;
  last_message: string;
}

/** 工作区（镜像 WorkspaceInfo）：key = 路径编码，name = 桌面解码后的路径字符串 */
export interface Workspace {
  key: string;
  name: string;
  /** 目录已不在磁盘（桌面侧按 key 解码失败） */
  missing: boolean;
}

export type HistoryBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      result?: string | null;
      isError?: boolean | null;
    }
  | { type: "thinking"; text: string };

export interface ChatMessageItem {
  role: string;
  blocks: HistoryBlock[];
  timestamp: number;
}

/** load_messages 分页返回(与桌面侧 serde camelCase 镜像):消息页 + 下一页字节游标。
 *  nextOffsetBytes = 页首真实 user 行的起始字节;0 = 已到文件头(无更早页)。 */
export interface LoadMessagesResult {
  messages: ChatMessageItem[];
  nextOffsetBytes: number;
}

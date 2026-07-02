// Sidecar → Rust（每行一个 JSON，写入 stdout）
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "message_stop"; stop_reason: string; cost_usd: number | null }
  | { type: "error"; message: string };

// Provider-agnostic image attachment — same shape used by all future AI providers
export interface ImageAttachment {
  data: string;       // base64-encoded bytes, no data: prefix
  mediaType: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

// Rust → Sidecar（每行一个 JSON，从 stdin 读取）
export type SidecarCommand =
  | { cmd: "send"; prompt: string; images?: ImageAttachment[]; session_id?: string; cwd?: string }
  | { cmd: "permission_response"; id: string; approved: boolean }
  | { cmd: "interrupt" };

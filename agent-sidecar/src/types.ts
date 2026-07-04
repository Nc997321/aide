// 一轮对话的 token 用量 + 费用（跨该轮用到的所有模型汇总，如子代理另用了别的模型）
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

// 可切换模型——纯展示用的字符串，具体是什么模型完全由 provider 决定，
// 核心协议不关心也不校验值本身（多 provider 抽象红线）。
export interface ModelOption {
  value: string;
  displayName: string;
}

// 权限模式——同 ModelOption：value 是 provider 自己认的模式标识（Claude 的
// "default"/"plan"/"acceptEdits"），核心协议只当不透明字符串透传，不解释语义。
export interface PermissionModeOption {
  value: string;
  displayName: string;
}

/** 单个额度窗口——provider-agnostic：utilization 归一到 0-100（已用百分比），
 *  resets_at 是 unix 毫秒（拿不到为 null），label 由 sidecar 翻成人话。 */
export interface RateLimitWindow {
  key: string;
  label: string;
  utilization: number;
  resets_at: number | null;
}

/** 待办任务项——provider-agnostic，任何 agent 的"任务追踪"能力都映射成这个形状。 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// Sidecar → Rust（每行一个 JSON，写入 stdout）
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "subagent_start"; id: string; agentName: string; description: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "permission_cancelled"; id: string }
  | { type: "message_stop"; stop_reason: string; total_cost_usd: number | null; usage: TurnUsage | null }
  | { type: "models_available"; models: ModelOption[]; current: string }
  | { type: "permission_modes_available"; modes: PermissionModeOption[]; current: string }
  // 会话建立时 SDK 回传的权威 slash commands 清单（内置命令 + skills + 自定义命令），
  // 仅当 SDK 提供该字段时才发（见 mapper.ts 的 Array.isArray 判断）。
  | { type: "slash_commands_available"; commands: string[] }
  | { type: "context_usage"; total_tokens: number; max_tokens: number; percentage: number }
  // 订阅额度/速率可见化——provider-agnostic：一次带回全部并行窗口（5 小时 / 7 天 /
  // 各模型周窗等）。utilization 统一 0-100，label 由各 sidecar 翻成人话，核心协议
  // 不认识具体配额类型。subscription 为订阅档位（pro/max…），API Key/三方为 null。
  | { type: "rate_limit"; subscription: string | null; windows: RateLimitWindow[] }
  | { type: "tasks_update"; tasks: TaskItem[] }
  // fatal:false = 可恢复错误（进程仍存活、继续等下一条消息）；缺省/true = 致命。
  // 前端据此决定落 waiting+warning（红点）还是 stopped（灰点）。
  | { type: "error"; message: string; fatal?: boolean }
  // 存活心跳：sidecar 每 5s 发一次，由 Rust 消费并重置看门狗，不转发到前端。
  | { type: "heartbeat" }
  // 进程死亡：由 Rust（非 sidecar）合成——reader EOF 或看门狗超时。session_id 由
  // Rust 注入；detail 携带 stderr 尾部用于诊断。列在此处以统一 chat-event 协议真相源。
  | { type: "session_dead"; reason: "exit" | "heartbeat_timeout"; detail?: string };

// Provider-agnostic image attachment — same shape used by all future AI providers
export interface ImageAttachment {
  data: string;       // base64-encoded bytes, no data: prefix
  mediaType: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

// Rust → Sidecar（每行一个 JSON，从 stdin 读取）
export type SidecarCommand =
  | { cmd: "send"; prompt: string; images?: ImageAttachment[]; session_id?: string; cwd?: string; permission_mode?: string }
  // answers：仅 AskUserQuestion 场景使用（问题文本 → 选中答案/自由文本的不透明映射），
  // 其他工具的批准永远不带这个字段。核心协议不解释内容，只搬运。
  | { cmd: "permission_response"; id: string; approved: boolean; always?: boolean; answers?: Record<string, string> }
  | { cmd: "interrupt" }
  | { cmd: "set_model"; model: string }
  | { cmd: "set_permission_mode"; mode: string };

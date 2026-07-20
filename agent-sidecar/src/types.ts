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
  // model/modelLabel：本条 assistant 消息的真实 wire model（API 实际调用标识）——
  // 只盖在每条消息的首个块事件上（后续块事件不带）。modelLabel 是 sidecar 按
  // 别名表给出的展示建议（系统默认下是 "sonnet" 这类；第三方常解析出 Claude
  // 别名，前端按「在可选项列表里」校验，不在列回退 model 原文）。
  | { type: "text_delta"; delta: string; model?: string; modelLabel?: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown; model?: string; modelLabel?: string }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "subagent_start"; id: string; agentName: string; description: string; prompt?: string; model?: string; modelLabel?: string }
  // 子代理内部逐字流式增量——语义对齐主线程的 text_delta（stream_event 的 text_delta）。
  // thinking 主线程目前不转发，但这条子代理专属通道独立开放，不受此限制（v2）。
  | { type: "subagent_text_delta"; id: string; delta: string }
  | { type: "subagent_thinking_delta"; id: string; delta: string }
  // 子代理内部的"工具调用摘要"：报它调用了哪个工具+入参。toolUseId 是该工具调用在子代理
  // 内部的 id（不是 parent id），用于把后续 subagent_tool_result 的产出回填到对应步骤。
  // model 只在第一次能坐实时带一次，之后同一个 id 不再重复。prompt 只在非空时带（主代理
  // 派发时塞进 Agent 工具 input 的完整任务描述，如 superpowers 的 implementer 契约）。
  | { type: "subagent_progress"; id: string; toolUseId: string; toolName: string; input: unknown; model?: string }
  // 子代理内部某次工具调用的产出（子代理 user 消息里的 tool_result，带 parent_tool_use_id）。
  // 按 toolUseId 回填到对应步骤，让前端能看到子代理每步工具的输出，而不只是工具名+入参摘要。
  | { type: "subagent_tool_result"; id: string; toolUseId: string; content: string; is_error: boolean }
  // async（后台）子代理的 launch-ack：Agent 工具 tool_result 立即返回「Async agent
  // launched … agentId: … output_file: …」。此时子代理才刚起步，不能当结束——发这个
  // 事件告诉前端「在后台跑」，并带上 .output 路径，sidecar 的 tail 据此回放内部活动。
  | { type: "subagent_async_launched"; id: string; agentId: string; outputFile: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
  // alwaysAllowLabel：sidecar 已经把 SDK 的 suggestions 解读成一句人话（比如 Edit
  // 工具常见的"自动接受编辑（本次会话）"，而不是笼统的"总是允许"——两者后果差异很大：
  // 前者是切权限模式且不落盘，后者是给某工具加一条持久化规则），前端只管展示这句话，
  // 不需要也不应该重新解释 Claude 专属的 PermissionUpdate 结构。缺省时前端自己兜底
  // 显示"总是允许"。
  // fromSubagent：这次请求是不是子代理内部发起的（而不是主线程）——没有它，用户会
  // 在毫无上下文的情况下突然看到一个权限框弹出来，不知道是谁在问。缺省表示来自主线程。
  | {
      type: "permission_request";
      id: string;
      name: string;
      input: unknown;
      alwaysAllowLabel?: string;
      fromSubagent?: { id: string; agentName: string };
    }
  | { type: "permission_cancelled"; id: string }
  | { type: "message_stop"; stop_reason: string; total_cost_usd: number | null; usage: TurnUsage | null }
  | { type: "models_available"; models: ModelOption[]; current: string }
  // 模型切换的坐实回执——只在用户显式 set_model 后由 sidecar 运行时路径发出
  // （init/assistant 坐实、query 未起的本地落账都不发），让前端能给出
  // 「成功/失败」瞬时提示。ok:false 时 error 带 CLI 驳回原因，下拉已被回滚
  // 广播拉回旧值。display 是喂给提示文案的人类可读名（displayName，兜底 value）。
  | { type: "model_switch_result"; ok: boolean; model: string; display: string; error?: string }
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
  // 非致命通知：提示性消息（如供应商切换后会话迁移），前端展示为 info 样式。
  | { type: "notification"; message: string; notification_type: string }
  // 存活心跳：sidecar 每 5s 发一次，由 Rust 消费并重置看门狗，不转发到前端。
  | { type: "heartbeat" }
  // 进程死亡：由 Rust（非 sidecar）合成——reader EOF 或看门狗超时。session_id 由
  // Rust 注入；detail 携带 stderr 尾部用于诊断。列在此处以统一 chat-event 协议真相源。
  | { type: "session_dead"; reason: "exit" | "heartbeat_timeout"; detail?: string }
  // Runtime 健康快照：由 SessionManager 每 30s emit 一次，供前端诊断仪表盘消费。
  | {
      type: "health";
      sessions: { active: number; idle: number; stalled: number; total: number };
      processes: { claudeExeCount: number };
      timestamp: number;
    };

// Provider-agnostic image attachment — same shape used by all future AI providers
export interface ImageAttachment {
  data: string;       // base64-encoded bytes, no data: prefix
  mediaType: string;  // "image/png" | "image/jpeg" | "image/gif" | "image/webp"
}

// Rust → Sidecar（每行一个 JSON，从 stdin 读取）。
// 所有命令都带 session_id：SessionManager 按它路由到对应 SessionWorker。
export type SidecarCommand =
  | {
      cmd: "send";
      session_id: string;
      prompt: string;
      images?: ImageAttachment[];
      cwd?: string;
      permission_mode?: string;
      // 供应商连接身份真的漂移了才带 true——下一次 query() 时 forkSession。
      provider_switched?: boolean;
      // 忙碌时的"插队"标记：不在当前轮立刻打断，等安全边界再 interrupt。
      jump_queue?: boolean;
      // btw 支线对话:命中 → 下一次建 query() 时 resume fork_from + forkSession:true。
      // fork_from 是 fork 源会话 ID（BTW 自己的 session_id 仅用于路由，不传给 SDK）。
      btw?: boolean;
      lightweight?: boolean;
      fork_from?: string;
      // 重开已有会话时带：SDK 据此 resume 已有会话上下文。与 session_id（路由键）
      // 解耦——session_id 用于 SessionManager 路由，resume_session_id 用于 SDK resume。
      // 省略=全新会话不 resume。btw 用 fork_from + forkSession，不带这个。
      resume_session_id?: string;
      // per-session provider 连接参数覆盖（ANTHROPIC_BASE_URL / API_KEY 等）。
      // Runtime 启动后进程 env 不变，不同会话用不同 provider 靠此字段传递。
      env?: Record<string, string>;
    }
  | { cmd: "permission_response"; session_id: string; id: string; approved: boolean; always?: boolean; answers?: Record<string, string>; nextMode?: string }
  | { cmd: "interrupt"; session_id: string }
  | { cmd: "set_model"; session_id: string; model: string }
  | { cmd: "set_permission_mode"; session_id: string; mode: string }
  // 停止一个会话：Runtime 内部调 worker.stop()（q.close() + 清理），不再由 Rust kill 进程。
  | { cmd: "session_stop"; session_id: string };

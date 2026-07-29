import type { PermissionPolicySnapshot } from "./policy/types.js";

// 一轮对话的 token 用量 + 费用（跨该轮用到的所有模型汇总，如子代理另用了别的模型）
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  // —— 以下均为可选的诊断归因字段，provider 给不出就不带（不污染核心必填协议）——
  /** 本轮是否派发了子代理（Agent/Task 类工具）。SDK 的 modelUsage 按模型聚合、不按
   *  代理拆分，拿不到"父 X / 子代理 Y"的精确 token；这里只标注"本轮含子代理活动"，
   *  让前端把累计用量拆成"含子代理的轮次" vs "纯主会话轮次"两栏——足以回答
   *  "25M 里有多少来自触发了子代理的轮次"，不声称知道子代理内部精确 token。 */
  subagentTurn?: boolean;
  /** 本轮派发的子代理调用数（subagentTurn 为 true 时才带）。 */
  subagentCount?: number;
  /** 按模型分桶的用量——mapper 原本把 modelUsage 各模型条目摊平成上面五个总数，
   *  现在同时保留分桶，让多模型会话（如子代理用了别的模型）能看到每个模型各烧多少。
   *  key 是 wire model id（provider 专属字符串，前端只展示不解释）。 */
  byModel?: Record<string, TurnUsage>;
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
  // 子代理嵌套深度软警告（warn-only，不阻止调用）——子代理派子代理时深度超阈值，
  // 提示成本会指数膨胀。provider-agnostic：不带 Claude 专属字段，任何 provider 的
  // "子代理套子代理"都能映射成这个形状。depth 是当前嵌套深度，threshold 是告警阈值。
  | { type: "subagent_nesting_warning"; depth: number; threshold: number }
  // —— 后台 shell 任务（provider-agnostic：任何 provider 的"后台运行命令"都能映射成这三个事件）——
  // started：任务进入后台。id 是任务 id；toolUseId 关联消息流里发起它的工具卡片；
  // command/description 供列表展示；outputFile 只在确认输出落盘后带（同一 id 可能
  // 先收到不带 outputFile 的 started、后收到带 outputFile 的 upsert，前端按 id 合并）。
  | { type: "bg_task_started"; id: string; toolUseId?: string; command?: string; description?: string; outputFile?: string }
  // 输出增量——纯文本（ANSI 原样透传），过 deltaCoalescer 按 id 合并。
  | { type: "bg_task_output"; id: string; delta: string }
  // ended：任务到达终态。summary 是 provider 给的一句话结果摘要；durationMs 取 provider 统计。
  | { type: "bg_task_ended"; id: string; status: "completed" | "failed" | "stopped"; summary?: string; durationMs?: number }
  // fromSubagent：这次请求是不是子代理内部发起的（而不是主线程）——没有它，用户会
  // 在毫无上下文的情况下突然看到一个权限框弹出来，不知道是谁在问。缺省表示来自主线程。
  // Aide 权限策略只暴露 allow/deny/ask；"总是允许"的持久化由设置面板的权限规则管理，
  // 不再在确认弹窗里携带 SDK 专属的 PermissionUpdate / alwaysAllowLabel。
  | {
      type: "permission_request";
      id: string;
      name: string;
      input: unknown;
      fromSubagent?: { id: string; agentName: string };
    }
  | { type: "permission_cancelled"; id: string }
  | { type: "message_stop"; stop_reason: string; total_cost_usd: number | null; usage: TurnUsage | null }
  // 插队消息已登记、在等安全边界（当前工具调用跑完）才真正 interrupt——前端据此
  // 显示"待发出"提示条。prompt 供提示条展示原文。
  | { type: "jump_queued"; prompt: string }
  // 待插队消息已全部接入后续轮次（或不再需要提示）——前端清掉提示条。
  | { type: "jump_promoted" }
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
  // 上下文压缩生命周期——provider-agnostic：只表达任何 agent 都可能提供的阶段，
  // 不把 Claude 的 system/status / compact_result 细节泄露到核心协议。没有真实可测
  // 百分比时绝不带进度数值；detail/error 仅在 provider 能给出人类可读信息时提供。
  | {
      type: "context_compaction";
      stage: "compacting" | "completed" | "failed";
      detail?: string;
      error?: string;
    }
  // 订阅额度/速率可见化——provider-agnostic：一次带回全部并行窗口（5 小时 / 7 天 /
  // 各模型周窗等）。utilization 统一 0-100，label 由各 sidecar 翻成人话，核心协议
  // 不认识具体配额类型。subscription 为订阅档位（pro/max…），API Key/三方为 null。
  | { type: "rate_limit"; subscription: string | null; windows: RateLimitWindow[] }
  | { type: "tasks_update"; tasks: TaskItem[] }
  // 会话自动命名：首轮对话结束后 sidecar 用小模型生成的会话标题——
  // provider-agnostic（任何 provider 都能生成标题）。前端仅在用户未手动
  // 命名过时采纳（auto_rename_session 原子判断），否则忽略。
  | { type: "session_title"; title: string }
  // Rust command 应答：仅供运行期 reader 识别 probe_image_input 的结果，不转发为 UI 消息。
  | { type: "image_input_probe_result"; request_id: string; supported: boolean | null }
  // Rust reader 拦截的 agent 代码索引查询（不转发 Vue；响应走 codegraph_result 命令）。
  | {
      type: "codegraph_query";
      request_id: string;
      tool: string;
      args: Record<string, unknown>;
      project_root: string;
    }
  // 用户消息二次防线：provider-agnostic，不携带厂商专属字段；message 是可直接展示的人类说明。
  | { type: "image_input_rejected"; message: string }
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
      cmd: "probe_image_input";
      request_id: string;
      model?: string;
      env: Record<string, string>;
    }
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
      // 会话自动命名开关（来自设置面板）：false 时首轮后不生成会话标题。
      // 省略 = 开启。provider-agnostic：标题生成是通用能力。
      auto_title?: boolean;
      // 权限策略快照：Rust 在每次设置变更后推送，sidecar 在 PreToolUse 时
      // 用它做本地策略评估。省略 = 沿用上次快照或空策略（无匹配 → hook 不表态）。
      permission_policy?: PermissionPolicySnapshot;
    }
  | { cmd: "update_permission_policy"; session_id: string; policy: PermissionPolicySnapshot }
  | { cmd: "permission_response"; session_id: string; id: string; approved: boolean; answers?: Record<string, string>; nextMode?: string }
  | { cmd: "interrupt"; session_id: string }
  // 终止一个后台任务（provider-agnostic：任何 provider 的"停掉后台命令"都映射成它）。
  // 成功后任务会走正常终态通道（bg_task_ended, status:"stopped"），不需要额外回执事件。
  | { cmd: "stop_bg_task"; session_id: string; task_id: string }
  | { cmd: "set_model"; session_id: string; model: string }
  | { cmd: "set_permission_mode"; session_id: string; mode: string }
  // 停止一个会话：Runtime 内部调 worker.stop()（q.close() + 清理），不再由 Rust kill 进程。
  | { cmd: "session_stop"; session_id: string }
  // codegraph agent 查询的应答（Rust → sidecar，按 request_id 配对，无 session 路由）。
  | {
      cmd: "codegraph_result";
      request_id: string;
      ok: boolean;
      status?: string;
      results?: unknown[];
      candidates?: number;
      truncated?: boolean;
      error?: string;
    };

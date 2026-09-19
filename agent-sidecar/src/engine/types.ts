import type { PermissionMatcher, PermissionPolicySnapshot } from "./policy/types.js";
import type { BuiltinHookManifest } from "../extensions/builtinHooks/index.js";

/** 会话级权限规则草稿（前端推导、随 permission_response 透传）。与前端
 *  `PermissionRuleDraft` 同形：effect/tool/matcher，id/scope/order 由 sidecar
 *  入库时补全（scope 恒为 "session"）。 */
export interface PermissionRuleDraft {
  effect: "allow" | "deny" | "ask";
  tool: string;
  matcher: PermissionMatcher;
}

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
  /** 本轮 API 调用数（= SDK result 的 num_turns，turn 级、不按模型拆）。前端用它把
   *  ↓ 的累计输入拆成「N 次 × 平均每次」，让 4.2m 这种数不再反直觉（4.2m ÷ 20 ≈ ctx，
   *  每次重发全量上下文）。旧 sidecar / error result 不带，前端按 >1 才展示分解。 */
  apiCallCount?: number;
}

// 可切换模型——纯展示用的字符串，具体是什么模型完全由 provider 决定，
// 核心协议不关心也不校验值本身（多 provider 抽象红线）。
export interface ModelOption {
  value: string;
  displayName: string;
}

// 权限模式——同 ModelOption：value 是 provider 自己认的模式标识（Claude 的
// "manual"/"plan"/"auto"），核心协议只当不透明字符串透传，不解释语义。
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

/** 用户气泡的渲染描述（发起方构造 → sidecar 原样回灌 → 各端渲染）。
 *
 *  为什么需要它：发给模型的 `prompt` 是 @引用展开后的完整文本（用户自己打的字和
 *  引用文件内容已经混成一个字符串），结构信息在前端就被编译掉了，sidecar 拿不到。
 *  没有这层描述，带引用的消息在接收端会退化成一坨分不清彼此的文本——而现在桌面端
 *  是刻意把它们拆成独立卡片显示的。
 *
 *  语言/端无关：这里只描述"有什么"，不描述"怎么画"。mention 渲染成 Read 工具卡片
 *  是桌面端的选择，鸿蒙端可以渲染成折叠块。新增形态时各端自行决定如何降级。
 *  缺失整个 display 字段时（鸿蒙 v1 只有纯文本），接收方渲染纯文本气泡。 */
export type UserMessageBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string }
  // 动作胶囊（/compact 等斜杠命令）：显示 label/icon，发给模型的仍是 prompt。
  | { type: "action"; actionId: string; label: string; icon?: string }
  // @引用：path 供展示标题，content 是展开内容（模型收到的那部分）。range 表示
  // 只引用了这一段（编辑器选区），缺省=整文件。isDir 表示引用的是目录（@目录 =
  // 授权 + 一级清单，见 2026-09-17 跨目录方案）。与 aide-sdk/src/types/chat.ts 同形
  // ——**两份必须同形，漂移会让 display 静默失效**（降级成纯文本，不报错）。
  | { type: "mention"; path: string; content: string; range?: { start: number; end: number }; isDir?: boolean };

/** 占用来源明细的元素形状（见 context_usage 事件的说明）。与
 *  packages/aide-sdk/src/types/chat.ts 必须同形。 */
export interface ContextUsageMcpTool {
  name: string;
  serverName: string;
  tokens: number;
}
/** 内置工具 / 延迟加载的内置工具 / 系统提示分区共用形状（来源名 + 占用）。 */
export interface ContextUsageNamedItem {
  name: string;
  tokens: number;
}
export interface ContextUsageMemoryFile {
  path: string;
  type: string;
  tokens: number;
}
export interface ContextUsageAgent {
  agentType: string;
  source: string;
  tokens: number;
}
/** 六组互相独立可选：provider 没给该组就不出现（空数组同理）——前端据此不渲染
 *  该 section，而不是渲染一个空壳。 */
export interface ContextUsageBreakdown {
  mcpTools?: ContextUsageMcpTool[];
  systemTools?: ContextUsageNamedItem[];
  deferredBuiltinTools?: ContextUsageNamedItem[];
  systemPromptSections?: ContextUsageNamedItem[];
  memoryFiles?: ContextUsageMemoryFile[];
  agents?: ContextUsageAgent[];
}

// Sidecar → Rust（每行一个 JSON，写入 stdout）
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  // model/modelLabel：本条 assistant 消息的真实 wire model（API 实际调用标识）——
  // 只盖在每条消息的首个块事件上（后续块事件不带）。modelLabel 是 sidecar 按
  // 别名表给出的展示建议（系统默认下是 "sonnet" 这类；第三方常解析出 Claude
  // 别名，前端按「在可选项列表里」校验，不在列回退 model 原文）。
  | { type: "text_delta"; delta: string; model?: string; modelLabel?: string }
  // 主线程 thinking block 整块（partial-off 下 assistant 消息 content 里一次性到达，
  // 非逐字增量）。不盖 model/modelLabel——模型徽标由同消息首个 text/tool_use 块盖，
  // 思考块不抢。text 空时（provider 用 display=omitted）sidecar 直接不发。
  | { type: "thinking"; text: string }
  // 主线程 thinking 逐字增量（partial-on 下 stream_event 的 thinking_delta 转发）。
  // 与 thinking 整块互补：partial=on 走这条（流式），partial=off / 历史回放走 thinking
  // 整块。与 subagent_thinking_delta 对称（用 delta 字段、不带 id），可走 deltaCoalescer 合并。
  // text 空时（display=omitted）stream_event 不发本类型，故此处 delta 必非空。
  | { type: "thinking_delta"; delta: string }
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
  // 撤下一条挂起的权限请求。语义是「这条请求已终结，从队列移除」而**不是**
  // 「被取消」——批准、拒绝、abort、interrupt、模式切换连带放行都会发它
  // （正常决策也发：远程客户端做的决策只走命令通道，不广播这条事件，桌面端的
  // 弹窗就撤不下来）。前端按 id 从 pendingPermissions 里过滤，重复到达是 no-op。
  | { type: "permission_cancelled"; id: string }
  // effort：本轮实际生效的思考深度（sidecar 从回合结束信号里读到的权威值，
  // 可能含 provider 侧的静默降级）。可选字段——provider 没有 effort 概念就不带。
  | { type: "message_stop"; stop_reason: string; total_cost_usd: number | null; usage: TurnUsage | null; effort?: string }
  // effort 切换的回执/同步广播——用户显式 set_effort 后由 sidecar 发出。成功带新值；
  // 失败（provider 驳回）带回滚后的旧值 + error。query 未起时本地落账也发（无 error）。
  | { type: "effort_changed"; effort: string; error?: string }
  // 附加目录账本（@目录 授权）：**全量**账本、幂等，各端整份覆盖。dirs = 当前生效的
  // 全部附加目录；rejected = 本次被 Rust 判掉（未注册/非法）的条目；error = 活体扩根
  // （applyFlagSettings）失败的原文。后两者是"别静默"的回声，不参与授权。
  | { type: "workspace_attached"; dirs: string[]; rejected?: string[]; error?: string }
  // 插队消息已登记、在等安全边界（当前工具调用跑完）才真正 interrupt——前端据此
  // 显示"待发出"提示条。prompt 供提示条展示原文。
  | { type: "jump_queued"; prompt: string }
  // 待插队消息已全部接入后续轮次（或不再需要提示）——前端清掉提示条。
  | { type: "jump_promoted" }
  // 用户消息已入队的权威广播——**三端（桌面/鸿蒙/PWA）只认这条事件渲染用户气泡**，
  // 不再本地乐观渲染。这是「命令 → 事件」回灌闭环缺失的那一环：send 走命令通道，
  // agent 回复走事件通道，于是两端都能看见回复、只有发起方能看见自己提的问题。
  // 远程客户端发的消息要靠它才出现在桌面端，桌面端发的也靠它出现在手机上。
  // 幂等性由「单一渲染来源」保证：发起方不再本地画气泡，收到事件才画，因此不存在
  // 重复渲染，也不需要 message_id 去重。
  // 时序：插队消息在真正接入（promoteJumpQueue）时才发，不是登记（jump_queued）时发
  // ——接收端看到气泡的时机与模型真正收到这条消息的时机一致。
  | { type: "user_message"; text: string; display?: UserMessageBlock[] }
  | { type: "models_available"; models: ModelOption[]; current: string }
  // 模型切换的坐实回执——只在用户显式 set_model 后由 sidecar 运行时路径发出
  // （init/assistant 坐实、query 未起的本地落账都不发），让前端能给出
  // 「成功/失败」瞬时提示。ok:false 时 error 带 CLI 驳回原因，下拉已被回滚
  // 广播拉回旧值。display 是喂给提示文案的人类可读名（displayName，兜底 value）。
  | { type: "model_switch_result"; ok: boolean; model: string; display: string; error?: string }
  // 模型切换的成本确认请求（SDK PreModelSwitch hook 触发，仅在「缓存热 + 上下文
  // 有体量」时发出）：sidecar 挂起等前端决定，超时 10s 按 deny 收尾（挂起不悬死）。
  // estimated_cache_write_usd 是 SDK 报告的切过去重铺缓存预估美元成本。
  | {
      type: "model_switch_confirm";
      confirm_id: string;
      from_model: string;
      to_model: string;
      // SDK 预声明的切换来源枚举（PreModelSwitchHookInput.source）
      source: "command" | "picker" | "sdk";
      context_tokens: number;
      prompt_cache_warm: boolean;
      estimated_cache_write_usd: number;
      cache_ttl: "5m" | "1h";
    }
  // 模型切换的进程坐实（SDK PostModelSwitch）：切换真实完成后到达（source 同 SDK 枚举；
  // 前端 own 的 models_available spawn 对账不经事件通道）。前端据此**只终结挂起的
  // 成本确认弹窗**——落盘与坐实已换轴到 model_switch_result(ok)（sidecar 归一真名值）。
  // requested_model 是 CLI 别名命名空间回显，纯信息字段，不进账面/不落盘
  // （2026-09-11 sonnet 事故）。
  | {
      type: "model_committed";
      from_model: string;
      to_model: string;
      requested_model: string | null;
      source: "command" | "picker" | "sdk" | "auto" | "resume";
    }
  | { type: "permission_modes_available"; modes: PermissionModeOption[]; current: string; error?: string }
  // 会话建立时 SDK 回传的权威 slash commands 清单（内置命令 + skills + 自定义命令），
  // 仅当 SDK 提供该字段时才发（见 mapper.ts 的 Array.isArray 判断）。
  | { type: "slash_commands_available"; commands: string[] }
  // 内建 hook 清单：query 启动后 emit 一次（扩展管理设置页的 hook 列表用，
  // Task 3 只发、前端消费在 Task 10）。provider-agnostic 不透明数组。
  | { type: "builtin_hooks_manifest"; manifest: BuiltinHookManifest[] }
  // 上下文窗口用量。categories 是 provider 自报的占用分类拆解（如系统提示/工具/
  // 消息/MCP/技能），name 为不透明标签——前端按名映射色板，未知名落兜底色，
  // 核心协议不识别具体分类语义；缺省时前端退化为只显示总量。raw_max_tokens 为
  // 完整上下文窗（含保留给响应的区间），配合 max_tokens 表达"保留区"；缺省不画。
  //
  // breakdown 是同一份用量的**第二个切面**：categories 说「窗口怎么分块的」，
  // breakdown 说「这些 token 是谁的」（哪个 MCP server 的哪条工具、哪份记忆文件…）。
  // 两者粒度不同（类 vs 实例），**不保证合计相等**（例如延迟加载的工具是否计入
  // mcpTools 未验证）——所以前端分两处展示，不做"分类行下钻"的挂靠。
  // 元素命名与 categories 一致用 camel（嵌套元素随 SDK 源字段，见 isDeferred），
  // 顶层仍是 snake；这样边界守卫的输出形状即 wire 形状，前端零改名。
  // 刻意不带（只列名；逐条理由与裁剪决策在 queryTelemetry.ts 的 toBreakdown，那里是
  // 唯一所在）：color / gridRows / model / slashCommands / skills / messageBreakdown /
  // apiUsage / autoCompact* / 各元素的 isLoaded。
  | {
      type: "context_usage";
      total_tokens: number;
      max_tokens: number;
      percentage: number;
      raw_max_tokens?: number;
      categories?: { name: string; tokens: number; isDeferred?: boolean }[];
      breakdown?: ContextUsageBreakdown;
    }
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
  // btw 侧问（官方 side_question 控制通道）的一次问答结果。sessionId 是 worker
  // 自己的 routingKey——stdout 帧的 session_id 由 SessionManager 注入；前端据此把
  // 事件路由回**主会话**（btw 不再有独立 session id）。question 用于同一会话多条
  // btw 之间消歧。response 与 error 互斥；synthetic=true = 官方兜底答复（渲染但
  // 不入跨问历史）。背压期间**不可丢弃**（丢一条就少一个答案）。
  | {
      type: "btw_answer";
      sessionId: string;
      question: string;
      response?: string;
      error?: string;
      synthetic?: boolean;
    }
  // Rust reader 拦截的 agent 代码索引查询（不转发 Vue；响应走 codegraph_result 命令）。
  | {
      type: "codegraph_query";
      request_id: string;
      tool: string;
      args: Record<string, unknown>;
      project_root: string;
    }
  // Rust reader 拦截的 agent LSP 查询（不转发 Vue；响应走 lsp_result 命令）。
  // 与 codegraph 的区别：查询本体不跳 runner——LspManager 就在主进程就地执行
  // （见 src-tauri/src/runtime/lsp_agent.rs）。
  | {
      type: "lsp_query";
      request_id: string;
      tool: string;
      args: Record<string, unknown>;
      workspace_root: string;
    }
  // Rust reader 拦截的内嵌浏览器查询（不转发 Vue；响应走 browser_result 命令）。
  // op 面**刻意收窄**为三个机制词汇——页面语义（正文/表格/表单）全在 sidecar 的投影脚本里，
  // 不进协议（见 src-tauri/src/browser/agent_bridge.rs 头注释：换站点时 Rust 一行不动）。
  | {
      type: "browser_query";
      request_id: string;
      op: "list_views" | "eval" | "call_cdp";
      /** 缺省 = 由 Rust 执行体按「唯一可见 → 唯一存在」解析；歧义时回错误并附清单。 */
      view_id?: string;
      /** op=eval */
      script?: string;
      /** op=call_cdp */
      method?: string;
      params?: unknown;
    }
  // 用户消息二次防线：provider-agnostic，不携带厂商专属字段；message 是可直接展示的人类说明。
  | { type: "image_input_rejected"; message: string }
  // 图片 400 回滚：模型不支持图片时，sidecar 已从会话历史移除带图消息（会话不报废）。
  // text 是被移除消息的文本——前端放回输入框，用户手动重发。
  | { type: "image_input_rollback"; text: string }
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

/** send.images 的**线形状**：两种形式互斥（`data` 或 `path` 恰好一个在场）。
 *  归一（路径 → 内嵌）在 send 入口完成，实现与守卫见 engine/imageAttachments.ts。
 *
 *  - `{data, mediaType}` 内嵌 base64——桌面与既有网关在用。mediaType 仍**必填**、
 *    不做嗅探：对既有契约零改动（放松必填会让已写好的调用方开始依赖新默认值）。
 *  - `{path}` 引擎本地读取——headless 网关传大图用，绕开 /invoke 的 1MB body 上限。
 *    **不传 mediaType**：字节在引擎手里，按魔数嗅探才是权威值，不该由调用方猜。
 *
 *  为什么不用标签（kind/source）分派：那个手法是用来承载**字段名表达不了的意图**
 *  的（approve / answer / deny / unanswered 都是"若干字段在场"，标签才分得开）。
 *  这里 `data` 与 `path` 字面就说清了差别，再加标签是冗余。 */
export type WireImageAttachment =
  | { data: string; mediaType: string }
  | { path: string };

// ---- btw 侧问的线上契约（命令与事件共用） ----

/** btw 跨问历史的一条问答。形状与官方 side_question 的 history 元素逐字段对齐
 *  （`{question, response}`，见 claude.exe 的 `history:x.map(pe=>({question,response}))`）
 *  ——改这个形状等于改线上契约，前端 `api.btwAsk` 要同步改。 */
export type BtwHistoryRound = { question: string; response: string };

/** btw_ask 命令的效果：只表成败。正文一律走 btw_answer 事件
 *  （UI 状态只认事件通道），不随命令响应回来。 */
export type AskSideQuestionResult = { ok: true } | { ok: false; reason: string };

// ---- permission_response 的标签联合线形状（官方推荐形态） ----
//
// 与扁平字段袋（approved / answers / nextMode / message / sessionRules）**互斥**：
// 一条命令里二者只能在场一个（headless 的 zod 边界用 superRefine 强制；桌面 Rust、
// 远程、ohos 恒发扁平形态，永不发本形状）。归一读法见 engine/permissionResponse.ts。
//
// 变体按「引擎能力」一一对应，不多不少——判据：两条变体若落到同一段引擎代码即为
// 过覆盖（装饰），引擎有能力而这里表达不出即为欠覆盖。故**不设** `skip`（与 `deny`
// 同一路径，零能力差异；它是调用方 UI 的按钮文案，不进协议）。
//
// 变体名一律取仓库既有词汇（无新概念）：`deny` 用既有 approved 对偶，`answer` 用
// AskUserQuestion「作答」，`unanswered` 用「无人应答」（permissions.ts 既有措辞）。
export type PermissionResponseWire =
  // 放行（可带模式迁移与会话级规则——两者都只在放行路径生效）
  | { kind: "approve"; nextMode?: string; sessionRules?: PermissionRuleDraft[] }
  // 放行问答：作答重塑进 updatedInput（SDK 契约，仅 AskUserQuestion；answers 必填）
  | { kind: "answer"; answers: Record<string, string> }
  // 人拒绝：message = 人的原话或转述 → 官方 YFe（有附言）/ nhe（无附言）外框
  | { kind: "deny"; message?: string }
  // 无人应答：reason = 调用方自己的说法（引擎不发明）→ 官方「无人工审批可用」外框。
  // 语义边界：引擎**没有定时器**，"超时"是调用方自己的机制——故本变体命名的是
  // 引擎可见的不变量（没人应答），不是调用方的计时器。
  | { kind: "unanswered"; reason?: string };

// Rust → Sidecar（每行一个 JSON，从 stdin 读取）。
// 所有命令都带 session_id：SessionManager 按它路由到对应 SessionWorker。
export type SidecarCommand =
  | {
      cmd: "send";
      session_id: string;
      prompt: string;
      /** 图片附件线形状（内嵌 base64 / 引擎本地路径，二选一）→ engine/imageAttachments.ts */
      images?: WireImageAttachment[];
      // 发起方附带的渲染描述：sidecar 不解释内容，只原样随 user_message 事件回灌。
      // 桌面端用它把 @引用/动作胶囊渲染成独立卡片；鸿蒙/PWA 不发此字段，接收端
      // 降级为纯文本气泡。
      display?: UserMessageBlock[];
      cwd?: string;
      permission_mode?: string;
      // 附加目录：**客户端已知全量**（不是"本条新增"），Rust 已裁定过（只认已注册
      // 工作区）。并集合并进 worker 账本 → spawn 落 options.additionalDirectories、
      // 会话中落 applyFlagSettings。缺席（旧端/鸿蒙）与空数组等价：不动账本。
      additional_dirs?: string[];
      // 本次被 Rust 判掉、没进 additional_dirs 的条目——纯回声（前端显示"未注册，已忽略"）。
      attach_rejected?: string[];
      // 供应商连接身份真的漂移了才带 true——下一次 query() 时 forkSession。
      provider_switched?: boolean;
      // 忙碌时的"插队"标记：不在当前轮立刻打断，等安全边界再 interrupt。
      jump_queue?: boolean;
      // btw 支线对话:命中 → 下一次建 query() 时 resume fork_from + forkSession:true。
      // fork_from 是 fork 源会话 ID（BTW 自己的 session_id 仅用于路由，不传给 SDK）。
      // fork_from 省略/空 = 不 fork,全新会话——btw 任务支线(git-commit)走这条路:
      // 不背主会话历史,token 最省。
      // 自动化运行（无人值守 headless 会话，调度器发起）：与 btw 的区别是
      // 转录落盘（persistSession 不动）。preset 是权限预设（auto=CLI 自动裁决/
      // full=全放行）；tools 恒为 ["*"]（可见性不收口，行为层收口）；
      // mcp_allowlist 是预授权连接器 server key（policy hook 按它裁决 MCP 工具）；
      // 终态（message_stop/error）后 worker 自毁。
      automation?: {
        task_id: string;
        run_id: string;
        preset?: string;
        tools: string[];
        mcp_allowlist: string[];
        // 任务目录绝对路径：写工具落进此目录即放行（蒸馏/自愈合写回在 cwd 之外）
        task_dir?: string;
        // 会话目录绝对路径（协议一等字段，非 env 影子参数）：子进程
        // CLAUDE_CONFIG_DIR 指到这里，转录落 <session_dir>/projects/<cwd 编码>/。
        // Rust 侧恒发（scoped_claude_home 作用域隔离目录或任务显式指定）；
        // 省略/空 = 旧版主进程未下发，跟随 sidecar 全局配置根。
        session_dir?: string;
        max_turns?: number;
        max_budget_usd?: number;
        // 蒸馏轮置 true：resume 运行会话但 fork 成新 SDK 会话 id——否则 worker
        // re-key 后与运行会话同 id，任何发往运行会话的命令（关 tab 的
        // session_stop / ESC interrupt）都会误杀蒸馏（2026-08-23 实锤）
        fork?: boolean;
      };
      // 重开已有会话时带：SDK 据此 resume 已有会话上下文。与 session_id（路由键）
      // 解耦——session_id 用于 SessionManager 路由，resume_session_id 用于 SDK resume。
      // 省略=全新会话不 resume。btw 用 fork_from + forkSession，不带这个。
      resume_session_id?: string;
      // per-session provider 连接参数覆盖（ANTHROPIC_BASE_URL / API_KEY 等）。
      // Runtime 启动后进程 env 不变，不同会话用不同 provider 靠此字段传递。
      env?: Record<string, string>;
      // 会话元数据（headless 网关塞租户上下文）：引擎不解释内容，进程内 hooks 经
      // HookBuildContext.session.metadata() 读取。**绝不注入 cliEnv**——子进程 env
      // 会被 Bash 工具继承，模型可外带凭据（安全红线，见 sessionMetadata.ts）。
      // 每条 send 刷新（缺席 = 清空）。省略 = 无元数据（桌面路径恒省略）。
      metadata?: Record<string, unknown>;
      // MCP HTTP/SSE 请求头注入（会话级授权身份，headless 网关下发）：
      // serverName → headers，"*" = 所有 http/sse 型 server（同键精确名优先）。
      // 注入头覆盖 server 配置自带同名头。mcpServers 随 query() spawn 固化——
      // 刷新的新头在下一次 query() 重连才生效。值是凭据：不得进日志（N5）。
      // 每条 send 刷新（缺席 = 清空）。省略 = 无注入（桌面路径恒省略）。
      mcp_headers?: Record<string, Record<string, string>>;
      // 会话自动命名开关（来自设置面板）：false 时首轮后不生成会话标题。
      // 省略 = 开启。provider-agnostic：标题生成是通用能力。
      auto_title?: boolean;
      // 思考展示开关：false 时 mapper 剥掉 thinking 块（ollama 端点不认
      // thinking 参数，API 层关不掉，只能展示层剥——见 mapper.ts 注释）。
      thinking_enabled?: boolean;
      // 输出样式（内置四款；值域见 session-worker/outputStyle.ts 的 OUTPUT_STYLES，
      // 那里不含 "default"）。Rust 从设置读出后随每条 send 下发**非默认值**，但只在
      // **新建会话**（建 query）时落地——改动不影响已在跑的会话（与 thinking 同款）。
      // 省略 = 按默认处理；"default" / 空串 / 未知值同样归一为默认。
      // btw 支线与 automation 运行不下发本字段（见 outputStyle.ts 头注）。
      output_style?: string;
      // 工作区信任标志：Rust 在 send_message / start_btw_session 里按 cwd 查
      // trustedWorkspaces 白名单后注入。true（或省略，向后兼容/测试）= 信任，
      // 加载项目 CLAUDE.md / .claude/skills/ / .mcp.json；false = 受限模式，
      // startLoop 据此跳过项目级自动配置。省略时 sidecar 按信任处理。
      trusted?: boolean;
      // 工作区级代码索引开关：Rust 按 cwd 查 state.json 的 codegraph_workspaces
      // 注入（每工作区默认关）。true（或省略，向后兼容/测试）= 开，挂载 aide-codegraph
      // MCP；false = 该工作区未开索引，不注册 codegraph MCP 工具（chat.rs /
      // automation scheduler 四处构造点下发）。
      codegraph_enabled?: boolean;
      // 权限策略快照：Rust 在每次设置变更后推送，sidecar 在 PreToolUse 时
      // 用它做本地策略评估。省略 = 沿用上次快照或空策略（无匹配 → hook 不表态）。
      permission_policy?: PermissionPolicySnapshot;
    }
  | { cmd: "update_permission_policy"; session_id: string; policy: PermissionPolicySnapshot }
  | {
      cmd: "permission_response";
      session_id: string;
      id: string;
      // 标签形态（官方推荐，见 PermissionResponseWire）与扁平形态**二选一**：
      // response 在场即标签形态，approved 在场即扁平形态，恰好一个在场（schema
      // 用 superRefine 强制；两者皆无或皆有 = 400）。类型上两个字段都可选，
      // 互斥由 boundary schema 与 engine/permissionResponse.ts 的归一共同保证。
      response?: PermissionResponseWire;
      approved?: boolean;
      answers?: Record<string, string>;
      nextMode?: string;
      message?: string;
      // 会话级规则草稿（前端推导，如「允许后本会话内同文件编辑不再询问」）：
      // 随放行原子入库，worker 销毁即消失。纯内存态，不持久化、不进策略快照。
      sessionRules?: PermissionRuleDraft[];
    }
  | { cmd: "interrupt"; session_id: string }
  // 终止一个后台任务（provider-agnostic：任何 provider 的"停掉后台命令"都映射成它）。
  // 成功后任务会走正常终态通道（bg_task_ended, status:"stopped"），不需要额外回执事件。
  | { cmd: "stop_bg_task"; session_id: string; task_id: string }
  | { cmd: "set_model"; session_id: string; model: string }
  // 模型切换成本确认的用户决定（前端确认对话框 → sidecar），对 model_switch_confirm
  // 挂起的 hook resolve。超时/会话停止时 sidecar 自行按 deny 收尾。
  | { cmd: "model_switch_confirm_decision"; session_id: string; confirm_id: string; approve: boolean }
  // 会话级思考深度切换（provider-agnostic 不透明字符串；Claude sidecar 解释为
  // low/medium/high/xhigh/max）。首条消息前的初始值走 send 的 env 通道
  // （CLAUDE_CODE_EFFORT_LEVEL，与 ANTHROPIC_MODEL 同形），这里只管存活会话的切换。
  | { cmd: "set_effort"; session_id: string; effort: string }
  | { cmd: "set_permission_mode"; session_id: string; mode: string }
  // 停止一个会话：Runtime 内部调 worker.stop()（q.close() + 清理），不再由 Rust kill 进程。
  | { cmd: "session_stop"; session_id: string }
  // btw 侧问（官方 side_question 控制通道）。与 send 的关键区别：**不走
  // getOrCreate**——主 worker 不存在即拒，不起新进程（设计决策 D2）。
  // 结果一律经 btw_answer 事件回来，本命令无返回值（fire-and-forget，与 send 同形）。
  | {
      cmd: "btw_ask";
      session_id: string;
      question: string;
      history?: BtwHistoryRound[];
    }
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
    }
  // 内嵌浏览器查询的应答（Rust → sidecar，按 request_id 配对，无 session 路由）。
  // data 刻意用 unknown 而非扁平字段：载荷随 op 而变（视图列表 / 脚本返回值 / CDP 返回值），
  // 不像 codegraph 那样形状固定。
  | {
      cmd: "browser_result";
      request_id: string;
      ok: boolean;
      data?: unknown;
      error?: string;
    };

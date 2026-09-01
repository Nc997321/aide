export type MessageRole = "user" | "assistant";

/** 降级标记类型：标识 block 的哪个大载荷被摘要占位替换。 */
export type TruncatedKind = "text" | "thinking" | "tool_result" | "image_data" | "subagent_entries" | "subagent_result";

/** block 降级标记：大载荷已替换为摘要占位。originalBytes = 降级前估算字节(UTF-16,
 *  length×2)——占位文案「原 N 字」+ P1 字节游标取回 + 记账。P0-3 阶段不可逆(淘汰即丢
 *  全文)，P1 落地后按 block id + 字节游标从后端取回全文，此标记向前兼容(保留 id 即可)。 */
export interface TruncatedInfo {
  kind: TruncatedKind;
  originalBytes: number;
}

export interface TextBlock {
  type: "text";
  text: string;
  truncated?: TruncatedInfo;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  isPending: boolean;
  truncated?: TruncatedInfo;
}

export interface ImageBlock {
  type: "image";
  data: string;      // base64
  mediaType: string; // "image/png" | ...
  truncated?: TruncatedInfo;
}

/** 子代理内部时间线上的一项——按到达顺序混排文本/thinking 增量累积的段落，以及
 *  一次完整的工具调用（工具调用没有"增量"概念，一次到位）。tool 项的 toolUseId 是该
 *  调用在子代理内部的 id，sidecar 的 subagent_tool_result 据此把产出回填到 result。
 *  truncated：P2-1 写入时上限（SUBAGENT_ENTRY_CAP）截头保尾后的截断标记——与块级
 *  TruncatedInfo 同构，UI 有现成渲染路径（text/thinking 走 .sa-truncated 小标，
 *  tool 走 asToolBlock 透传给 ToolCallBlock 的 .ti-truncated）。 */
export type SubagentEntry =
  | { type: "text"; text: string; truncated?: TruncatedInfo }
  | { type: "thinking"; text: string; truncated?: TruncatedInfo }
  | { type: "tool"; toolUseId: string; toolName: string; input: unknown; result?: string; isError?: boolean; truncated?: TruncatedInfo };

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  /** 主代理派发时塞进 Agent 工具 input 的完整任务描述（task prompt，如 superpowers 的
   *  implementer 契约）——非空时展开态顶部渲染"派发指令"区。 */
  prompt?: string;
  /** 子代理具体跑在哪个模型上——只在 sidecar 第一次坐实时才有值，之后不会变。 */
  model?: string;
  /** 运行期间收到的时间线，按到达顺序追加；用于展开态还原"子代理具体做了什么"。 */
  entries: SubagentEntry[];
  result?: string;
  /** P2-1 写入时上限截断标记：result 超 SUBAGENT_ENTRY_CAP 时截头保尾。独立字段而非
   *  truncated——后者是 P0-3 整块降级标记（degradeBlock 靠它幂等），混用会让已截断
   *  result 的块跳过 entries 清空降级。 */
  resultTruncated?: TruncatedInfo;
  isError?: boolean;
  isPending: boolean;
  /** async（后台）子代理：launch-ack 到达后标记，UI 显示「后台运行中」。
   *  回放的工具链/模型由 sidecar tail 经 subagent_progress 等事件推，与 sync 同路。 */
  asyncLaunched?: { agentId: string; outputFile: string };
  truncated?: TruncatedInfo;
}

/** 用户侧「动作胶囊」——由工具栏快捷操作（压缩/清空上下文等）触发。底层仍把
 *  对应的斜杠命令（/compact /clear）当普通 prompt 发给 sidecar，这里只是纯展示：
 *  把「用户做了一次操作」渲染成区别于普通发言的胶囊气泡，而非裸露的 /compact 文本。
 *  不进 IPC 协议（SidecarCommand/ChatEvent），是前端独有的展示块。 */
export interface ActionBlock {
  type: "action";
  actionId: string; // "compact" | "clear" | "btw" | ...
  label: string; // 胶囊/批注显示文本
  icon?: string; // 胶囊前缀图标（字符或 SVG 名），btw 用 "↳"
  // btw 批注扩展(仅 actionId==='btw' 使用):可折叠页边批注,展开看结论全文。
  // 其余 action(/compact /clear)忽略这些字段,仍走原药丸胶囊渲染。
  foldable?: boolean;
  body?: string; // 结论全文
  hint?: string; // 折叠头尾部提示,如"不进上下文"
}

/** 主线程思考块——sidecar 把 assistant 消息 content 里的 thinking block 整块转发
 *  （partial-off 下非逐字）。文本为空时 sidecar 直接不发，故此处 text 必非空。
 *  视觉对齐子代理 .sa-thinking（灰斜体小字），渲染在它对应的 text/tool_use 之前。 */
export interface ThinkingBlock {
  type: "thinking";
  text: string;
  truncated?: TruncatedInfo;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ImageBlock | SubagentBlock | ActionBlock;

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  /** 本轮是否派发了子代理——前端据此把累计用量拆成"含子代理轮次" vs "纯主会话轮次"。可选，旧 sidecar 不带。 */
  subagentTurn?: boolean;
  /** 本轮派发的子代理调用数（subagentTurn 为 true 时带）。可选。 */
  subagentCount?: number;
  /** 按模型分桶用量（多模型时带，单模型不带）。key 是 wire model id，前端只展示不解释。可选。 */
  byModel?: Record<string, TurnUsage>;
  /** 本轮 API 调用数（SDK result.num_turns，turn 级、不按模型拆）。前端 tooltip 据它把
   *  ↓ 累计输入拆成「N 次 × 平均每次」，让 4.2m 这种数不再反直觉（4.2m ÷ 20 ≈ ctx）。
   *  >1 才展示分解；N=1 时 ↓ 本就 ≈ ctx。可选，旧 sidecar 不带。 */
  apiCallCount?: number;
}

/** 纯展示用的模型选项——值和名字完全由 provider 决定，核心层不关心具体是什么模型 */
export interface ModelOption {
  value: string;
  displayName: string;
}

/** 模型切换的坐实回执——跟 agent-sidecar/src/types.ts 的 model_switch_result 事件
 *  镜像（前端侧补一个 seq：单调递增，连续两次切同一个模型也能触发 watcher）。
 *  ok:false 时 error 带驳回原因，下拉已被 sidecar 的回滚广播拉回旧值。 */
export interface ModelSwitchResult {
  ok: boolean;
  model: string;
  display: string;
  error?: string;
  seq: number;
  /** 事件到达前端的本地时间戳——面板据它判断新鲜度：切 tab 回来时旧回执
   *  会重新进入 watcher（seq 从 undefined 变回 N），靠它抑制过期提示。 */
  at: number;
  /** true = 未启动会话的本地 deferred 回执（无活 sidecar 可坐实，选择随下一条
   *  消息的 initialModel 生效）；缺省/false = sidecar 运行时坐实回执。 */
  deferred?: boolean;
}

/** 权限模式选项——同 ModelOption：value 是 provider 自己认的不透明标识，
 *  语义由 sidecar 解释，跟 agent-sidecar/src/types.ts 里的同名类型镜像。 */
export interface PermissionModeOption {
  value: string;
  displayName: string;
}

/** 上下文占用的单条分类（provider 自报，name 为不透明标签——UI 按名映射色板，
 *  未知名落兜底色）。categories 是 provider 自报的占用分类拆解；缺省时环形照常
 *  工作、明细退化为空。rawMaxTokens 为完整窗（含保留给响应的区间），配合
 *  maxTokens 表达"保留区"；缺省不画。每轮结束后由 sidecar 刷新一次。 */
export interface ContextUsageCategory {
  name: string;
  tokens: number;
  isDeferred?: boolean;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  rawMaxTokens?: number;
  categories?: ContextUsageCategory[];
}

/** 上下文压缩的瞬态展示状态。它不属于 ChatMessage，也不进历史记录；成功事件会
 * 立即清空它，故前端只需渲染真正仍在进行或需要提示的失败状态。 */
export interface ContextCompactionState {
  stage: "compacting" | "failed";
  /** 首次收到压缩生命周期信号的本地时间，用于展示真实已用时长。 */
  startedAt: number;
  detail?: string;
  error?: string;
}

/** 单个额度窗口——跟 agent-sidecar/src/types.ts 的 RateLimitWindow 镜像。
 *  utilization 为已用百分比 0-100，resetsAt 是 unix 毫秒。 */
export interface RateLimitWindow {
  key: string;
  label: string;
  utilization: number;
  resetsAt: number | null;
}

/** 订阅额度/速率——provider-agnostic，跟 sidecar 的 rate_limit 事件镜像。
 *  windows 为空表示非订阅计费或 provider 不报配额，UI 隐藏。 */
export interface RateLimitInfo {
  subscription: string | null;
  windows: RateLimitWindow[];
}

/** 待办任务项——provider-agnostic，跟 agent-sidecar/src/types.ts 里的同名类型镜像。 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** 后台 shell 任务——provider-agnostic，镜像 sidecar 的 bg_task_* 事件流。
 *  output 是迄今累计的纯文本输出（ANSI 原样，给 xterm 渲染），增量追加、超长截头。
 *  结束的任务不立即移除（用户可能正看着），下次点开面板时才清理。 */
export interface BgTask {
  id: string;
  /** 发起它的工具卡片 id（消息流里的 Bash tool_call），用于卡片上的「后台运行中」徽章。 */
  toolUseId?: string;
  command?: string;
  description?: string;
  status: "running" | "completed" | "failed" | "stopped";
  output: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp: number;
  /** 页折叠占位（微博式回收）：远端页滚出视口后整页折叠成这一条 marker，
   *  blocks[0].text = 「↑ 更早的 N 条消息」。ChatPanel 渲染为单行，点击/滚回恢复。 */
  markerFor?: string;
  /** assistant 消息正在流式生成中（用于续写判定，替代对象身份比较） */
  streaming?: boolean;
  /** 这条 assistant 消息这一轮的 token 用量 + 费用 */
  usage?: TurnUsage;
  /** 这一轮实际生效的 effort 档位（sidecar 从回合结束信号读到的权威值，含
   *  静默降级）——usage 行徽标的数据源；模型不支持 effort 时不带。 */
  turnEffort?: string;
  /** 这条回答实际使用的模型（API 落盘 wire 标识，比模型自报可靠）——由
   *  sidecar 盖在消息首个块事件上；历史消息（transcript 重建）没有。 */
  model?: string;
  /** sidecar 给的展示建议（别名）：在可选项列表里才采用，否则展示 model 原文。 */
  modelLabel?: string;
}

export interface PermissionRequest {
  id: string;
  name: string;
  input: unknown;
  /** 这次请求是不是某个子代理内部发起的（而不是主线程）——缺省表示来自主线程。
   *  没有它，用户会在毫无上下文的情况下突然看到权限框弹出来，不知道是谁在问。 */
  fromSubagent?: { id: string; agentName: string };
}

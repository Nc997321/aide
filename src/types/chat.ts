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

/** 子代理内部时间线上的一项——按到达顺序混排文本/thinking 增量累积的段落，以及
 *  一次完整的工具调用（工具调用没有"增量"概念，一次到位）。tool 项的 toolUseId 是该
 *  调用在子代理内部的 id，sidecar 的 subagent_tool_result 据此把产出回填到 result。 */
export type SubagentEntry =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolUseId: string; toolName: string; input: unknown; result?: string; isError?: boolean };

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
  isError?: boolean;
  isPending: boolean;
  /** async（后台）子代理：launch-ack 到达后标记，UI 显示「后台运行中」。
   *  回放的工具链/模型由 sidecar tail 经 subagent_progress 等事件推，与 sync 同路。 */
  asyncLaunched?: { agentId: string; outputFile: string };
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

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | SubagentBlock | ActionBlock;

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

/** 当前会话的上下文窗口用量——每轮结束后由 sidecar 刷新一次。 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
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

export interface ChatMessage {
  id: string;
  role: MessageRole;
  blocks: ContentBlock[];
  timestamp: number;
  /** assistant 消息正在流式生成中（用于续写判定，替代对象身份比较） */
  streaming?: boolean;
  /** 这条 assistant 消息这一轮的 token 用量 + 费用 */
  usage?: TurnUsage;
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
  /** "总是允许"按钮该显示的文案——由 sidecar 解读 SDK 的建议后翻成人话（比如
   *  Edit 工具常见的"自动接受编辑（本次会话）"），缺省时兜底显示"总是允许"。 */
  alwaysAllowLabel?: string;
  /** 这次请求是不是某个子代理内部发起的（而不是主线程）——缺省表示来自主线程。
   *  没有它，用户会在毫无上下文的情况下突然看到权限框弹出来，不知道是谁在问。 */
  fromSubagent?: { id: string; agentName: string };
}

/**
 * DTO 子集：从 packages/aide-sdk/src/types.ts 按需过筛。
 *
 * 过筛规则：仅收录当前页面域实际消费的类型；后续页面需要新类型时同步补入
 * （保持与上游字段/注释语义零偏差，serde camelCase 镜像）。
 * 本文件已收录：Session / WorkspaceInfo（会话列表页域）；
 * HistoryBlock / ChatMessageItem / LoadMessagesResult（会话页历史域）；
 * BgTaskInfo（后台任务快照域；ohos 专有 RPC list_bg_tasks，上游 SDK 暂无对应）。
 */

export interface Session {
  id: string;
  name: string;
  /** 毫秒（Rust as_millis / startedAt u64），0 = 未知时间。 */
  timestamp: number;
}

export interface WorkspaceInfo {
  key: string;
  /** 工作区路径（解码后）。 */
  name: string;
  missing: boolean;
}

/**
 * 历史消息里的一个内容块——跟 Rust 侧 commands 的 HistoryBlock 镜像。
 * 上游是 text/thinking/tool_call 判别联合；ArkTS 无判别联合，化为单
 * interface + type 字段（消费端按 type 分发，字段按臂可选）。
 */
export interface HistoryBlock {
  type: string;
  /** text/thinking 臂。 */
  text?: string;
  /** tool_call 臂。 */
  id?: string;
  name?: string;
  input?: Object;
  result?: string | null;
  isError?: boolean | null;
}

export interface ChatMessageItem {
  role: string;
  blocks: HistoryBlock[];
  timestamp: number;
}

/**
 * load_messages 分页返回（serde camelCase 镜像）：消息页 + 下一页字节游标。
 * nextOffsetBytes = 页首真实 user 行的起始字节；0 = 已到文件头（无更早页）。
 * endOffsetBytes = 本页排他末尾字节（上游页级回收用；ohos 未过筛回收，仅透传）。
 */
export interface LoadMessagesResult {
  messages: ChatMessageItem[];
  nextOffsetBytes: number;
  endOffsetBytes: number;
}

/**
 * 会话级权限规则草稿（镜像上游 types/permissions.ts 的 PermissionRuleDraft，
 * 随 permission_response 放行透传 sidecar 入库）。ohos 端不推导规则草稿
 * （推导逻辑 deriveSessionFileRules 在桌面 src/utils，同 PWA 的协议边界），
 * 收录仅为保持 permission_response DTO 形状完整；matcher 上游是判别联合，
 * 这里按 JSON 值域收窄为 Record。
 */
export interface PermissionRuleDraft {
  /** 'allow' | 'deny' | 'ask'。 */
  effect: string;
  tool: string;
  matcher: Record<string, Object>;
}

/**
 * 后台任务快照条目（list_bg_tasks 返回；Rust runtime::bg_registry::
 * BgTaskSnapshot 的 serde camelCase 镜像）。桌面侧从事件流顺手累积，
 * 手机打开会话/重连时对账 bgTasks 用——bg_task_* 事件流只做实时转发
 * 无重放，离线期间错过的任务靠快照回填。
 */
export interface BgTaskInfo {
  id: string;
  command: string;
  description: string;
  /** 'running' | 'completed' | 'failed' | 'stopped'。 */
  status: string;
  summary: string;
  /** 桌面首见 started 的接收时刻（毫秒；0 = 未知）。 */
  startedAt: number;
  endedAt: number;
  /** 尾部输出（截头保尾，上限与 BG_OUTPUT_CAP 同值）。 */
  output: string;
  truncatedBytes: number;
}

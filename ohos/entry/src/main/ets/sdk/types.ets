/**
 * DTO 子集：从 packages/aide-sdk/src/types.ts 按需过筛。
 *
 * 过筛规则：仅收录当前页面域实际消费的类型；后续页面需要新类型时同步补入
 * （保持与上游字段/注释语义零偏差，serde camelCase 镜像）。
 * 本文件已收录：Session / WorkspaceInfo（会话列表页域）；
 * DailyWorkspace（日常默认工作区身份域；daily_workspace 返回）；
 * HistoryBlock / ChatMessageItem / LoadMessagesResult（会话页历史域）；
 * BgTaskInfo（后台任务快照域；ohos 专有 RPC list_bg_tasks，上游 SDK 暂无对应）；
 * ProviderModelMappings / ProviderConfigView（抽屉供应商域；get_providers 返回）；
 * SendImage / SendDisplayBlock（发送域：图片附件 + 用户气泡 display 回灌块）；
 * Schedule / AutomationTask / AutomationTaskInput / RunUsage / RunRecord /
 * RunStats（自动化任务域；⚠️ 此域命令未进远程 REGISTRY，见 api.ets 头注）。
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

/** get_active_workspace 返回体；null = 桌面未设置活动工作区。 */
export interface ActiveWorkspace {
  /** 编码键（与 WorkspaceInfo.key 同源，可直接对配列表）。 */
  key: string;
  /** 解码后的工作区路径（与 WorkspaceInfo.name 同构）。 */
  path: string;
}

/**
 * 日常默认工作区身份（daily_workspace 返回；对照桌面 commands::workspace::
 * DailyWorkspace 的 serde camelCase 镜像）：桌面 <配置目录>/workspace 的
 * 注册键与路径。key 与 list_workspaces 同链（normalize → path_to_key），
 * 可直接喂 list_sessions_for_workspace；path 供 spawn 的 workspaceRoot
 * 定落点。纯查询无副作用，不改变桌面活动工作区；桌面 list_workspaces
 * 服务端已剔除日常，手机端列表无需再滤。
 * 路径是内部概念，UI 永不展示（桌面 spec：
 * docs/superpowers/specs/2026-09-20-daily-mode-design.md）。
 */
export interface DailyWorkspace {
  key: string;
  path: string;
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

/**
 * 供应商模型映射（Rust ProviderModelMappings 的 serde camelCase 镜像）：
 * anthropic 模型别名 → 供应商真实模型 id。ohos 端暂不消费（模型 chip 随
 * 后续增量接入），收录仅为保持 ProviderConfigView DTO 形状完整。
 */
export interface ProviderModelMappings {
  anthropicModel: string;
  defaultOpusModel: string;
  defaultSonnetModel: string;
  defaultHaikuModel: string;
  subagent: string;
}

/**
 * 供应商配置视图（get_providers 返回；Rust ProviderConfigView 的 serde
 * camelCase 镜像）。桌面侧脱敏视图：密钥只回「是否已配置」布尔，明文
 * 不落协议（对照 ProviderConfig 原始结构，api_key/auth_token 均被替换）。
 */
export interface ProviderConfigView {
  id: string;
  /** 'system_default' | 'cpa_gpt' | 'ollama' | 'kimi' | 'deepseek' | 'zhipu' | 'qwen' | 'custom'（snake_case 枚举）。 */
  kind: string;
  name: string;
  icon: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  authTokenConfigured: boolean;
  /** 已废弃（模型默认值权威源改到 modelMappings.anthropicModel）；镜像保留。 */
  model: string;
  modelMappings: ProviderModelMappings;
  effortLevel: string;
  autoCompactWindow: string;
  autocompactPctOverride: string;
  maxContextTokens: string;
  knownModels: string[];
}

/**
 * 纯展示用的模型选项（get_default_models 返回；对照上游 ModelOption）——
 * 值和名字完全由 provider 决定，核心层不关心具体是什么模型。
 */
export interface ModelOption {
  value: string;
  displayName: string;
}

/**
 * 发送前身份漂移判定结果（`session_identity_drift`；对照 Rust IdentityDrift）。
 *
 * 基线 = 会话元数据 `<id>.json` 的 provider / model 字段，与 session_provider /
 * session_model 同一口径；基线缺失（会话从未发过 / 字段为空）→ 该维度 false。
 *
 * 只报「哪一维漂了」，**弹不弹、文案怎么写归 UI**——判定规则在 Rust 侧只有一份，
 * 桌面端与手机端共用，避免同一规则在两端各存一份后各自漂移。
 */
export interface IdentityDrift {
  /** 供应商维度漂移（基线存在且与本次不同）。 */
  providerDrift: boolean;
  /** 模型维度漂移（同上）。 */
  modelDrift: boolean;
  /** 会话记住的供应商 id；null = 没记过。 */
  lastProvider: string | null;
  /** 会话记住的模型；null = 没记过。 */
  lastModel: string | null;
}

/**
 * 发送图片附件（镜像 agent-sidecar types.ts 的 ImageAttachment；Rust
 * SendMessageArgs.images 数组项的 serde camelCase 形状）。data 为不带
 * data: 前缀的裸 base64（协议约定，渲染前缀由各端渲染层自拼）；
 * mediaType 限 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'。
 */
export interface SendImage {
  data: string;
  mediaType: string;
}

/**
 * send_message 的 display 回灌块：用户消息的富形态（图片/文本/文件引用），
 * 桌面/PWA 端按块渲染用户气泡（blocksFromDisplay 逐块映射，未知 type 安全
 * 跳过——ohos 专有 video 臂即借此降级）。镜像上游 UserMessageBlock 判别
 * 联合 + ohos 扩展臂；ArkTS 无判别联合化为单 interface 按 type 分发，
 * 字段全可选（各臂只填自己的字段，undefined 经 JSON.stringify 丢弃）。
 * 块顺序约定 = PWA buildUserDisplay：媒体（image/video）→ text → mention。
 */
export interface SendDisplayBlock {
  type: string;
  /** text 臂。 */
  text?: string;
  /** image 臂：裸 base64 + 媒体类型。 */
  data?: string;
  mediaType?: string;
  /** mention 臂（桌面渲染为 Read 卡）。 */
  path?: string;
  content?: string;
  /** video 臂（ohos 专有：首帧海报 + 元数据；桌面跳过）。 */
  poster?: string;
  durationMs?: number;
  name?: string;
}

// ── 自动化任务域（镜像 packages/aide-sdk/src/api/automation.ts；serde camelCase）──

/**
 * 调度定义（Rust Schedule 镜像，serde tag="kind" 判别联合）。
 * ArkTS 无判别联合 → 单 interface + kind 字符串 + 全可选臂字段（各臂只填
 * 自己的字段，undefined 经 JSON.stringify 丢弃，与 PWA 同形）。
 * time 一律 "HH:MM" 本地墙钟；once 的 at 是本地 ISO（分或秒可选）。
 */
export interface Schedule {
  /** 'daily' | 'weekly' | 'monthly' | 'interval' | 'once'。 */
  kind: string;
  /** daily/weekly/monthly 臂："HH:MM"。 */
  time?: string;
  /** weekly 臂：1=周一..7=周日（ISO）。 */
  weekdays?: number[];
  /** monthly 臂：1..=31（超过当月天数由服务端钳到月末）。 */
  day?: number;
  /** interval 臂：>0。 */
  every?: number;
  /** interval 臂：'minutes' | 'hours' | 'days'。 */
  unit?: string;
  /** once 臂：本地 ISO；触发后服务端自动 enabled=false。 */
  at?: string;
}

/**
 * 自动化任务（Rust AutomationTask 镜像）。id / createdAt / lastRun 系 /
 * playbookState 由服务端管理；sessionDir 上游 TS 未过筛（不暴露），同。
 */
export interface AutomationTask {
  id: string;
  name: string;
  prompt: string;
  /** 会话归属工作区根路径；null = 以任务目录（~/.aide/automations/<id>/）为工作目录。 */
  workspacePath: string | null;
  /** 显式按任务指定，不继承主会话；空串 = 跟随桌面默认（不下发 ANTHROPIC_MODEL）。 */
  model: string;
  /** low|medium|high|xhigh|max（服务端透传 env，不做枚举约束）。 */
  effort: string;
  /** 'auto' | 'full'（v1 两档定案；readonly 是旧档 serde 别名，归并进 auto）。 */
  permissionPreset: string;
  /** 预授权 MCP server key 白名单（如 "aide-codegraph"）。 */
  connectors: string[];
  schedule: Schedule;
  /** 生效区间（"YYYY-MM-DD"）；null = 不限。 */
  validFrom: string | null;
  validTo: string | null;
  /** 'catchup' | 'skip' | 'ask'（错过补跑策略）。 */
  missedPolicy: string;
  playbookEnabled: boolean;
  /** 'none' | 'ready' | 'stale'（服务端管理，前端只读）。 */
  playbookState: string;
  notifySuccess: boolean;
  notifyFailure: boolean;
  enabled: boolean;
  /** 本地 ISO；也是 interval 调度的固定网格锚点（不随 lastRunAt 漂移）。 */
  createdAt: string;
  lastRunAt: string | null;
  /** 'running' | 'succeeded' | 'failed' | 'skipped'；null = 从未运行。 */
  lastRunStatus: string | null;
}

/** create/update 入参：无 id / createdAt / lastRun 系 / playbookState（服务端管理）。 */
export interface AutomationTaskInput {
  name: string;
  prompt: string;
  workspacePath: string | null;
  model: string;
  effort: string;
  permissionPreset: string;
  connectors: string[];
  schedule: Schedule;
  validFrom: string | null;
  validTo: string | null;
  missedPolicy: string;
  playbookEnabled: boolean;
  notifySuccess: boolean;
  notifyFailure: boolean;
  enabled: boolean;
}

/** 单次运行的 token 用量（Rust RunUsage 镜像）。 */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * 运行记录（runs.jsonl 行；Rust RunRecord 镜像）。
 * summary = 转录尾行 ≤80 字；note = 'overlap' / 'missed-skip' / 'missed-ask'
 * 有固定摘要文案；skipped 记录 sessionId 为空串（转录行置灰不可点）。
 */
export interface RunRecord {
  runId: string;
  sessionId: string;
  /** 'schedule' | 'manual' | 'catchup'。 */
  trigger: string;
  /** 'explore' | 'playbook'。 */
  mode: string;
  /** 本地 ISO。 */
  startedAt: string;
  finishedAt: string | null;
  /** 'running' | 'succeeded' | 'failed' | 'skipped'。 */
  status: string;
  stopReason: string | null;
  usage: RunUsage | null;
  rounds: number | null;
  costUsd: number | null;
  /** 结论摘要（转录尾行，≤80 字）；skipped/运行中为 null。 */
  summary: string | null;
  distillCostUsd: number | null;
  error: string | null;
  note: string | null;
}

/** 近 30 天统计（automation_run_stats 返回；Rust RunStats 镜像）。 */
export interface RunStats {
  runs: number;
  succeeded: number;
  failed: number;
  /** 0..1。 */
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number | null;
  /** 0..1；null = 无用量样本。 */
  cacheReadRatio: number | null;
}

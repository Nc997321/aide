export interface Session {
  id: string;
  name: string;
  timestamp: number;
  last_message: string;
}

export interface WorkspaceInfo {
  key: string;
  name: string;
  missing: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

/** 历史消息里的一个内容块——跟 Rust 侧 `commands/mod.rs` 的 `HistoryBlock` 镜像。
 *  只有 text/tool_call 两种；子代理调用和图片维持降级行为，不出现在历史里。 */
export type HistoryBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; result: string | null; isError: boolean | null };

export interface ChatMessageItem {
  role: string;
  blocks: HistoryBlock[];
  timestamp: number;
}

export interface ProjectInfo {
  root: string;
  name: string;
  branch: string;
}

export interface DiffEntry {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** git_diff_pair 返回的新旧双份原文（serde camelCase 镜像） */
export interface DiffPair {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  status: "added" | "modified" | "deleted";
  isBinary: boolean;
  eolOnly: boolean;
}

export interface LastEventInfo {
  event_type: string | null;
  stop_reason: string | null;
  timestamp: string | null;
}

export interface ChangeRound {
  index: number;
  time: string;
  files: ChangeFile[];
  rewindTo?: number;
  /** 本轮对应的用户提问，作为变更面板轮次标题 */
  prompt?: string;
}

export interface Keybindings {
  searchOpen: string;
  /** 聊天区：当前 tab 向右拆分 */
  paneSplitRight: string;
  /** 聊天区：当前 tab 向下拆分 */
  paneSplitDown: string;
  /** 聊天区：关闭当前 tab */
  paneCloseTab: string;
}

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  notificationsEnabled: boolean;
  proxy: string;
  shellPath: string;
  workbenchHeight: number;
  keybindings: Keybindings;
  theme: string;
  openWithExtensions: string[];
  recentLimit: number;
  /** 聊天区分屏布局快照，按工作区路径键控（结构见 paneLayout/tree.ts 的 LayoutSnapshot） */
  paneLayouts: Record<string, unknown>;
  /** CodeGraph embedding 后端配置（fastembed 本地 / http 远程）。默认 fastembed。 */
  codegraphEmbedder: CodeGraphEmbedderConfig;
  /** JDK 注册表：本机已登记的 JDK（扫描 + 手动添加），供运行配置按项目选 JDK。
   *  机器级资源，非按工作区。 */
  jdkRegistry?: JdkEntry[];
  /** 「检测到 Java 项目但运行配置未选 JDK」提示的「稍后」关闭记录——按工作区路径键控。
   *  落盘到 config.json（非 localStorage），重启不丢、WebView2 清缓存也不丢。
   *  仅对「点了稍后却一直不配 JDK」的用户抑制重复弹窗；一旦该工作区任一 Java
   *  运行配置选了 JDK，needsJdk 即为 false，本列表对该键再无意义。 */
  jdkPromptDismissed?: string[];
}

/** CodeGraph embedding 后端配置。`backend` 选 fastembed（本地 ONNX）或 http
 *  （Ollama 本地/远程、OpenAI 兼容云端）。http 分支按 `format` 组请求/解响应。
 *  切后端或模型会触发全量重建索引（向量维度/模型空间不兼容）。 */
export interface CodeGraphEmbedderConfig {
  backend: "fastembed" | "http";
  /** backend === "http" 时以下字段生效： */
  baseUrl: string;
  /** OpenAI/Jina 必填；Ollama 原生可空 */
  apiKey: string;
  model: string;
  format: "ollama" | "openai";
  /** 模型向量维度，0 = 自动从首次响应探测 */
  dim: number;
}

export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// ── Provider types ──

/** Claude 专属的模型 env 变量映射——5 个变量统一在此，换 provider 时整块重写。
 *  与会话面板模型下拉（真实模型 id + 运行时 set_model 切换）互补：本块是 spawn 时
 *  env 变量层的默认值 + 别名→具体模型映射。Rust 端 provider.rs 注入逻辑单一入口。 */
export interface ProviderModelMappings {
  /** 默认模型 → ANTHROPIC_MODEL（原 provider.model，已迁入此处） */
  anthropicModel: string;
  /** opus 别名→具体模型 → ANTHROPIC_DEFAULT_OPUS_MODEL */
  defaultOpusModel: string;
  /** sonnet 别名→具体模型 → ANTHROPIC_DEFAULT_SONNET_MODEL */
  defaultSonnetModel: string;
  /** haiku 别名→具体模型 → ANTHROPIC_DEFAULT_HAIKU_MODEL */
  defaultHaikuModel: string;
  /** 子代理默认模型 → CLAUDE_CODE_SUBAGENT_MODEL。注意：该 env 在 CLI 里是硬覆盖，
   *  sidecar 不透传给 CLI，而是折算成别名经 PreToolUse hook 在「主代理未指定 model」
   *  时注入——这里是"未指定时的兜底"，不是"钉死所有子代理"。 */
  subagent: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  icon: string;
  baseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
  modelMappings: ProviderModelMappings;
  effortLevel: string;
  /** → CLAUDE_CODE_AUTO_COMPACT_WINDOW：auto-compact 计算用上下文容量（token 数）。空 = CLI 默认 */
  autoCompactWindow: string;
  /** → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE：1–100，作用在 window 之上微调触发时机。空 = CLI 默认 */
  autocompactPctOverride: string;
  knownModels: string[];
}

// ── Git types ──

export interface CommitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitDetail {
  hash: string;
  message: string;
  author: string;
  date: string;
  body: string;
  files: DiffEntry[];
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

export interface GitStatusEntry {
  path: string;
  xy: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  entries: GitStatusEntry[];
}

// ── Grep types ──

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  match_type: string;
}

// ── Run Config types ──

export interface RunConfig {
  id: string;
  name: string;
  cwd: string;
  command: string;
  /** 启动该配置时注入子进程的环境变量（覆盖系统继承值）。目前用于按项目选
   *  JDK：存 `JAVA_HOME`，Rust spawn 时再据此前置 `bin` 到 `PATH`。可选——
   *  旧配置无此字段，缺省即不注入（走系统全局环境，旧行为不变）。 */
  env?: Record<string, string>;
}

export interface RunTarget {
  name: string;
  cwd: string;
  command: string;
}

/** 一个已登记的 JDK（机器级，存于 AppSettings.jdkRegistry）。`version` 为主版本
 *  号字符串（"21"/"8"），从 JDK home 的 `release` 文件解析。 */
export interface JdkEntry {
  name: string;
  version: string;
  path: string;
}

// ── Recent access types ──
// 字段名与 Rust 序列化保持一致（snake_case）。

export interface RecentSession {
  ws_key: string;
  ws_name: string;
  session_id: string;
  name: string;
  ts: number;
}

export interface RecentFile {
  path: string;
  name: string;
  ts: number;
}

export interface RecentView {
  sessions: RecentSession[];
  files: RecentFile[];
}

// ── Skill types ──
export type { SkillMeta } from "./types/skill";

// ── CodeGraph types ──

export type SymbolKind =
  | "Function" | "Method" | "Class" | "Field"
  | "Interface" | "Enum" | "Variable";

export type Confidence = "Structure" | "Semantic";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  parent: string | null;
}

export interface QueryResult {
  symbol: SymbolDef;
  confidence: Confidence;
  score: number | null;
}

export interface BuildIndexResult {
  /** true = reused a fresh on-disk index; false = full rebuild. */
  loaded: boolean;
  total_symbols: number;
  /** Present only on a full rebuild (loaded === false). */
  scanned_files?: number;
  files_with_symbols?: number;
  has_embeddings?: boolean;
  /** Exact reason embed didn't complete (full rebuild only): "ok" | "no_embedder: ..."
   *  | "probe_failed: ..." | "probe_empty" | "dim_unresolved (dim=0)" | "cancelled at N/M"
   *  | "batch_errors: N ..." | "incomplete: ...". Surfaced so the frontend can show
   *  why semantic search is unavailable without relying on tracing logs. */
  embed_status?: string;
}

/** 粗粒度构建进度，前端 poll 拉取（不走 app.emit，避历史跨线程 emit 卡死）。 */
export interface BuildProgress {
  /** 是否正在构建。false = 空闲/已完成，前端据此停 poll。 */
  active: boolean;
  /** 已 embed 的符号数。 */
  done: number;
  /** 总符号数。 */
  total: number;
  /** 当前阶段/文件的可读描述（"扫描文件树..." / "解析 src/foo.ts (123/456)"
   *  / "嵌入符号 1340/2000" / "写盘..."），用于构建可观测性。 */
  current: string;
  /** 结构层（精确跳转）是否已就绪。Phase1 swap 后 true，即使语义层 embed 还在
   *  后台跑——用户此时已能用精确跳转，不必干等。前端据此显示"已就绪"标记。 */
  index_ready: boolean;
}

/** 增量重扫结果（`codegraph_rescan`）。只 reindex mtime > indexed_at 的文件。 */
export interface RescanResult {
  /** true = 当前有匹配 root 的活跃索引。false = 无索引/根不匹配，本次 no-op。 */
  active_index: boolean;
  /** 语义层是否就绪（embed_ready）。false 时 rescan 跳过（后台 embed 没跑完）。 */
  embed_ready?: boolean;
  /** walk 找到的改动文件数（mtime > indexed_at）。 */
  changed_files: number;
  /** 实际成功 reindex 的文件数。 */
  rescanned_files: number;
  /** reindex 失败的文件数（逐文件 warn）。 */
  errors: number;
}

// ── 通知中心 ──

export type NotificationSeverity = "error" | "warning" | "info";

export interface NotificationAction {
  label: string;
  url?: string;
}

/** 前端运行时通知（含 read 状态）。 */
export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  source: string;
  title: string;
  body?: string;
  timestamp: number;
  dedupKey?: string;
  count?: number;
  action?: NotificationAction;
  read: boolean;
}

/** 落盘记录（无 read，info 不落盘）。镜像 Rust NotificationRecord。 */
export interface NotificationRecord {
  id: string;
  severity: "error" | "warning";
  source: string;
  title: string;
  body?: string;
  timestamp: number;
  dedupKey?: string;
  count?: number;
  action?: NotificationAction;
}

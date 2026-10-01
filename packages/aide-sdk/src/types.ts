export interface Session {
  id: string;
  name: string;
  timestamp: number;
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

/** clipboard_read_files 返回（Rust `commands::clipboard::ClipboardFilesRead` 镜像）：
 *  系统剪贴板里的文件路径列表 + 操作语义（copy/cut，来自 Windows Preferred
 *  DropEffect / Linux gnome-copied-files 头 / macOS 恒 copy）。paths 为空 =
 *  剪贴板没有文件。 */
export interface ClipboardFilesRead {
  paths: string[];
  op: "copy" | "cut";
}

/** 历史消息里的一个内容块——跟 Rust 侧 `commands/mod.rs` 的 `HistoryBlock` 镜像。
 *  text/thinking/tool_call 三种；子代理调用和图片维持降级行为，不出现在历史里。 */
export type HistoryBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; result: string | null; isError: boolean | null };

export interface ChatMessageItem {
  role: string;
  blocks: HistoryBlock[];
  timestamp: number;
}

/** load_messages 分页返回(serde camelCase 镜像):消息页 + 下一页字节游标。
 *  nextOffsetBytes = 页首真实 user 行的起始字节;0 = 已到文件头(无更早页)。
 *  endOffsetBytes = 本页排他末尾字节——页级回收(recycle)按 (endOffset, end-start) 重取同一页。 */
export interface LoadMessagesResult {
  messages: ChatMessageItem[];
  nextOffsetBytes: number;
  endOffsetBytes: number;
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
  tooBig: boolean;
  /** 机制标记：请求的基线提交已不在仓库中（rebase / GC），本次给的是 HEAD 视图。
   *  与 eolOnly / tooBig / isBinary 同形——由 Rust 侧置位，消费端据此如实标注降级。 */
  baseMissing?: boolean;
}

/** `gitDiffPair` 的取数模式（与 Rust `DiffMode` 的 serde tag 对齐：kind 判别）。 */
export type DiffMode =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "commit"; hash: string }
  | { kind: "since"; rev: string };

export interface LastEventInfo {
  event_type: string | null;
  stop_reason: string | null;
  timestamp: string | null;
}

export interface ChangeRound {
  index: number;
  time: string;
  files: ChangeFile[];
  /** 本轮回退锚点（.jsonl 字节位置）。**磁盘上是 `null` 而不是 `undefined`**——
   *  Rust `Option<u64>` 的 `None` 经 IPC 序列化成 null；老数据全是这个形状。
   *  判断"有没有锚点"必须用数值判定（`typeof === "number"`），`!== undefined` 会把 null 放进来。 */
  rewindTo?: number | null;
  /** 本轮对应的用户提问，作为变更面板轮次标题 */
  prompt?: string;
  /** 运行时态：轮次进行中（files 随轮实时刷新）。仅内存/UI 使用，
   *  固化落盘前必清——save 层已过滤，wire 上不出现该字段；Rust 端
   *  ChangeRoundData 亦无 deny_unknown_fields，即使出现也被忽略。 */
  pending?: boolean;
  /** 运行时态：本轮触碰明细（多出 `segments` 片段），仅内存，落盘前剥离。
   *  与 `files` 同源——`files` 是它的落盘投影（`toChangeFiles`）。
   *  历史轮（从磁盘加载）只有 `files`、没有它 → 点开走累计视图。 */
  touches?: TouchedFile[];
  /** 「改前」引用：该轮开轮时刻的 HEAD 提交（开轮时取；旧数据没有）。
   *  消费端按口径取用：轮视图取本轮、全部文件树取**首轮**的（会话起点）。
   *  线上名即本名 `baseRev`（Rust `ChangeRoundData` 用 `rename_all = "camelCase"` 对齐，见其注释）。 */
  baseRev?: string;
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

/** 侧栏会话列表样式："card" = 渐变卡片（raised 底 + 描边 + 选中 135° accent 渐变）；
 *  "row" = 行式（surface 淡底 + accent 竖条选中）。纯 UI 皮肤切换，逻辑共享。 */
export type SessionListStyle = "card" | "row";

/** 内置输出样式（Claude Code 的 output style）：改的是系统提示里的角色/语气/
 *  输出格式，不是模型知道什么。`"default"` = 不改变默认行为。
 *  自定义样式走插件通道（plugin 的 output-styles 目录），不在本值域内。
 *  ⚠️ 值域与 sidecar 的白名单两处定义（agent-sidecar/src/engine/session-worker/
 *  outputStyle.ts 的 OUTPUT_STYLES，那边**不含 "default"**——它与「不下发」等价），
 *  改动要一起改——漂移会让样式静默失效（同 UserMessageBlock 先例）。 */
export type OutputStyle = "default" | "Proactive" | "Concise" | "Explanatory" | "Learning";

export interface AppSettings {
  fontSize: number;
  /** 界面字体（font-family 栈）：控制界面正文（按钮/标签/面板）与聊天区。 */
  fontFamily: string;
  /** 文件编辑器字体（font-family 栈）。空 = 未设置，回退 fontFamily。 */
  editorFontFamily: string;
  /** 工作台终端字体（font-family 栈）。空 = 未设置，回退 fontFamily。 */
  terminalFontFamily: string;
  notificationsEnabled: boolean;
  /** 首次安装引导是否已完成。首次启动若为 false 则弹全屏向导；完成或"跳过引导"后置 true，不再二次弹。 */
  onboarded: boolean;
  /** （原「启用思考」开关已删除，2026-09-19：思考由**档位**唯一决定——快速档关、
   *  进阶/极致开。两个事实源会打架：切了快速却又开着思考。旧配置里残留的
   *  `thinkingEnabled` 键会被后端忽略，下次写盘自然消失。） */
  /** 输出样式（内置四款 + "default"）。生效时机与 thinking 同款：值随每条 send
   *  下发，但 sidecar 只在新建会话（建 query）时落地——改动对已在跑的会话无效。 */
  outputStyle: OutputStyle;
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
  /** 左侧会话栏「钉子」固定状态：false（默认）= QQ 式自动隐藏（贴左边缘悬浮
   *  滑出、覆盖内容），true = 常驻 dock 推开内容。 */
  leftSidebarPinned?: boolean;
  /** 侧栏会话列表样式（卡片/行式），默认 "card"。纯 UI 皮肤，设置「主题样式」tab 切换。 */
  sessionListStyle?: SessionListStyle;
  /** 全局 LSP 设置：按语言 id 覆盖 server 二进制路径（对应后端 LspSettings）。 */
  lsp?: { servers: Record<string, LspServerOverride> };
  /** 代码编辑器设置（缩进等）。后续编辑器相关设置归入此类。固定 Tab 字符缩进。 */
  editor: EditorSettings;
  /** 手机网关（Aide Link）设置：远程会话默认权限模式（中继地址是产品内置的，不在设置里）。 */
  remote: RemoteSettings;
}

/** 手机网关设置。permissionMode 决定远程会话的工具批准策略（auto / manual）。启停与配对状态不在设置里
 *  （见 linkApi）；中继地址是产品内置的固定值，不可配置。 */
export interface RemoteSettings {
  permissionMode: string;
}

/** 代码编辑器设置。缩进字符固定为 Tab，缩进格数控制 Tab 显示列宽。 */
/** Vim 键位映射单条（VSCodeVim 风格）：keys = vim 键串（"jj"、"<C-s>"）；
 *  to 以 ":" 开头 = 内置 ex 命令（:w/:wq/:q/:q!），否则为 vim 键序列。 */
export interface VimBinding {
  keys: string;
  to: string;
}

/** Vim 键位映射表：normal / insert / visual 三模式各自一组 */
export interface VimBindings {
  normal: VimBinding[];
  insert: VimBinding[];
  visual: VimBinding[];
}

export interface EditorSettings {
  /** Tab 字符的显示列宽（回车自动缩进与 Tab 键每层插入一个 \t），默认 4。 */
  indentSize: number;
  /** Vim 键位模式（@replit/codemirror-vim），默认关。 */
  vimMode: boolean;
  /** Vim 键位映射（VSCodeVim 风格），默认空表 */
  vimKeybindings: VimBindings;
}

/** 某语言 LSP server 的显式覆盖（"用这个二进制 + 这些参数"，对应后端 ServerOverride）。 */
export interface LspServerOverride {
  program: string;
  args: string[];
}

/** CodeGraph embedding 后端配置。`backend` 选 fastembed（本地 ONNX）或 http
 *  （Ollama 本地/远程、OpenAI 兼容云端）。http 分支按 `format` 组请求/解响应。
 *  切后端或模型会触发全量重建索引（向量维度/模型空间不兼容）。 */
export interface CodeGraphEmbedderConfig {
  backend: "fastembed" | "http";
  /** backend === "http" 时以下字段生效： */
  baseUrl: string;
  /** Whether a CodeGraph credential exists in the private keychain. */
  apiKeyConfigured: boolean;
  model: string;
  format: "ollama" | "openai";
  /** 模型向量维度，0 = 自动从首次响应探测 */
  dim: number;
  /** 语义搜索分数阈值；undefined = 后端按模型自动（fastembed≈0.35，http≈0.55）。范围 0~1，改后立即生效、无需重建。 */
  scoreThreshold?: number;
}

export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 一次工具调用造成的改动片段（片段级 diff：不是全文件）。 */
export interface ChangeSegment {
  oldText: string;
  newText: string;
  addCount: number;
  delCount: number;
}

/**
 * 变更归集的条目：比 `ChangeFile` 多一份**本轮片段**（纯内存，不落盘）。
 *
 * `path` 是相对工作区根的路径——撤回（`git checkout -- <rel>`）、展示、git 校验
 * 都要它。绝对路径不另存：所属工作区是**会话级**事实（`ChangeRound` 的消费者从
 * 会话归属拿根），两者组合是确定的，各存一份就互为派生、可能因切工作区不一致。
 */
export interface TouchedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** 本轮内该文件的片段序列，按发生顺序。空数组 = 无片段 → 走累计视图。 */
  segments: ChangeSegment[];
}

// ── Provider types ──

/** 与 Rust `ProviderKind` enum 对齐（serde rename_all = "snake_case"）。Custom 是兜底。 */
export type ProviderKind =
  | "system_default"
  | "cpa_gpt"
  | "ollama"
  | "kimi"
  | "deepseek"
  | "zhipu"
  | "qwen"
  | "custom";

/** 与 Rust `AuthMode` enum 对齐（serde rename_all = "snake_case"）。 */
export type AuthMode = "api_key" | "auth_token";

/**
 * 与 Rust `CatalogPreset` 对齐。⚠️ Rust 此 struct 无 rename_all → 字段 snake_case
 *（与 ProviderConfig 的 camelCase 不同形）。`base_url`/`auth_mode` 保持 snake。
 */
/** 预置供应商的表单默认值（与 Rust `CatalogDefaults` 对齐，snake_case）。
 *  仅前端建草稿时预填用——保存后落进 ProviderConfig.modelMappings / maxContextTokens。 */
export interface CatalogDefaults {
  anthropic_model: string;
  default_opus_model: string;
  default_sonnet_model: string;
  default_haiku_model: string;
  subagent: string;
  max_context_tokens: string;
  effort_level: string;
  auto_compact_window: string;
}

export interface CatalogPreset {
  kind: ProviderKind;
  name: string;
  icon: string;
  base_url: string;
  auth_mode: AuthMode;
  actions: string[];
  /** 预填表单的默认模型值；无默认值的预置不携带（Rust Option → JSON 缺省） */
  defaults?: CatalogDefaults;
}

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

/** Explicit private-credential mutation sent only with a save request. */
export type SecretMutation =
  | { action: "unchanged" }
  | { action: "set"; value: string }
  | { action: "clear" };

/** Public provider DTO. Credentials are intentionally represented only as state. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  icon: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  authTokenConfigured: boolean;
  model: string;
  modelMappings: ProviderModelMappings;
  effortLevel: string;
  /** → CLAUDE_CODE_AUTO_COMPACT_WINDOW：auto-compact 计算用上下文容量（token 数）。空 = CLI 默认 */
  autoCompactWindow: string;
  /** → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE：1–100，作用在 window 之上微调触发时机。空 = CLI 默认 */
  autocompactPctOverride: string;
  /** → CLAUDE_CODE_MAX_CONTEXT_TOKENS：模型上下文窗口本身（token 数）。直接设可突破 CLI 对未知/非 Anthropic 模型的 200K 默认上限（autoCompactWindow 阈值被此窗口夹住）。空 = CLI 默认（未知模型 200K） */
  maxContextTokens: string;
  knownModels: string[];
}

/** Provider write DTO. It never contains a rehydrated credential. */
export interface ProviderConfigInput extends Omit<ProviderConfig, "apiKeyConfigured" | "authTokenConfigured"> {
  apiKey: SecretMutation;
  authToken: SecretMutation;
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
  /** true = 远程跟踪分支（origin/xxx），false/缺省 = 本地分支 */
  is_remote?: boolean;
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

export interface StashEntry {
  index: number;
  name: string;
  message: string;
  date: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

/** git pull/fetch 成功后带回的结果摘要；与后端 FetchPullOutcome 对齐（camelCase）。 */
export interface FetchPullOutcome {
  alreadyUpToDate: boolean;
  summary: string;
}

/** 对比视图中的一个文件差异项（与后端 CompareFile 对齐，camelCase）。 */
export interface CompareFile {
  path: string;
  /** 重命名源路径；仅 status === "R" 时有值 */
  oldPath?: string;
  /** A/M/D/R/C/T 单字母 */
  status: string;
  additions: number;
  deletions: number;
}

/** 分支对比结果（与后端 CompareResult 对齐，camelCase）。 */
export interface CompareResult {
  /** 基准分支名（默认当前分支） */
  base: string;
  /** 被对比分支名 */
  head: string;
  /** base 领先 head 的提交数（base 独有） */
  ahead: number;
  /** head 领先 base 的提交数（head 独有） */
  behind: number;
  aheadCommits: CommitEntry[];
  behindCommits: CommitEntry[];
  files: CompareFile[];
  filesTotal: number;
}

/** 标签项（与后端 TagEntry 对齐，camelCase）。 */
export interface TagEntry {
  name: string;
  /** 相对创建日期（如 "2 days ago"） */
  date: string;
  /** 指向的提交短 hash（前 7 位） */
  target: string;
  /** annotated = true，lightweight = false */
  isAnnotated: boolean;
  /** annotated 标签的注讯首行；lightweight 为空 */
  message: string;
}

// ── Grep types ──

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  match_type: string;
}

// ── Global search & replace types（Find in Files）──

export interface SearchOptions {
  useRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  fileMask: string | null;
  limit: number | null;
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileGroup {
  file: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  files: SearchFileGroup[];
  total: number;
  truncated: boolean;
}

export interface ReplacePreviewFile {
  file: string;
  original: string;
  replaced: string;
  matchCount: number;
}

export interface ReplacePreviewResponse {
  files: ReplacePreviewFile[];
  totalMatches: number;
  truncated: boolean;
}

export interface ReplaceFileInput {
  path: string;
  content: string;
}

export interface ApplyResult {
  succeeded: string[];
  failed: [string, string][];
}

// ── Run Config types ──

export interface RunConfig {
  id: string;
  name: string;
  cwd: string;
  command: string;
  /** 启动该配置时注入子进程的环境变量（覆盖系统继承值）。JDK 已从 per-config
   *  （env.JAVA_HOME）升级为工作区级（state.json workspace_jdks，启动时由
   *  useRunProcess 合入），list_run_configs 读出时自动迁移剥除。可选——
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
  /** 结果来源（前端 orchestration 层打标，Rust 不发）：lsp=语言服务、ast=codegraph 结构层、
   *  semantic=codegraph 语义层、grep=文本回退。缺省=旧路径未打标，浮层按 confidence 兜底显示。 */
  source?: "lsp" | "ast" | "semantic" | "grep";
}

/** lsp_definition 请求结局：区分「server 慢/未就绪/挂了」与「server 确认无结果」。
 *  - ok：server 正常响应（results 可空=确认无定义，由前端决定是否 fallback）
 *  - timeout：预算内无响应（前端可重试一次，仍 timeout 则降级提示，不自动 fallback）
 *  - not_ready：语言服务未就绪（前端 auto-fallback codegraph→grep + 标签 + hint）
 *  - gone：语言服务已退出（前端 auto-fallback codegraph→grep，useLsp 已 toast） */
export type JumpStatus = "ok" | "timeout" | "not_ready" | "gone";

export interface LspJumpResult {
  status: JumpStatus;
  results: QueryResult[];
}

/** documentSymbol 扁平条目（Rust 侧 parse_document_symbols 归一）。kind 保留 LSP SymbolKind
 *  原值（前端再筛 Class/Interface/Method/Function）。行列 1-based。 */
export interface DocumentSymbolItem {
  name: string;
  kind: number;
  line: number;
  column: number;
}

/** 某语言 server 的可选能力开关（来自 initialize 握手 capabilities）。前端据此决定是否
 *  启用「跳转到实现」「调用层级 ⇄」gutter 标记、inlay hints 装饰等可选能力。 */
export interface LspCapabilities {
  implementationProvider: boolean;
  documentSymbolProvider: boolean;
  callHierarchyProvider: boolean;
  inlayHintProvider: boolean;
}

// ── 调用层级（lsp_call_hierarchy）──

/** 调用点（fromRanges）：节点与父节点之间发生调用的位置，逐个可跳。行列 1-based。 */
export interface CallHierarchySite {
  line: number;
  column: number;
}

/** 调用层级树节点。file 为相对 workspaceRoot 的路径（跨工作区为绝对，同 QueryResult 约定）；
 *  kind 为 LSP SymbolKind 原值。callSites = 该节点与父节点间的调用点。 */
export interface CallHierarchyNode {
  name: string;
  kind: number;
  detail?: string;
  file: string;
  line: number;
  column: number;
  callSites: CallHierarchySite[];
}

/** lsp_call_hierarchy 结果：root = prepare 到的层级根（null = 该位置不是可调用符号，
 *  如类名/字段——前端提示走引用查询）；nodes = 根的第一层调用方/被调用方。展开下一层
 *  由前端递归调用（查询点 = 子节点声明位置）。 */
export interface CallHierarchyResult {
  status: JumpStatus;
  root: CallHierarchyNode | null;
  nodes: CallHierarchyNode[];
}

/** 调用层级方向：incoming = 谁调用了它（调用方）；outgoing = 它调用了谁（被调用方）。 */
export type CallHierarchyDirection = "incoming" | "outgoing";

// ── inlay hints（lsp_inlay_hints）──

/** inlay hint 视图条目（Rust 侧 inlay_hints_to_view 归一）。kind 分流样式：
 *  "type" = 类型提示（缀于表达式后）、"param" = 参数名提示（缀于实参前）。
 *  label 已是 parts 扁平拼接文本；行列 1-based（position 处）；padding 控制渲染间距。 */
export interface InlayHintItem {
  kind: "type" | "param";
  line: number;
  column: number;
  label: string;
  paddingLeft: boolean;
  paddingRight: boolean;
}

export interface BuildIndexResult {
  /** true = reused a fresh on-disk index; false = full rebuild. */
  loaded: boolean;
  total_symbols: number;
  /** Rust 命令级门控早退原因（"untrusted" / "disabled"）。前端静默处理，
   *  不推通知。 */
  skipped?: string;
  /** true = resumed an interrupted embed from the per-file checkpoint instead
   *  of full-rebuilding (previous build died mid-embed). */
  resumed?: boolean;
  /** Resume only: files already embedded (skipped via checkpoint). */
  skipped_embedded_files?: number;
  /** Present only on a full rebuild (loaded === false). */
  scanned_files?: number;
  files_with_symbols?: number;
  has_embeddings?: boolean;
  /** Exact reason embed didn't complete (full rebuild only): "ok" | "no_embedder: ..."
   *  | "probe_failed: ..." | "probe_empty" | "dim_unresolved (dim=0)" | "cancelled at N/M"
   *  | "batch_errors: N ..." | "incomplete: ...". Surfaced so the frontend can show
   *  why semantic search is unavailable without relying on tracing logs. */
  embed_status?: string;
  /** NaN-skipped symbol count this build (permanent skips — bge-m3 overflow
   *  snippets the `code:` prefix + bisection couldn't save). Counts as "processed". */
  skipped_count?: number;
  /** Failed embed batches this build (transient — Ollama down / timeout). >0 ⇒ the
   *  build is `incomplete`, not `degraded`. */
  failed_count?: number;
  /** Actual vector count in the shard on completion. A complete shard should have
   *  ~total_symbols minus NaN-skips; far below ⇒ broken (loaders reject it). */
  shard_point_count?: number;
  /** Same as has_embeddings for a fresh/resume build; `true` for incremental
   *  (reused a load_compatible_index shard that already passed point_count check). */
  embed_complete?: boolean;
  /** Incremental reindex only: true when only a small set of changed files was
   *  re-parsed + re-embedded instead of a full rebuild. */
  incremental?: boolean;
  /** Incremental only: number of changed files reindexed. */
  rescanned_files?: number;
  /** Coarse health for the UI: "complete" | "degraded" (NaN skips) | "incomplete"
   *  (cancelled/failed/stopped early) | "structure_only" (no embedder). */
  health?: "complete" | "incomplete" | "degraded" | "structure_only";
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

/** 落盘记录（info 不落盘；read 随条目持久化——看过重启不再回未读）。镜像 Rust NotificationRecord。 */
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
  read?: boolean;
}

// ── 一次性迁移：从用户系统 ~/.claude/ 拷到 Aide 自管理目录 ──

/** Rust `commands::migration::MigrationStatus`。 */
export interface MigrationStatus {
  legacyExists: boolean;
  hasMigratable: boolean;
  done: boolean;
  dismissed: boolean;
}

/** Rust `commands::migration::MigrationSummary`。 */
export interface MigrationSummary {
  copiedCount: number;
  skippedCount: number;
}

// ── LSP types ──

/** CodeMirror completion item shape returned by lsp_completion. */
export interface CmCompletion {
  label: string;
  detail?: string;
  documentation?: string;
  kind?: number;
  insert_text?: string;
  /** LSP filterText：过滤用文本（可能与 label/insert_text 不同）。CM 用它做前缀过滤。 */
  filter_text?: string;
  /** 原始 LSP CompletionItem（仅当 documentation 缺失且带 data 时返回）：
   *  支持 resolve 的 server 补全条目不带文档，前端选中条目时把它原样回传
   *  lsp_completion_resolve 换取完整文档/签名。 */
  resolve_item?: unknown;
}

/** lsp_signature_help 归一化结果（Rust protocol::signature_help_to_view）。 */
export interface SignatureHelpResult {
  signatures: {
    label: string;
    documentation?: string | null;
    parameters: { label: string; documentation?: string | null }[];
    activeParameter?: number | null;
  }[];
  activeSignature?: number | null;
  activeParameter?: number | null;
}

/** lsp_semantic_tokens 归一化结果（Rust protocol::semantic_tokens_to_view：
 *  LSP delta 编码已解码为绝对坐标）。line 1-based（doc.line() 直用）、
 *  startChar 0-based；tokenType/tokenModifiers 为标准字符串（协议表同源）。 */
export interface SemanticToken {
  line: number;
  startChar: number;
  length: number;
  tokenType: string;
  tokenModifiers: string[];
}

// ── Provider action types ──

/** Rust `commands::provider::PortProbeResult`。 */
export interface PortProbeResult { alive: boolean; detail: string }
/** Rust `commands::provider::LoginStatusResult`。 */
export interface LoginStatusResult { logged_in: boolean; detail: string }
/** Rust `runtime::provider::strategy::ConnectionStatus`——Task 6 实现时读 strategy/mod.rs 核对字段。 */
export interface ConnectionStatus { ok: boolean; detail: string }

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
}

export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// ── Provider types ──

/** TUI 时代的 opus/sonnet/haiku 别名欺骗映射已移除——SDK 版下拉直接展示
 *  供应商的真实模型 id（knownModels）。只保留子代理模型指定（合法 CLI 能力）。 */
export interface ProviderModelMappings {
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
}

export interface RunTarget {
  name: string;
  cwd: string;
  command: string;
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
  total_symbols: number;
  elapsed_ms: number;
}

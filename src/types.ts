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

export interface ChatMessageItem {
  role: string;
  content: string;
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
}

export interface Keybindings {
  searchOpen: string;
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
}

export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// ── Provider types ──

export interface ProviderModelMappings {
  opus: string;
  sonnet: string;
  haiku: string;
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

export interface SkillMeta {
  name: string;
  description: string;
  /** "user" | "project" | "plugin:superpowers" */
  source: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** "claude" | future: "codex" | "opencode" */
  provider: string;
}

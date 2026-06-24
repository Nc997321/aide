export interface Session {
  id: string;
  name: string;
  timestamp: number;
  last_message: string;
}

export interface WorkspaceInfo {
  key: string;
  name: string;
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

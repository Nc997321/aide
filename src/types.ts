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

export interface ChangeRound {
  index: number;
  time: string;
  files: ChangeFile[];
}

export interface ChangeFile {
  path: string;
  additions: number;
  deletions: number;
}

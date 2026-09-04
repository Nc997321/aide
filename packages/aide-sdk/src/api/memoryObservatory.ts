import { getTransport } from "../transport";

// ── Memory Observatory DTO（与 src-tauri/src/commands/memory_observatory/ 的 serde camelCase 镜像）──

export interface MemoryIndexEntry {
  title: string;
  file: string;
  desc: string;
  /** 1-based 行号（截断窗口判定依据）。 */
  line: number;
  byteOffset: number;
}

export interface MemoryIndexInfo {
  lines: number;
  bytes: number;
  entries: MemoryIndexEntry[];
}

export interface MemoryTopic {
  name: string;
  size: number;
  createdMs: number | null;
  modifiedMs: number | null;
  /** 被 MEMORY.md 链接。 */
  indexed: boolean;
  /** 链接条目在截断窗口内（前 200 行 / 25KB）。 */
  withinWindow: boolean;
  sourceDir: string;
}

export interface ClaudeMdInfo {
  path: string;
  bytes: number;
  modifiedMs: number | null;
}

export interface MemoryLimits {
  maxLines: number;
  maxBytes: number;
}

export interface MemoryScanResult {
  index: MemoryIndexInfo | null;
  topics: MemoryTopic[];
  orphans: string[];
  deadlinks: string[];
  claudeMd: ClaudeMdInfo | null;
  limits: MemoryLimits;
}

export interface MemorySnapshotDiff {
  previousTs: number | null;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface MemoryDeleteResult {
  deleted: boolean;
  indexLineRemoved: boolean;
}

export interface MemoryEvent {
  ts: number;
  sessionId: string;
  workspaceKey: string;
  /** read | created | updated | deleted */
  op: string;
  memoryId: string;
}

export interface MemoryEventsResult {
  events: MemoryEvent[];
  /** session_id → 会话显示名。 */
  sessionNames: Record<string, string>;
}

/** readFile 的 CLAUDE.md 特判名（与后端 CLAUDE_MD_ALIAS 一致）。 */
export const CLAUDE_MD_ALIAS = "__claude_md__";

export const memoryObservatoryApi = {
  scan(workspaceKey: string): Promise<MemoryScanResult> {
    return getTransport().invoke("memory_observatory_scan", { workspaceKey });
  },
  readFile(workspaceKey: string, name: string): Promise<string> {
    return getTransport().invoke("memory_observatory_read_file", { workspaceKey, name });
  },
  snapshot(workspaceKey: string): Promise<MemorySnapshotDiff> {
    return getTransport().invoke("memory_observatory_snapshot", { workspaceKey });
  },
  /** 删除 topic 文件；若被 MEMORY.md 引用，索引行一并移除（防死链）。 */
  deleteFile(workspaceKey: string, name: string): Promise<MemoryDeleteResult> {
    return getTransport().invoke("memory_observatory_delete_file", { workspaceKey, name });
  },
  /** 事件台账：memory 目录读写事件（read/created/updated/deleted）+ 会话名映射。 */
  events(workspaceKey: string): Promise<MemoryEventsResult> {
    return getTransport().invoke("memory_observatory_events", { workspaceKey });
  },
};

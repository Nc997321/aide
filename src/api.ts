import { invoke } from "@tauri-apps/api/core";
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
} from "./types";

export const api = {
  // PTY
  ptySpawnClaude(sessionId: string, rows: number, cols: number): Promise<void> {
    return invoke("pty_spawn_claude", { sessionId, rows, cols });
  },
  ptyWrite(sessionId: string, data: string): Promise<void> {
    return invoke("pty_write", { sessionId, data });
  },
  ptyResize(sessionId: string, rows: number, cols: number): Promise<void> {
    return invoke("pty_resize", { sessionId, rows, cols });
  },
  ptyKill(sessionId: string): Promise<void> {
    return invoke("pty_kill", { sessionId });
  },
  ptyHasSession(sessionId: string): Promise<boolean> {
    return invoke("pty_has_session", { sessionId });
  },
  ptyRenameSession(oldId: string, newId: string): Promise<void> {
    return invoke("pty_rename_session", { oldId, newId });
  },
  pollPtyOutput(sessionId: string): Promise<string> {
    return invoke("poll_pty_output", { sessionId });
  },

  // 文件
  getProjectInfo(): Promise<ProjectInfo> {
    return invoke("get_project_info");
  },
  listDirectory(path: string, showHidden?: boolean): Promise<FileEntry[]> {
    return invoke("list_directory", { path, showHidden: showHidden ?? false });
  },
  fileOpen(path: string): Promise<void> {
    return invoke("file_open", { path });
  },
  readFileContent(path: string): Promise<string> {
    return invoke("read_file_content", { path });
  },
  writeFileContent(path: string, content: string): Promise<void> {
    return invoke("write_file_content", { path, content });
  },
  deleteFile(path: string): Promise<void> {
    return invoke("delete_file", { path });
  },
  createFile(parentPath: string, name: string): Promise<void> {
    return invoke("create_file", { parentPath, name });
  },
  createDir(parentPath: string, name: string): Promise<void> {
    return invoke("create_dir", { parentPath, name });
  },

  // Git
  gitDiffFiles(): Promise<DiffEntry[]> {
    return invoke("git_diff_files");
  },
  gitStageAll(): Promise<void> {
    return invoke("git_stage_all");
  },
  gitRevertFile(path: string): Promise<void> {
    return invoke("git_revert_file", { path });
  },
  gitHasFile(path: string): Promise<boolean> {
    return invoke("git_has_file", { path });
  },

  // 会话
  listSessions(): Promise<Session[]> {
    return invoke("list_sessions");
  },
  loadMessages(sessionId: string): Promise<ChatMessageItem[]> {
    return invoke("load_messages", { sessionId });
  },
  createSession(name: string): Promise<Session> {
    return invoke("create_session", { name });
  },
  deleteSession(id: string): Promise<void> {
    return invoke("delete_session", { id });
  },
  renameSession(id: string, name: string): Promise<void> {
    return invoke("rename_session", { id, name });
  },
  sessionLastEvent(sessionId: string): Promise<LastEventInfo> {
    return invoke("session_last_event", { sessionId });
  },
  loadSessionChanges(sessionId: string): Promise<ChangeRound[]> {
    return invoke("load_session_changes", { sessionId });
  },
  saveSessionChanges(sessionId: string, rounds: ChangeRound[]): Promise<void> {
    return invoke("save_session_changes", { sessionId, rounds });
  },

  // 通知（绕过插件 dev 模式限制）
  notifySend(title: string, body: string): Promise<void> {
    return invoke("notify_send", { title, body });
  },

  // 设置
  getSettings(): Promise<AppSettings> {
    return invoke("get_settings");
  },
  setSettings(settings: Partial<AppSettings>): Promise<void> {
    return invoke("set_settings", { settings });
  },

  // 工作区
  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return invoke("list_workspaces");
  },
  setWorkspace(key: string, path: string): Promise<void> {
    return invoke("set_workspace", { key, path });
  },
};

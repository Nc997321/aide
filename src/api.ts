import { invoke } from "@tauri-apps/api/core";
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
  GrepMatch, ProviderConfig, RunConfig, RunTarget, RecentView,
  SkillMeta,
} from "./types";

export const api = {
  // Shell (workbench terminal)
  ptyWrite(sessionId: string, data: string): Promise<void> {
    return invoke("pty_write", { sessionId, data });
  },
  ptyResize(sessionId: string, rows: number, cols: number): Promise<void> {
    return invoke("pty_resize", { sessionId, rows, cols });
  },
  ptyKill(sessionId: string): Promise<void> {
    return invoke("pty_kill", { sessionId });
  },
  pollPtyOutput(sessionId: string): Promise<string> {
    return invoke("poll_pty_output", { sessionId });
  },
  ptySpawnShell(sessionId: string, rows: number, cols: number, cwd: string, shell: string): Promise<void> {
    return invoke("pty_spawn_shell", { sessionId, rows, cols, cwd, shell });
  },

  // Chat (Agent SDK)
  stopChatSession(sessionId: string): Promise<void> {
    return invoke("stop_chat_session", { sessionId });
  },
  interruptSession(sessionId: string): Promise<void> {
    return invoke("interrupt_session", { sessionId });
  },

  // Plugin skills
  scanPluginSkills(cwd: string, provider?: string): Promise<SkillMeta[]> {
    return invoke("scan_plugin_skills", { cwd, provider: provider ?? null });
  },

  // 剪贴板（文件 / 图片粘贴进 Claude TUI）
  clipboardReadFiles(): Promise<string[]> {
    return invoke("clipboard_read_files");
  },
  clipboardReadImage(): Promise<string | null> {
    return invoke("clipboard_read_image");
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
  showInExplorer(path: string): Promise<void> {
    return invoke("show_in_explorer", { path });
  },
  detectRunCommand(cwd: string): Promise<string | null> {
    return invoke("detect_run_command", { cwd });
  },
  listRunConfigs(wsKey: string): Promise<RunConfig[]> {
    return invoke("list_run_configs", { ws_key: wsKey });
  },
  saveRunConfigs(wsKey: string, configs: RunConfig[]): Promise<void> {
    return invoke("save_run_configs", { ws_key: wsKey, configs });
  },
  detectRunTargets(cwd: string): Promise<RunTarget[]> {
    return invoke("detect_run_targets", { cwd });
  },
  runProcessStart(configId: string, cwd: string, command: string): Promise<string> {
    return invoke("run_process_start", { configId, cwd, command });
  },
  runProcessStop(configId: string): Promise<void> {
    return invoke("run_process_stop", { configId });
  },
  readFileContent(path: string): Promise<string> {
    return invoke("read_file_content", { path });
  },
  readFileBinary(path: string): Promise<ArrayBuffer> {
    return invoke("read_file_binary", { path });
  },
  writeFileContent(path: string, content: string): Promise<void> {
    return invoke("write_file_content", { path, content });
  },
  // Windows「打开方式」集成
  consumePendingOpenFile(): Promise<string | null> {
    return invoke("consume_pending_open_file");
  },
  setOpenWithExtensions(extensions: string[]): Promise<void> {
    return invoke("set_open_with_extensions", { extensions });
  },
  registerOpenWith(extensions: string[]): Promise<void> {
    return invoke("register_open_with", { extensions });
  },
  unregisterOpenWith(extensions: string[]): Promise<void> {
    return invoke("unregister_open_with", { extensions });
  },
  deleteFile(path: string): Promise<void> {
    return invoke("delete_file", { path });
  },
  fileExists(path: string): Promise<boolean> {
    return invoke("file_exists", { path });
  },
  copyFile(src: string, dest: string): Promise<void> {
    return invoke("copy_file", { src, dest });
  },
  moveFile(src: string, dest: string): Promise<void> {
    return invoke("move_file", { src, dest });
  },
  createFile(parentPath: string, name: string): Promise<void> {
    return invoke("create_file", { parentPath, name });
  },
  createDir(parentPath: string, name: string): Promise<void> {
    return invoke("create_dir", { parentPath, name });
  },

  // 符号搜索（跳转到定义）
  grepSymbol(word: string, cwd: string, sourceExt?: string): Promise<GrepMatch[]> {
    return invoke("grep_symbol", { word, cwd, sourceExt: sourceExt ?? null });
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
  findSessionsSince(sinceMs: number): Promise<string[]> {
    return invoke("find_sessions_since", { sinceMs });
  },
  listSessionsForWorkspace(wsKey: string): Promise<Session[]> {
    return invoke("list_sessions_for_workspace", { wsKey });
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
  sessionJsonlSize(sessionId: string): Promise<number> {
    return invoke("session_jsonl_size", { sessionId });
  },
  truncateSessionJsonl(sessionId: string, bytePos: number): Promise<void> {
    return invoke("session_truncate_jsonl", { sessionId, bytePos });
  },

  // 通知（绕过插件 dev 模式限制）
  notifySend(title: string, body: string, sessionId?: string): Promise<void> {
    return invoke("notify_send", { title, body, sessionId: sessionId ?? null });
  },
  getPendingNotification(): Promise<string | null> {
    return invoke("get_pending_notification");
  },

  // 设置
  getSettings(): Promise<AppSettings> {
    return invoke("get_settings");
  },
  setSettings(settings: Partial<AppSettings>): Promise<void> {
    return invoke("set_settings", { settings });
  },

  // 供应商
  getProviders(): Promise<ProviderConfig[]> {
    return invoke("get_providers");
  },
  setProviders(providers: ProviderConfig[]): Promise<void> {
    return invoke("set_providers", { providers });
  },
  getActiveProviderId(): Promise<string> {
    return invoke("get_active_provider_id");
  },
  setActiveProviderId(providerId: string): Promise<void> {
    return invoke("set_active_provider_id", { providerId });
  },

  // 工作区
  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return invoke("list_workspaces");
  },
  setWorkspace(key: string, path: string): Promise<void> {
    return invoke("set_workspace", { key, path });
  },

  // 最近访问
  recordRecentSession(wsKey: string, wsName: string, sessionId: string, name: string): Promise<void> {
    return invoke("record_recent_session", { wsKey, wsName, sessionId, name });
  },
  recordRecentFile(wsKey: string, path: string, name: string): Promise<void> {
    return invoke("record_recent_file", { wsKey, path, name });
  },
  listRecent(wsKey: string): Promise<RecentView> {
    return invoke("list_recent", { wsKey });
  },
  removeRecentSession(sessionId: string): Promise<void> {
    return invoke("remove_recent_session", { sessionId });
  },
  clearRecent(category?: "sessions" | "files"): Promise<void> {
    return invoke("clear_recent", { category: category ?? null });
  },
};

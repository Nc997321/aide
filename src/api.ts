import { invoke } from "@tauri-apps/api/core";
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
  GrepMatch, ProviderConfig, ProviderModelMappings, RunConfig, RunTarget, JdkEntry, RecentView,
  SkillMeta, BuildIndexResult, BuildProgress, RescanResult, QueryResult,
  AppNotification, NotificationRecord,
} from "./types";
import type { ModelOption, PermissionModeOption } from "./types/chat";

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
  /** 切换存活会话的模型；返回 false = 无活进程（选择随下一条消息 initialModel
   *  生效，调用方应走 deferred 提示路径）。 */
  setModel(sessionId: string, model: string): Promise<boolean> {
    return invoke("set_model", { sessionId, model });
  },
  /** 记住/读回会话的模型选择（会话元数据，重启不丢）——与运行时 set_model 互补：
   *  这个管「下次进会话恢复什么」，set_model 管「当前进程切到什么」。 */
  setSessionModel(id: string, model: string): Promise<void> {
    return invoke("set_session_model", { id, model });
  },
  sessionModel(id: string): Promise<string | null> {
    return invoke("session_model", { id });
  },
  getDefaultModels(): Promise<ModelOption[]> {
    return invoke("get_default_models");
  },
  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return invoke("set_permission_mode", { sessionId, mode });
  },
  getDefaultPermissionModes(): Promise<PermissionModeOption[]> {
    return invoke("get_default_permission_modes");
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
  listFsRoots(): Promise<FileEntry[]> {
    return invoke("list_fs_roots");
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
    return invoke("list_run_configs", { wsKey });
  },
  saveRunConfigs(wsKey: string, configs: RunConfig[]): Promise<void> {
    return invoke("save_run_configs", { wsKey, configs });
  },
  detectRunTargets(cwd: string): Promise<RunTarget[]> {
    return invoke("detect_run_targets", { cwd });
  },
  runProcessStart(configId: string, cwd: string, command: string, env: Record<string, string>): Promise<string> {
    return invoke("run_process_start", { configId, cwd, command, env });
  },
  runProcessStop(configId: string): Promise<void> {
    return invoke("run_process_stop", { configId });
  },
  readFileContent(path: string): Promise<string> {
    return invoke("read_file_content", { path });
  },
  readFileBase64(path: string): Promise<string> {
    return invoke("read_file_base64", { path });
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
  findFilesByName(query: string, cwd: string, limit?: number): Promise<string[]> {
    return invoke("find_files_by_name", { query, cwd, limit: limit ?? null });
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
  createSession(id: string, name: string): Promise<Session> {
    return invoke("create_session", { id, name });
  },
  deleteSession(id: string): Promise<void> {
    return invoke("delete_session", { id });
  },
  renameSession(id: string, name: string): Promise<void> {
    return invoke("rename_session", { id, name });
  },
  renameSidecarSession(oldId: string, newId: string): Promise<void> {
    return invoke("rename_sidecar_session", { oldId, newId });
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

  // 通知中心持久化
  loadNotifications(): Promise<NotificationRecord[]> {
    return invoke("load_notifications");
  },
  saveNotifications(records: NotificationRecord[]): Promise<void> {
    return invoke("save_notifications", { records });
  },

  // 设置
  getSettings(): Promise<AppSettings> {
    return invoke("get_settings");
  },
  setSettings(settings: Partial<AppSettings>): Promise<void> {
    return invoke("set_settings", { settings });
  },

  // JDK 注册表（按项目选 JDK）
  scanJdks(): Promise<JdkEntry[]> {
    return invoke("scan_jdks");
  },
  resolveJdk(path: string): Promise<JdkEntry | null> {
    return invoke("resolve_jdk", { path });
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
  getSystemDefaultModelMappings(): Promise<ProviderModelMappings> {
    return invoke("get_system_default_model_mappings");
  },
  setSystemDefaultModelMappings(mappings: ProviderModelMappings): Promise<void> {
    return invoke("set_system_default_model_mappings", { mappings });
  },
  refreshSystemDefaultModels(): Promise<ProviderModelMappings> {
    return invoke("refresh_system_default_models");
  },

  // 工作区
  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return invoke("list_workspaces");
  },
  setWorkspace(key: string, path: string): Promise<void> {
    return invoke("set_workspace", { key, path });
  },
  createWorkspace(path: string): Promise<WorkspaceInfo> {
    return invoke("create_workspace", { path });
  },
  removeWorkspace(key: string, mode: "hide" | "delete"): Promise<void> {
    return invoke("remove_workspace", { key, mode });
  },
  unhideWorkspace(key: string): Promise<void> {
    return invoke("unhide_workspace", { key });
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

  // CodeGraph — enhanced code navigation
  codegraphBuildIndex(projectRoot: string, force = false): Promise<BuildIndexResult> {
    return invoke("codegraph_build_index", { projectRoot, force });
  },
  codegraphGotoDefinition(
    word: string,
    file: string,
    line: number,
    column: number,
    projectRoot: string,
  ): Promise<QueryResult[]> {
    return invoke("codegraph_goto_definition", { word, file, line, column, projectRoot });
  },
  codegraphClose(projectRoot: string): Promise<void> {
    return invoke("codegraph_close", { projectRoot });
  },
  codegraphReindexFile(
    projectRoot: string,
    file: string,
  ): Promise<{ reindexed: boolean; skipped?: string } | undefined> {
    return invoke("codegraph_reindex_file", { projectRoot, file });
  },
  /** 增量重扫：只 reindex mtime > indexed_at 的文件（手动「更新索引」）。 */
  codegraphRescan(projectRoot: string): Promise<RescanResult> {
    return invoke("codegraph_rescan", { projectRoot });
  },
  /** 粗粒度构建进度（纯原子读，同步 inline 命令）。前端定时 poll。 */
  codegraphBuildProgress(): Promise<BuildProgress> {
    return invoke("codegraph_build_progress");
  },
};

import { invoke } from "@tauri-apps/api/core";
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem,
  ProjectInfo, DiffEntry, LastEventInfo, ChangeRound, AppSettings,
  GrepMatch, ProviderConfig, ProviderConfigInput, ProviderModelMappings, RunConfig, RunTarget, JdkEntry, RecentView,
  SearchOptions, SearchResponse, ReplacePreviewResponse, ReplaceFileInput, ApplyResult,
  SkillMeta, BuildIndexResult, BuildProgress, RescanResult, QueryResult, LspJumpResult,
  AppNotification, NotificationRecord,
  CatalogPreset, PortProbeResult, LoginStatusResult, ConnectionStatus,
  MigrationStatus, MigrationSummary,
  CmCompletion,
  DocumentSymbolItem, LspCapabilities,
  RemoteStatus,
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
  /** 终止一个后台任务；终态经 bg_task_ended(status:"stopped") 回来，无单独回执。 */
  stopBgTask(sessionId: string, taskId: string): Promise<void> {
    return invoke("stop_bg_task", { sessionId, taskId });
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
  /** 切换存活会话的 effort；返回 false = 无活进程（选择随下一条消息 env 通道
   *  生效，与 initialModel 同一语义）。 */
  setEffort(sessionId: string, effort: string): Promise<boolean> {
    return invoke("set_effort", { sessionId, effort });
  },
  /** 记住/读回会话的 effort 选择（会话元数据，重启不丢）。 */
  setSessionEffort(id: string, effort: string): Promise<void> {
    return invoke("set_session_effort", { id, effort });
  },
  sessionEffort(id: string): Promise<string | null> {
    return invoke("session_effort", { id });
  },
  /** 记住/读回会话绑定的供应商 id（会话元数据，重开 app 后恢复会话供应商绑定，
   *  只恢复该会话绑定不动全局激活）。provider 为空 = 清除（回落全局激活供应商）。 */
  setSessionProvider(id: string, provider: string): Promise<void> {
    return invoke("set_session_provider", { id, provider });
  },
  sessionProvider(id: string): Promise<string | null> {
    return invoke("session_provider", { id });
  },
  getDefaultModels(): Promise<ModelOption[]> {
    return invoke("get_default_models");
  },
  probeImageInput(model?: string): Promise<{ supported: boolean | null }> {
    return invoke("probe_image_input", { model: model || null });
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
  // 外部拖入的 OS 文件落到临时目录，返回路径（仅当 WebView2 不暴露 File.path 时兜底）
  stageDroppedFile(name: string, base64: string): Promise<string> {
    return invoke("stage_dropped_file", { name, base64 });
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
  runProcessStart(configId: string, cwd: string, command: string, env: Record<string, string>, rows: number, cols: number): Promise<string> {
    return invoke("run_process_start", { configId, cwd, command, env, rows, cols });
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
  // 批量探测路径类型（"file"|"dir"|"none"），输入框 @path→mention 芯片转换用
  pathTypes(paths: string[]): Promise<("file" | "dir" | "none")[]> {
    return invoke("path_types", { paths });
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

  // 全局搜索 + 替换（Find in Files）
  searchInFiles(query: string, cwd: string, options: SearchOptions): Promise<SearchResponse> {
    return invoke("search_in_files", { query, cwd, options });
  },
  replaceInFilesPreview(
    query: string,
    replacement: string,
    cwd: string,
    options: SearchOptions,
  ): Promise<ReplacePreviewResponse> {
    return invoke("replace_in_files_preview", { query, replacement, cwd, options });
  },
  applyReplacements(files: ReplaceFileInput[]): Promise<ApplyResult> {
    return invoke("apply_replacements", { files });
  },

  // Git
  gitDiffFiles(): Promise<DiffEntry[]> {
    return invoke("git_diff_files");
  },
  gitRevertFile(path: string): Promise<void> {
    return invoke("git_revert_file", { path });
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

  // 一次性迁移：从用户系统 ~/.claude/ 拷到 Aide 自管理目录
  checkClaudeMigration(): Promise<MigrationStatus> {
    return invoke("check_claude_migration");
  },
  migrateClaudeData(): Promise<MigrationSummary> {
    return invoke("migrate_claude_data");
  },
  dismissClaudeMigration(): Promise<void> {
    return invoke("dismiss_claude_migration");
  },

  // 设置
  getSettings(): Promise<AppSettings> {
    return invoke("get_settings");
  },
  /** 探测本机自动可用的代理（不含用户已配置值）；设置面板「网络代理」为空时提示一键填入。 */
  detectAvailableProxy(): Promise<string | null> {
    return invoke("detect_available_proxy");
  },
  setSettings(settings: Partial<AppSettings> | { codegraphEmbedder: Record<string, unknown> }): Promise<void> {
    return invoke("set_settings", { settings });
  },

  // 远程控制网关
  remoteGetStatus(): Promise<RemoteStatus> {
    return invoke("remote_get_status");
  },
  remoteSetEnabled(enabled: boolean): Promise<void> {
    return invoke("remote_set_enabled", { enabled });
  },
  remoteRefreshPairingCode(): Promise<string> {
    return invoke("remote_refresh_pairing_code");
  },
  remoteRevoke(): Promise<void> {
    return invoke("remote_revoke");
  },

  // JDK 注册表（机器级；工作区选哪个走 workspace_get/set_jdk）
  scanJdks(): Promise<JdkEntry[]> {
    return invoke("scan_jdks");
  },
  resolveJdk(path: string): Promise<JdkEntry | null> {
    return invoke("resolve_jdk", { path });
  },

  // 工作区级 JDK（一个工作区一个 JDK，所有运行配置共享；空 = 系统默认）
  workspaceGetJdk(workspaceRoot: string): Promise<string> {
    return invoke("workspace_get_jdk", { workspaceRoot });
  },
  workspaceSetJdk(workspaceRoot: string, jdkHome: string): Promise<void> {
    return invoke("workspace_set_jdk", { workspaceRoot, jdkHome });
  },

  // 供应商
  getProviders(): Promise<ProviderConfig[]> {
    return invoke("get_providers");
  },
  setProviders(providers: ProviderConfigInput[]): Promise<void> {
    return invoke("set_providers", { providers });
  },
  getActiveProviderId(): Promise<string> {
    return invoke("get_active_provider_id");
  },
  setActiveProviderId(providerId: string): Promise<void> {
    return invoke("set_active_provider_id", { providerId });
  },
  getProviderCatalog(): Promise<CatalogPreset[]> {
    return invoke("get_provider_catalog");
  },
  testProviderConnection(providerId: string): Promise<ConnectionStatus> {
    return invoke("test_provider_connection", { providerId });
  },
  cpaProbePort(): Promise<PortProbeResult> {
    return invoke("cpa_probe_port");
  },
  cpaOpenManagement(): Promise<string> {
    return invoke("cpa_open_management");
  },
  cpaLoginStatus(): Promise<LoginStatusResult> {
    return invoke("cpa_login_status");
  },
  viewAnthropicQuota(): Promise<unknown> {
    return invoke("view_anthropic_quota");
  },
  refreshModels(providerId: string): Promise<ProviderModelMappings> {
    return invoke("refresh_models", { providerId });
  },
  /** ~/.aide/claude/.credentials.json 是否存在（claude.exe OAuth 登录后写入）。 */
  claudeCredentialsExist(): Promise<boolean> {
    return invoke("claude_credentials_exist");
  },
  /** 启动 Claude OAuth 登录。返回授权 URL（A2 成功）或 degraded=true（降级到 API key）。OAuth 未接入前恒返回 degraded。 */
  claudeStartLogin(): Promise<{ authorizeUrl: string | null; degraded: boolean }> {
    return invoke("claude_start_login");
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

  // ── LSP ──

  lspDetectLanguages(workspaceRoot: string): Promise<string[]> {
    return invoke("lsp_detect_languages", { workspaceRoot });
  },
  lspEnsureServer(workspaceRoot: string, lang: string): Promise<{ ok: boolean; ready: boolean; kind?: string; error?: string }> {
    return invoke("lsp_ensure_server", { workspaceRoot, lang });
  },
  lspDidOpen(workspaceRoot: string, filePath: string, lang: string, text: string): Promise<void> {
    return invoke("lsp_did_open", { workspaceRoot, filePath, lang, text });
  },
  lspDidChange(workspaceRoot: string, filePath: string, lang: string, text: string, version?: number): Promise<void> {
    return invoke("lsp_did_change", { workspaceRoot, filePath, lang, text, version });
  },
  lspDidClose(workspaceRoot: string, filePath: string, lang: string): Promise<void> {
    return invoke("lsp_did_close", { workspaceRoot, filePath, lang });
  },
  lspDefinition(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<LspJumpResult> {
    return invoke("lsp_definition", { workspaceRoot, filePath, line, column, word });
  },
  lspCompletion(workspaceRoot: string, filePath: string, line: number, column: number): Promise<CmCompletion[]> {
    return invoke("lsp_completion", { workspaceRoot, filePath, line, column });
  },
  lspHover(workspaceRoot: string, filePath: string, line: number, column: number): Promise<{ content: string | null }> {
    return invoke("lsp_hover", { workspaceRoot, filePath, line, column });
  },
  lspImplementation(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<QueryResult[]> {
    return invoke("lsp_implementation", { workspaceRoot, filePath, line, column, word });
  },
  lspDocumentSymbol(workspaceRoot: string, filePath: string): Promise<DocumentSymbolItem[]> {
    return invoke("lsp_document_symbol", { workspaceRoot, filePath });
  },
  lspCapabilities(workspaceRoot: string, lang: string): Promise<LspCapabilities> {
    return invoke("lsp_capabilities", { workspaceRoot, lang });
  },
  lspShutdownWorkspace(workspaceRoot: string): Promise<void> {
    return invoke("lsp_shutdown_workspace", { workspaceRoot });
  },
  openLspInstallGuide(): Promise<void> {
    return invoke("open_lsp_install_guide");
  },
  workspaceSetLspEnabled(workspaceRoot: string, enabled: boolean): Promise<void> {
    return invoke("workspace_set_lsp_enabled", { workspaceRoot, enabled });
  },
  workspaceSetLspExcludes(workspaceRoot: string, dirs: string[]): Promise<void> {
    return invoke("workspace_set_lsp_excludes", { workspaceRoot, dirs });
  },
  workspaceGetLspExcludes(workspaceRoot: string): Promise<string[]> {
    return invoke("workspace_get_lsp_excludes", { workspaceRoot });
  },

  // 工作区信任（Trusted Workspace）— 路径入参，Rust 内部点号归一。
  isWorkspaceTrusted(path: string): Promise<boolean> {
    return invoke("is_workspace_trusted", { path });
  },
  /** 信任工作区：返回自动写入的安全命令规则条数（幂等，已存在则 0）。 */
  trustWorkspace(path: string): Promise<number> {
    return invoke("trust_workspace", { path });
  },
  /** 取消信任：返回移除的自动安全规则条数。 */
  untrustWorkspace(path: string): Promise<number> {
    return invoke("untrust_workspace", { path });
  },
};

export { permissionsApi } from "./api/permissions";

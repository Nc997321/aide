import { getTransport } from "./transport";
import type {
  Session, WorkspaceInfo, FileEntry, ChatMessageItem, LoadMessagesResult,
  ClipboardFilesRead,
  ProjectInfo, DiffEntry, DiffPair, LastEventInfo, ChangeRound, AppSettings,
  CommitEntry, CommitDetail, BranchInfo, GitStatusEntry, StashEntry,
  AheadBehind, FetchPullOutcome, TagEntry, CompareResult,
  GrepMatch, ProviderConfig, ProviderConfigInput, ProviderModelMappings, RunConfig, RunTarget, JdkEntry, RecentView,
  SearchOptions, SearchResponse, ReplacePreviewResponse, ReplaceFileInput, ApplyResult,
  SkillMeta, BuildIndexResult, BuildProgress, RescanResult, QueryResult, LspJumpResult,
  AppNotification, NotificationRecord,
  CatalogPreset, PortProbeResult, LoginStatusResult, ConnectionStatus,
  MigrationStatus, MigrationSummary,
  CmCompletion,
  DocumentSymbolItem, LspCapabilities, SignatureHelpResult, SemanticToken,
  CallHierarchyResult, CallHierarchyDirection, InlayHintItem,
  RemoteStatus,
} from "./types";
import type { ModelOption, PermissionModeOption, UserMessageBlock, MetaField, SessionMetaPatch, IdentityDrift } from "./types/chat";
import type { PermissionRuleDraft } from "./types/permissions";

/** send_message 的完整负载（IPC 边界 DTO）。可空字段 null = Rust None。 */
export interface SendMessageParams {
  sessionId: string;
  prompt: string;
  /** 会话归属工作区根路径；null = Rust 回落当前活动工作区 */
  workspaceRoot?: string | null;
  /** 图片附件（sidecar 图片输入对象） */
  images?: { data: string; mediaType: string }[] | null;
  /** 用户气泡的渲染描述（@引用卡片 / 动作胶囊）。sidecar 不解释内容，只原样随
   *  `user_message` 事件回灌——这是远程客户端发的消息能在所有端正确渲染的关键
   *  （发给模型的 prompt 已把 @引用展开成一坨文本，结构信息只存在于这里）。
   *  不传（鸿蒙 v1 / PWA）→ 接收端降级渲染纯文本气泡。 */
  display?: UserMessageBlock[] | null;
  /** 会话身份层解析出的 provider 绑定；null = 会话元数据 → 全局 active 兜底 */
  provider?: string | null;
  resumeId?: string | null;
  /** 仅 spawn 分支生效（首条消息）；存活会话切模型走 setModel */
  initialModel?: string | null;
  /** 与 initialModel 同一条 env 通道（CLAUDE_CODE_EFFORT_LEVEL） */
  initialEffort?: string | null;
  /** 每条消息透传当前权限模式，sidecar 幂等 */
  permissionMode?: string | null;
  /** 排队发送标记：sidecar 在安全边界自行 interrupt 后再发 */
  jumpQueue?: boolean | null;
}

/** permission_response 的完整负载（IPC 边界 DTO）。 */
export interface PermissionResponseParams {
  sessionId: string;
  id: string;
  approved: boolean;
  /** AskUserQuestion 类工具的作答 */
  answers?: Record<string, string>;
  /** 「允许并切换模式」的目标模式 */
  nextMode?: string;
  /** 拒绝理由（UI 的 reason → 协议的 message） */
  message?: string;
  /** 「允许并记住」勾选的规则草稿 */
  sessionRules?: PermissionRuleDraft[];
}

/** btw_ask 的完整负载（IPC 边界 DTO）。
 *  sessionId 是**主会话** id——btw 不再有独立会话 id，也不再起独立进程。
 *  history 由发起端维护（封顶 20 轮），形状与官方 side_question 的 history 元素一致。 */
export interface BtwAskParams {
  sessionId: string;
  question: string;
  history: { question: string; response: string }[];
}

/** 长动画帧（LoAF）归因：一帧拆成「脚本 / 样式布局 / 其余」，并点名到函数。
 *  其余量（`restMs`）= 既非脚本也非布局 —— GC / 空闲 / 光栅化的嫌疑区。
 *  `forcedLayoutMs` 是**强制同步布局**耗时（读写回环的度量）。
 *  产出侧是桌面 `src/utils/diagnostics/longFrames.ts`；此处是**线上形状**声明，
 *  不反向 import 产出侧类型（SDK 不依赖 src）。 */
export interface DiagLongFrame {
  durationMs: number;
  scriptMs: number;
  styleLayoutMs: number;
  restMs: number;
  forcedLayoutMs: number;
  blockingMs: number;
  scripts: {
    invoker: string;
    source: string;
    func: string;
    durationMs: number;
    forcedLayoutMs: number;
  }[];
}

/** diag_heartbeat 的负载（IPC 边界 DTO，镜像 Rust HeartbeatPayload）。 */
export interface DiagHeartbeatPayload {
  lagMaxMs: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  crumbs: unknown[];
  hidden: boolean;
  /** 本周期长帧：条数 + 最长那一帧的完整分解。
   *  `supported=false` = 本环境没装上 LoAF（Chromium 过老），此时 count 恒 0 ——
   *  必须与「确实没长帧」区分开，否则报告会被读成"渲染没问题"。 */
  frames: { count: number; worst: DiagLongFrame | null; supported: boolean };
}

export const api = {
  // Shell (workbench terminal)
  ptyWrite(sessionId: string, data: string): Promise<void> {
    return getTransport().invoke("pty_write", { sessionId, data });
  },
  ptyResize(sessionId: string, rows: number, cols: number): Promise<void> {
    return getTransport().invoke("pty_resize", { sessionId, rows, cols });
  },
  ptyKill(sessionId: string): Promise<void> {
    return getTransport().invoke("pty_kill", { sessionId });
  },
  pollPtyOutput(sessionId: string): Promise<string> {
    return getTransport().invoke("poll_pty_output", { sessionId });
  },
  ptySpawnShell(sessionId: string, rows: number, cols: number, cwd: string, shell: string): Promise<void> {
    return getTransport().invoke("pty_spawn_shell", { sessionId, rows, cols, cwd, shell });
  },

  // Chat (Agent SDK)
  stopChatSession(sessionId: string): Promise<void> {
    return getTransport().invoke("stop_chat_session", { sessionId });
  },
  interruptSession(sessionId: string): Promise<void> {
    return getTransport().invoke("interrupt_session", { sessionId });
  },
  /** 发送一条用户消息（fire-and-forget 语义由调用方决定：新会话 Rust 现拉起
   *  进程较慢，调用点通常 .catch 兜底不 await）。DTO 字段即 send_message 参数；
   *  可空字段的 null = Rust 侧 None（边界 DTO 镜像，不适用假三态细则）。 */
  sendMessage(params: SendMessageParams): Promise<void> {
    return getTransport().invoke("send_message", { ...params });
  },
  /** 权限弹窗应答。sessionRules = 「允许并记住」勾选的规则草稿。 */
  permissionResponse(params: PermissionResponseParams): Promise<void> {
    return getTransport().invoke("permission_response", { ...params });
  },
  /** btw 侧问：走存活主会话进程内的官方 side_question 通道（不起新进程）。
   *  **fire-and-forget**：正文与错误一律经 btw_answer 事件回来（UI 状态只认事件
   *  通道），这里的 resolve 只表示命令已写进 sidecar stdin。 */
  btwAsk(params: BtwAskParams): Promise<void> {
    return getTransport().invoke("btw_ask", { ...params });
  },
  /** 终止一个后台任务；终态经 bg_task_ended(status:"stopped") 回来，无单独回执。 */
  stopBgTask(sessionId: string, taskId: string): Promise<void> {
    return getTransport().invoke("stop_bg_task", { sessionId, taskId });
  },
  /** 切换存活会话的模型；返回 false = 无活进程（选择随下一条消息 initialModel
   *  生效，调用方应走 deferred 提示路径）。 */
  setModel(sessionId: string, model: string): Promise<boolean> {
    return getTransport().invoke("set_model", { sessionId, model });
  },
  /** 模型切换成本确认的用户决定（model_switch_confirm 弹窗回传）；confirmId 对
   *  不上时 sidecar 静默忽略。 */
  modelSwitchConfirmDecision(sessionId: string, confirmId: string, approve: boolean): Promise<void> {
    return getTransport().invoke("model_switch_confirm_decision", { sessionId, confirmId, approve });
  },
  /** 会话元数据的唯一写入入口：provider / model / effort 一次写齐（一次读、一次写）。
   *
   *  取代 set_session_provider / set_session_model / set_session_effort 三个单字段命令——
   *  它们各自对同一个 `<id>.json` 做一遍 read-modify-write，L1 并发写两个字段时后写的
   *  覆盖先写的（lost update）。省略的字段按 keep 处理（不动盘上值）。
   *
   *  注意与运行时命令区分：`setModel` / `setEffort` 切的是**当前进程**，本命令写的是
   *  **下次进会话恢复什么**。 */
  setSessionMeta(id: string, patch: SessionMetaPatch): Promise<void> {
    return getTransport().invoke("set_session_meta", {
      id,
      provider: patch.provider ?? { op: "keep" },
      model: patch.model ?? { op: "keep" },
      effort: patch.effort ?? { op: "keep" },
    });
  },
  sessionModel(id: string): Promise<string | null> {
    return getTransport().invoke("session_model", { id });
  },
  /** 切换存活会话的 effort；返回 false = 无活进程（选择随下一条消息 env 通道
   *  生效，与 initialModel 同一语义）。 */
  setEffort(sessionId: string, effort: string): Promise<boolean> {
    return getTransport().invoke("set_effort", { sessionId, effort });
  },
  sessionEffort(id: string): Promise<string | null> {
    return getTransport().invoke("session_effort", { id });
  },
  sessionProvider(id: string): Promise<string | null> {
    return getTransport().invoke("session_provider", { id });
  },
  /** 会话进程是否存活（唯一权威来源：Rust 侧存活表）。
   *  存活 → 会话锁定自己的供应商；未存活 → 跟随全局激活供应商。 */
  sessionAlive(id: string): Promise<boolean> {
    return getTransport().invoke("session_alive", { id });
  },
  /**
   * 发送前身份漂移判定：本次将生效的 provider / model 与会话上次坐实的基线逐维
   * 比对，**先供应商、再模型**——两者都相同才判无漂移。
   *
   * 判定规则在 Rust 侧只有一份（`commands/session::compute_identity_drift`），
   * 桌面端与鸿蒙端共用，不各自实现。基线缺失（会话从未发过 / 字段为空）→ 该
   * 维度 false（无基线不弹确认）；providerId / model 传空串 = 本次未指定，
   * 同样判 false。
   *
   * 只回答「哪一维漂了」，**弹不弹、文案怎么写归调用方**。
   */
  sessionIdentityDrift(
    id: string,
    providerId: string,
    model: string,
  ): Promise<IdentityDrift> {
    return getTransport().invoke("session_identity_drift", {
      id,
      providerId,
      model,
    });
  },
  /** 系统默认供应商（Anthropic 官方）的模型选项，Rust 从 catalog 预设读。
   *  数据源 = provider-catalog.json 的 system_default.models（4 个别名）。 */
  getDefaultModels(): Promise<ModelOption[]> {
    return getTransport().invoke("get_default_models");
  },
  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return getTransport().invoke("set_permission_mode", { sessionId, mode });
  },
  getDefaultPermissionModes(): Promise<PermissionModeOption[]> {
    return getTransport().invoke("get_default_permission_modes");
  },

  // Plugin skills
  scanPluginSkills(cwd: string, provider?: string): Promise<SkillMeta[]> {
    return getTransport().invoke("scan_plugin_skills", { cwd, provider: provider ?? null });
  },

  // 剪贴板（文件 / 图片粘贴进 Claude TUI）
  clipboardReadFiles(): Promise<ClipboardFilesRead> {
    return getTransport().invoke("clipboard_read_files");
  },
  /** 文件路径写入系统剪贴板（文件管理器语义），文件树 Ctrl+C/X 双写用；
   *  op 决定资源管理器粘贴时是复制还是移动 */
  clipboardWriteFiles(paths: string[], op: "copy" | "cut"): Promise<void> {
    return getTransport().invoke("clipboard_write_files", { paths, op });
  },
  clipboardReadImage(): Promise<string | null> {
    return getTransport().invoke("clipboard_read_image");
  },
  // 外部拖入的 OS 文件落到临时目录，返回路径（仅当 WebView2 不暴露 File.path 时兜底）
  stageDroppedFile(name: string, base64: string): Promise<string> {
    return getTransport().invoke("stage_dropped_file", { name, base64 });
  },

  // 文件
  getProjectInfo(): Promise<ProjectInfo> {
    return getTransport().invoke("get_project_info");
  },
  /**
   * 列目录。
   * @param showHidden 是否显示点开头的隐藏项（.git / .vscode / .env …）
   * @param includeIgnored 是否显示构建噪音目录（node_modules / target / dist）。
   *   与 showHidden 分开：隐藏项按需可见，噪音目录几乎从不该出现在目录选择器里。
   */
  listDirectory(path: string, showHidden?: boolean, includeIgnored?: boolean): Promise<FileEntry[]> {
    return getTransport().invoke("list_directory", {
      path,
      showHidden: showHidden ?? false,
      includeIgnored: includeIgnored ?? false,
    });
  },
  listFsRoots(): Promise<FileEntry[]> {
    return getTransport().invoke("list_fs_roots");
  },
  fileOpen(path: string): Promise<void> {
    return getTransport().invoke("file_open", { path });
  },
  showInExplorer(path: string): Promise<void> {
    return getTransport().invoke("show_in_explorer", { path });
  },
  detectRunCommand(cwd: string): Promise<string | null> {
    return getTransport().invoke("detect_run_command", { cwd });
  },
  listRunConfigs(wsKey: string): Promise<RunConfig[]> {
    return getTransport().invoke("list_run_configs", { wsKey });
  },
  saveRunConfigs(wsKey: string, configs: RunConfig[]): Promise<void> {
    return getTransport().invoke("save_run_configs", { wsKey, configs });
  },
  detectRunTargets(cwd: string): Promise<RunTarget[]> {
    return getTransport().invoke("detect_run_targets", { cwd });
  },
  /** size 具名对象：rows/cols 相邻同型不再可错位 */
  // TODO: useRunProcess.ts:73,96 的 (…, dim.rows, dim.cols) 调用点待 B 路同步为 { rows, cols }
  runProcessStart(configId: string, cwd: string, command: string, env: Record<string, string>, size: { rows: number; cols: number }): Promise<string> {
    return getTransport().invoke("run_process_start", { configId, cwd, command, env, rows: size.rows, cols: size.cols });
  },
  runProcessStop(configId: string): Promise<void> {
    return getTransport().invoke("run_process_stop", { configId });
  },
  readFileContent(path: string): Promise<string> {
    return getTransport().invoke("read_file_content", { path });
  },
  readFileBase64(path: string): Promise<string> {
    return getTransport().invoke("read_file_base64", { path });
  },
  readFileBinary(path: string): Promise<ArrayBuffer> {
    return getTransport().invoke("read_file_binary", { path });
  },
  writeFileContent(path: string, content: string): Promise<void> {
    return getTransport().invoke("write_file_content", { path, content });
  },
  // Windows「打开方式」集成
  consumePendingOpenFile(): Promise<string | null> {
    return getTransport().invoke("consume_pending_open_file");
  },
  setOpenWithExtensions(extensions: string[]): Promise<void> {
    return getTransport().invoke("set_open_with_extensions", { extensions });
  },
  registerOpenWith(extensions: string[]): Promise<void> {
    return getTransport().invoke("register_open_with", { extensions });
  },
  unregisterOpenWith(extensions: string[]): Promise<void> {
    return getTransport().invoke("unregister_open_with", { extensions });
  },
  deleteFile(path: string): Promise<void> {
    return getTransport().invoke("delete_file", { path });
  },
  fileExists(path: string): Promise<boolean> {
    return getTransport().invoke("file_exists", { path });
  },
  // 批量探测路径类型（"file"|"dir"|"none"），输入框 @path→mention 芯片转换用
  pathTypes(paths: string[]): Promise<("file" | "dir" | "none")[]> {
    return getTransport().invoke("path_types", { paths });
  },
  findFilesByName(query: string, cwd: string, limit?: number): Promise<string[]> {
    return getTransport().invoke("find_files_by_name", { query, cwd, limit: limit ?? null });
  },
  copyFile(src: string, dest: string): Promise<void> {
    return getTransport().invoke("copy_file", { src, dest });
  },
  moveFile(src: string, dest: string): Promise<void> {
    return getTransport().invoke("move_file", { src, dest });
  },
  createFile(parentPath: string, name: string): Promise<void> {
    return getTransport().invoke("create_file", { parentPath, name });
  },
  createDir(parentPath: string, name: string): Promise<void> {
    return getTransport().invoke("create_dir", { parentPath, name });
  },
  /** 工作区文件系统监听：外部改动经 `file-tree-changed` 事件推送。
   *  空串 = 停止监听；同 root 幂等短路。FileTree loadRoot 成功后调用 */
  fileTreeWatch(root: string): Promise<void> {
    return getTransport().invoke("file_tree_watch", { root });
  },

  // 符号搜索（跳转到定义）
  grepSymbol(word: string, cwd: string, sourceExt?: string): Promise<GrepMatch[]> {
    return getTransport().invoke("grep_symbol", { word, cwd, sourceExt: sourceExt ?? null });
  },

  // 全局搜索 + 替换（Find in Files）
  searchInFiles(query: string, cwd: string, options: SearchOptions): Promise<SearchResponse> {
    return getTransport().invoke("search_in_files", { query, cwd, options });
  },
  replaceInFilesPreview(
    query: string,
    replacement: string,
    cwd: string,
    options: SearchOptions,
  ): Promise<ReplacePreviewResponse> {
    return getTransport().invoke("replace_in_files_preview", { query, replacement, cwd, options });
  },
  applyReplacements(files: ReplaceFileInput[]): Promise<ApplyResult> {
    return getTransport().invoke("apply_replacements", { files });
  },

  // Git（自足的「状态读取」组；写操作调用后需调用方自行刷新状态）
  /**
   * 工作区覆写：会话归属于某个工作区，但主进程的 `WorkspaceState` 是全局单例、
   * 随用户切 tab 改写。任何「按会话」的 git 操作都必须带它，否则会打到用户
   * 当前正看着的那个工作区（变更面板窜数据的根因）。不传 = 当前活动工作区。
   */
  gitDiffFiles(cwd?: string): Promise<DiffEntry[]> {
    return getTransport().invoke("git_diff_files", { cwd: cwd ?? null });
  },
  gitRevertFile(path: string, cwd?: string): Promise<void> {
    return getTransport().invoke("git_revert_file", { path, cwd: cwd ?? null });
  },
  gitBranches(): Promise<BranchInfo[]> {
    return getTransport().invoke("git_branches");
  },
  /** 分页日志；branch null = 当前分支，skip 为已加载条数（翻页）。 */
  gitLog(limit?: number | null, branch?: string | null, skip?: number | null): Promise<CommitEntry[]> {
    return getTransport().invoke("git_log", {
      limit: limit ?? null,
      branch: branch ?? null,
      skip: skip ?? null,
    });
  },
  gitStatus(): Promise<{ entries: GitStatusEntry[] }> {
    return getTransport().invoke("git_status");
  },
  /** 未推送提交 hash 集（前端用 Set 标记「待推送」装饰）。 */
  gitUnpushedCommits(): Promise<string[]> {
    return getTransport().invoke("git_unpushed_commits");
  },
  gitStashList(): Promise<StashEntry[]> {
    return getTransport().invoke("git_stash_list");
  },
  gitAheadBehind(): Promise<AheadBehind> {
    return getTransport().invoke("git_ahead_behind");
  },
  gitTags(): Promise<TagEntry[]> {
    return getTransport().invoke("git_tags");
  },
  /** 分支对比；base null = 后端取当前分支。 */
  gitCompareBranches(head: string, base?: string | null): Promise<CompareResult> {
    return getTransport().invoke("git_compare_branches", { head, base: base ?? null });
  },
  gitShow(hash: string): Promise<CommitDetail> {
    return getTransport().invoke("git_show", { hash });
  },
  gitCheckout(branch: string): Promise<void> {
    return getTransport().invoke("git_checkout", { branch });
  },
  gitCreateBranch(name: string): Promise<void> {
    return getTransport().invoke("git_create_branch", { name });
  },
  gitDeleteBranch(name: string, force?: boolean): Promise<void> {
    return getTransport().invoke("git_delete_branch", { name, force: force ?? false });
  },
  gitStageFile(path: string): Promise<void> {
    return getTransport().invoke("git_stage_file", { path });
  },
  gitUnstageFile(path: string): Promise<void> {
    return getTransport().invoke("git_unstage_file", { path });
  },
  gitStageAll(): Promise<void> {
    return getTransport().invoke("git_stage_all");
  },
  gitUnstageAll(): Promise<void> {
    return getTransport().invoke("git_unstage_all");
  },
  /** 提交；amend = 修订上一次提交。返回新提交 hash。 */
  gitCommit(message: string, amend?: boolean): Promise<string> {
    return getTransport().invoke("git_commit", { message, amend: amend ?? false });
  },
  gitFetch(): Promise<FetchPullOutcome> {
    return getTransport().invoke("git_fetch");
  },
  gitPush(force?: boolean): Promise<void> {
    return getTransport().invoke("git_push", { force: force ?? false });
  },
  gitPull(): Promise<FetchPullOutcome> {
    return getTransport().invoke("git_pull");
  },
  /** stash 推入；message null = git 默认消息。 */
  gitStash(message?: string | null): Promise<void> {
    return getTransport().invoke("git_stash", { message: message ?? null });
  },
  gitStashApply(index: number): Promise<void> {
    return getTransport().invoke("git_stash_apply", { index });
  },
  /** index null = 最新一条（git stash pop 无参语义）。 */
  gitStashPop(index?: number | null): Promise<void> {
    return getTransport().invoke("git_stash_pop", { index: index ?? null });
  },
  gitStashDrop(index: number): Promise<void> {
    return getTransport().invoke("git_stash_drop", { index });
  },
  /** 丢弃全部工作区改动（确认对话框在后端之前由前端负责）。 */
  gitDiscardAll(): Promise<void> {
    return getTransport().invoke("git_discard_all");
  },
  /** 仓库指纹（分支/HEAD/status 摘要 hash）——watcher 轮询判断「有无变化」。 */
  gitFingerprint(): Promise<string> {
    return getTransport().invoke("git_fingerprint");
  },
  /** 远端 URL（origin）；无远端返回 null——更新检查/外链跳转用。 */
  gitRemoteUrl(): Promise<string | null> {
    return getTransport().invoke("git_remote_url");
  },
  /** 行级 diff 双份原文：工作区变更（staged）或历史提交（commitHash），二选一。
   *  未指定的键拍平为 null（Rust Option None）。 */
  gitDiffPair(
    path: string,
    opts?: { staged?: boolean; commitHash?: string; cwd?: string },
  ): Promise<DiffPair> {
    return getTransport().invoke("git_diff_pair", {
      path,
      staged: opts?.staged ?? null,
      commitHash: opts?.commitHash ?? null,
      cwd: opts?.cwd ?? null,
    });
  },
  /** 行级 diff 双份原文：任意两 ref 直比（分支对比视图）。base 必填（对比场景恒有）。 */
  gitDiffPairRefs(path: string, refs: { base: string; head: string }, oldPath?: string): Promise<DiffPair> {
    return getTransport().invoke("git_diff_pair_refs", {
      path,
      base: refs.base,
      head: refs.head,
      oldPath: oldPath ?? null,
    });
  },

  // 应用 / 诊断
  /** 打开 WebView2 devtools；仅 dev/诊断 build 注册了命令，release 静默 reject。 */
  openDevtools(): Promise<void> {
    return getTransport().invoke("open_devtools");
  },
  /** 应用版本号（桌面 = Rust package_info；远端 PWA 不走此方法）。 */
  appVersion(): Promise<string> {
    return getTransport().invoke("get_app_version");
  },
  /** 卡死诊断心跳（500ms 一次；Rust watchdog 断流 ≥2s 判定冻结）。 */
  diagHeartbeat(payload: DiagHeartbeatPayload): Promise<void> {
    return getTransport().invoke("diag_heartbeat", { payload });
  },
  /** 冻结自愈补交：卡死恢复后把期间的 longtask 明细 + 面包屑合并进报告。 */
  diagFreezeSupplement(payload: Record<string, unknown>): Promise<void> {
    return getTransport().invoke("diag_freeze_supplement", { payload });
  },
  /** 滚动诊断环快照落盘；返回报告文件路径。 */
  diagScrollTrail(payload: string): Promise<string> {
    return getTransport().invoke("diag_scroll_trail", { payload });
  },
  /** 前端错误上报（main.ts 全局兜底也用；走 Rust 日志落盘）。 */
  logFrontendError(message: string): Promise<void> {
    return getTransport().invoke("log_frontend_error", { message });
  },

  // 会话
  listSessions(): Promise<Session[]> {
    return getTransport().invoke("list_sessions");
  },
  findSessionsSince(sinceMs: number): Promise<string[]> {
    return getTransport().invoke("find_sessions_since", { sinceMs });
  },
  listSessionsForWorkspace(wsKey: string): Promise<Session[]> {
    return getTransport().invoke("list_sessions_for_workspace", { wsKey });
  },
  loadMessages(
    sessionId: string,
    offsetBytes?: number | null,
    limit?: number | null,
  ): Promise<LoadMessagesResult> {
    return getTransport().invoke("load_messages", {
      sessionId,
      offsetBytes: offsetBytes ?? null,
      limit: limit ?? null,
    });
  },
  createSession(id: string, name: string): Promise<Session> {
    return getTransport().invoke("create_session", { id, name });
  },
  deleteSession(id: string): Promise<void> {
    return getTransport().invoke("delete_session", { id });
  },
  renameSession(id: string, name: string): Promise<void> {
    return getTransport().invoke("rename_session", { id, name });
  },
  /** 自动命名落盘：返回 true = 采用（未被用户手改覆盖）；调用方据此前置更新侧栏。 */
  autoRenameSession(id: string, name: string): Promise<boolean> {
    return getTransport().invoke("auto_rename_session", { id, name });
  },
  sessionLastEvent(sessionId: string): Promise<LastEventInfo> {
    return getTransport().invoke("session_last_event", { sessionId });
  },
  loadSessionChanges(sessionId: string): Promise<ChangeRound[]> {
    return getTransport().invoke("load_session_changes", { sessionId });
  },
  saveSessionChanges(sessionId: string, rounds: ChangeRound[]): Promise<void> {
    return getTransport().invoke("save_session_changes", { sessionId, rounds });
  },
  appendSessionChange(sessionId: string, round: ChangeRound): Promise<void> {
    return getTransport().invoke("append_session_change", { sessionId, round });
  },
  sessionJsonlSize(sessionId: string): Promise<number> {
    return getTransport().invoke("session_jsonl_size", { sessionId });
  },
  truncateSessionJsonl(sessionId: string, bytePos: number): Promise<void> {
    return getTransport().invoke("session_truncate_jsonl", { sessionId, bytePos });
  },

  // 通知（绕过插件 dev 模式限制）。sessionId 供「点击 toast 定位会话」：
  // Windows 侧 toast 激活回调直接携带它 emit open-session-from-notification。
  notifySend(title: string, body: string, sessionId?: string): Promise<void> {
    return getTransport().invoke("notify_send", { title, body, sessionId: sessionId ?? null });
  },
  /** 按 session 反查桌面通知上下文：真实所属工作区根路径 + 会话显示名。
   *  查不到进程内路由（从未 send / 换 key 后未再 send）返回 null，调用方回退。 */
  sessionNotificationInfo(sessionId: string): Promise<{ workspace: string; name: string } | null> {
    return getTransport().invoke("session_notification_info", { sessionId });
  },

  // 通知中心持久化
  loadNotifications(): Promise<NotificationRecord[]> {
    return getTransport().invoke("load_notifications");
  },
  saveNotifications(records: NotificationRecord[]): Promise<void> {
    return getTransport().invoke("save_notifications", { records });
  },

  // 一次性迁移：从用户系统 ~/.claude/ 拷到 Aide 自管理目录
  checkClaudeMigration(): Promise<MigrationStatus> {
    return getTransport().invoke("check_claude_migration");
  },
  migrateClaudeData(): Promise<MigrationSummary> {
    return getTransport().invoke("migrate_claude_data");
  },
  dismissClaudeMigration(): Promise<void> {
    return getTransport().invoke("dismiss_claude_migration");
  },

  // 设置
  getSettings(): Promise<AppSettings> {
    return getTransport().invoke("get_settings");
  },
  /** 探测本机自动可用的代理（不含用户已配置值）；设置面板「网络代理」为空时提示一键填入。 */
  detectAvailableProxy(): Promise<string | null> {
    return getTransport().invoke("detect_available_proxy");
  },
  setSettings(settings: Partial<AppSettings> | { codegraphEmbedder: Record<string, unknown> }): Promise<void> {
    return getTransport().invoke("set_settings", { settings });
  },

  // 远程控制网关
  remoteGetStatus(): Promise<RemoteStatus> {
    return getTransport().invoke("remote_get_status");
  },
  remoteSetEnabled(enabled: boolean): Promise<void> {
    return getTransport().invoke("remote_set_enabled", { enabled });
  },
  remoteRefreshPairingCode(): Promise<string> {
    return getTransport().invoke("remote_refresh_pairing_code");
  },
  remoteRevoke(): Promise<void> {
    return getTransport().invoke("remote_revoke");
  },

  // JDK 注册表（机器级；工作区选哪个走 workspace_get/set_jdk）
  scanJdks(): Promise<JdkEntry[]> {
    return getTransport().invoke("scan_jdks");
  },
  resolveJdk(path: string): Promise<JdkEntry | null> {
    return getTransport().invoke("resolve_jdk", { path });
  },

  // 工作区级 JDK（一个工作区一个 JDK，所有运行配置共享；空 = 系统默认）
  workspaceGetJdk(workspaceRoot: string): Promise<string> {
    return getTransport().invoke("workspace_get_jdk", { workspaceRoot });
  },
  workspaceSetJdk(workspaceRoot: string, jdkHome: string): Promise<void> {
    return getTransport().invoke("workspace_set_jdk", { workspaceRoot, jdkHome });
  },

  // 供应商
  getProviders(): Promise<ProviderConfig[]> {
    return getTransport().invoke("get_providers");
  },
  setProviders(providers: ProviderConfigInput[]): Promise<void> {
    return getTransport().invoke("set_providers", { providers });
  },
  getActiveProviderId(): Promise<string> {
    return getTransport().invoke("get_active_provider_id");
  },
  setActiveProviderId(providerId: string): Promise<void> {
    return getTransport().invoke("set_active_provider_id", { providerId });
  },
  getProviderCatalog(): Promise<CatalogPreset[]> {
    return getTransport().invoke("get_provider_catalog");
  },
  testProviderConnection(providerId: string): Promise<ConnectionStatus> {
    return getTransport().invoke("test_provider_connection", { providerId });
  },
  cpaProbePort(): Promise<PortProbeResult> {
    return getTransport().invoke("cpa_probe_port");
  },
  cpaOpenManagement(): Promise<string> {
    return getTransport().invoke("cpa_open_management");
  },
  cpaLoginStatus(): Promise<LoginStatusResult> {
    return getTransport().invoke("cpa_login_status");
  },
  viewAnthropicQuota(): Promise<unknown> {
    return getTransport().invoke("view_anthropic_quota");
  },
  refreshModels(providerId: string): Promise<ProviderModelMappings> {
    return getTransport().invoke("refresh_models", { providerId });
  },
  /** ~/.aide/claude/.credentials.json 是否存在（claude.exe OAuth 登录后写入）。 */
  claudeCredentialsExist(): Promise<boolean> {
    return getTransport().invoke("claude_credentials_exist");
  },
  /** 启动 Claude OAuth 登录。返回授权 URL（A2 成功）或 degraded=true（降级到 API key）。OAuth 未接入前恒返回 degraded。 */
  claudeStartLogin(): Promise<{ authorizeUrl: string | null; degraded: boolean }> {
    return getTransport().invoke("claude_start_login");
  },

  // 工作区
  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return getTransport().invoke("list_workspaces");
  },
  /** 桌面当前活动工作区（key = 编码键，与 listWorkspaces 同源；path = 解码路径）；null = 未设置。远程只读——活动工作区由桌面独占管理。 */
  getActiveWorkspace(): Promise<{ key: string; path: string } | null> {
    return getTransport().invoke("get_active_workspace");
  },
  setWorkspace(key: string, path: string): Promise<void> {
    return getTransport().invoke("set_workspace", { key, path });
  },
  createWorkspace(path: string): Promise<WorkspaceInfo> {
    return getTransport().invoke("create_workspace", { path });
  },
  removeWorkspace(key: string, mode: "hide" | "delete"): Promise<void> {
    return getTransport().invoke("remove_workspace", { key, mode });
  },
  unhideWorkspace(key: string): Promise<void> {
    return getTransport().invoke("unhide_workspace", { key });
  },

  // 最近访问
  /** input 具名对象：4 个相邻 string 不再可错位 */
  // TODO: useRecent.ts:40 的 (key, wsName, sessionId, name) 调用点待 B 路同步为对象
  recordRecentSession(input: { wsKey: string; wsName: string; sessionId: string; name: string }): Promise<void> {
    return getTransport().invoke("record_recent_session", input);
  },
  recordRecentFile(wsKey: string, path: string, name: string): Promise<void> {
    return getTransport().invoke("record_recent_file", { wsKey, path, name });
  },
  listRecent(wsKey: string): Promise<RecentView> {
    return getTransport().invoke("list_recent", { wsKey });
  },
  removeRecentSession(sessionId: string): Promise<void> {
    return getTransport().invoke("remove_recent_session", { sessionId });
  },
  clearRecent(category?: "sessions" | "files"): Promise<void> {
    return getTransport().invoke("clear_recent", { category: category ?? null });
  },

  // CodeGraph — enhanced code navigation
  /** opts.force=true 全量重建（跳过增量快速路径）；默认增量。裸 bool 具名化。 */
  // TODO: useCodeGraphProgress.ts:280 的 (root, true) 调用点待 B 路同步为 { force: true }
  codegraphBuildIndex(projectRoot: string, opts: { force?: boolean } = {}): Promise<BuildIndexResult> {
    return getTransport().invoke("codegraph_build_index", { projectRoot, force: opts.force ?? false });
  },
  codegraphGotoDefinition(
    word: string,
    file: string,
    line: number,
    column: number,
    projectRoot: string,
  ): Promise<QueryResult[]> {
    return getTransport().invoke("codegraph_goto_definition", { word, file, line, column, projectRoot });
  },
  codegraphClose(projectRoot: string): Promise<void> {
    return getTransport().invoke("codegraph_close", { projectRoot });
  },
  codegraphReindexFile(
    projectRoot: string,
    file: string,
  ): Promise<{ reindexed: boolean; skipped?: string } | undefined> {
    return getTransport().invoke("codegraph_reindex_file", { projectRoot, file });
  },
  /** 增量重扫：只 reindex mtime > indexed_at 的文件（手动「更新索引」）。 */
  codegraphRescan(projectRoot: string): Promise<RescanResult> {
    return getTransport().invoke("codegraph_rescan", { projectRoot });
  },
  /** 粗粒度构建进度（纯原子读，同步 inline 命令）。前端定时 poll。 */
  codegraphBuildProgress(): Promise<BuildProgress> {
    return getTransport().invoke("codegraph_build_progress");
  },

  // ── LSP ──

  lspDetectLanguages(workspaceRoot: string): Promise<string[]> {
    return getTransport().invoke("lsp_detect_languages", { workspaceRoot });
  },
  lspEnsureServer(workspaceRoot: string, lang: string): Promise<{ ok: boolean; ready: boolean; kind?: string; error?: string }> {
    return getTransport().invoke("lsp_ensure_server", { workspaceRoot, lang });
  },
  lspDidOpen(workspaceRoot: string, filePath: string, lang: string, text: string): Promise<void> {
    return getTransport().invoke("lsp_did_open", { workspaceRoot, filePath, lang, text });
  },
  lspDidChange(workspaceRoot: string, filePath: string, lang: string, text: string, version?: number): Promise<void> {
    return getTransport().invoke("lsp_did_change", { workspaceRoot, filePath, lang, text, version });
  },
  lspDidClose(workspaceRoot: string, filePath: string, lang: string): Promise<void> {
    return getTransport().invoke("lsp_did_close", { workspaceRoot, filePath, lang });
  },
  lspDefinition(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<LspJumpResult> {
    return getTransport().invoke("lsp_definition", { workspaceRoot, filePath, line, column, word });
  },
  /** 查引用（语言无关，按扩展名分派）：符号 → 全部使用点。status 语义与 lspDefinition 一致。 */
  lspReferences(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<LspJumpResult> {
    return getTransport().invoke("lsp_references", { workspaceRoot, filePath, line, column, word });
  },
  /** 查调用层级（语言无关，按扩展名分派）：prepareCallHierarchy → incoming/outgoing 展开
   *  一层。root=null 表示该位置不是可调用符号；树的更深层由前端递归调用（查询点=子节点
   *  声明位置）。 */
  lspCallHierarchy(workspaceRoot: string, filePath: string, line: number, column: number, direction: CallHierarchyDirection): Promise<CallHierarchyResult> {
    return getTransport().invoke("lsp_call_hierarchy", { workspaceRoot, filePath, line, column, direction });
  },
  lspCompletion(workspaceRoot: string, filePath: string, line: number, column: number): Promise<CmCompletion[]> {
    return getTransport().invoke("lsp_completion", { workspaceRoot, filePath, line, column });
  },
  /** 选中补全条目时回传原始 item，取回完整 detail/documentation（语言无关）。 */
  lspCompletionResolve(workspaceRoot: string, filePath: string, item: unknown): Promise<{ detail: string | null; documentation: string | null }> {
    return getTransport().invoke("lsp_completion_resolve", { workspaceRoot, filePath, item });
  },
  /** 方法调用参数提示（语言无关）。无结果/未就绪返回 null。 */
  lspSignatureHelp(workspaceRoot: string, filePath: string, line: number, column: number): Promise<SignatureHelpResult | null> {
    return getTransport().invoke("lsp_signature_help", { workspaceRoot, filePath, line, column });
  },
  /** 语义着色 token 全量（语言无关，按扩展名分派）。空数组=无结果/未就绪，前端清空装饰。 */
  lspSemanticTokens(workspaceRoot: string, filePath: string): Promise<SemanticToken[]> {
    return getTransport().invoke("lsp_semantic_tokens", { workspaceRoot, filePath });
  },
  /** 查 inlay hints（语言无关，按扩展名分派）：参数名/类型提示。fromLine/toLine 为可视区
   *  行范围（1-based 含头含尾）。空数组=无结果/未就绪，前端清空装饰（同 semanticTokens）。 */
  lspInlayHints(workspaceRoot: string, filePath: string, fromLine: number, toLine: number): Promise<InlayHintItem[]> {
    return getTransport().invoke("lsp_inlay_hints", { workspaceRoot, filePath, fromLine, toLine });
  },
  /** 保存通知：触发 server（如 jdtls）的编译级诊断刷新（语言无关，按扩展名分派）。 */
  lspDidSave(workspaceRoot: string, filePath: string): Promise<void> {
    return getTransport().invoke("lsp_did_save", { workspaceRoot, filePath });
  },
  lspHover(workspaceRoot: string, filePath: string, line: number, column: number): Promise<{ content: string | null }> {
    return getTransport().invoke("lsp_hover", { workspaceRoot, filePath, line, column });
  },
  lspImplementation(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<QueryResult[]> {
    return getTransport().invoke("lsp_implementation", { workspaceRoot, filePath, line, column, word });
  },
  lspDocumentSymbol(workspaceRoot: string, filePath: string): Promise<DocumentSymbolItem[]> {
    return getTransport().invoke("lsp_document_symbol", { workspaceRoot, filePath });
  },
  lspCapabilities(workspaceRoot: string, lang: string): Promise<LspCapabilities> {
    return getTransport().invoke("lsp_capabilities", { workspaceRoot, lang });
  },
  lspShutdownWorkspace(workspaceRoot: string): Promise<void> {
    return getTransport().invoke("lsp_shutdown_workspace", { workspaceRoot });
  },
  openLspInstallGuide(): Promise<void> {
    return getTransport().invoke("open_lsp_install_guide");
  },
  workspaceSetLspEnabled(workspaceRoot: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("workspace_set_lsp_enabled", { workspaceRoot, enabled });
  },
  workspaceSetLspExcludes(workspaceRoot: string, dirs: string[]): Promise<void> {
    return getTransport().invoke("workspace_set_lsp_excludes", { workspaceRoot, dirs });
  },
  workspaceGetLspExcludes(workspaceRoot: string): Promise<string[]> {
    return getTransport().invoke("workspace_get_lsp_excludes", { workspaceRoot });
  },

  // 工作区信任（Trusted Workspace）— 路径入参，Rust 内部点号归一。
  isWorkspaceTrusted(path: string): Promise<boolean> {
    return getTransport().invoke("is_workspace_trusted", { path });
  },
  /** 信任工作区：返回自动写入的安全命令规则条数（幂等，已存在则 0）。 */
  trustWorkspace(path: string): Promise<number> {
    return getTransport().invoke("trust_workspace", { path });
  },
  /** 取消信任：返回移除的自动安全规则条数。 */
  untrustWorkspace(path: string): Promise<number> {
    return getTransport().invoke("untrust_workspace", { path });
  },
  /** 读某工作区的代码索引开关（每工作区默认关，后端权威）。 */
  isWorkspaceCodegraphEnabled(path: string): Promise<boolean> {
    return getTransport().invoke("workspace_get_codegraph_enabled", { workspaceRoot: path });
  },
  /** 设某工作区的代码索引开关（每工作区默认关；信任把关在建索引门，不在写开关处）。 */
  setWorkspaceCodegraphEnabled(path: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("workspace_set_codegraph_enabled", {
      workspaceRoot: path,
      enabled,
    });
  },

  /**
   * 把知识库凭据镜像给 Rust（→ `~/.aide/` 下的凭据文件，名称随构建档位：
   * dev = `knowledge.dev.json`、release = `knowledge.json` → sidecar 的 aide-knowledge
   * 内置工具每次调用现读）。**桌面专属能力**：remote-pwa 没有知识库面板，也不进
   * remote REGISTRY（REGISTRY 只白名单入站 invoke，桌面走 TauriTransport 直达命令）。
   * `token: null` = 登出（Rust 删文件）。
   */
  setKnowledgeRuntimeConfig(input: { baseUrl: string; token: string | null }): Promise<void> {
    return getTransport().invoke("knowledge_set_runtime_config", {
      baseUrl: input.baseUrl,
      token: input.token,
    });
  },
};

export { permissionsApi } from "./api/permissions";
export { memoryObservatoryApi, CLAUDE_MD_ALIAS } from "./api/memoryObservatory";
export type {
  MemoryIndexEntry,
  MemoryIndexInfo,
  MemoryTopic,
  ClaudeMdInfo,
  MemoryLimits,
  MemoryScanResult,
  MemorySnapshotDiff,
  MemoryDeleteResult,
  MemoryEvent,
  MemoryEventsResult,
  ProjectScanResult,
  MemoryScanAllResult,
} from "./api/memoryObservatory";

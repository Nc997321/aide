# 同步命令 async 化细则与 trace_command 档案

> 从 CLAUDE.md 拆出（2026-09-10）。核心规则仍在 CLAUDE.md「关键约定」，此处存细节与历史档案。

## 背景：为什么同步命令是主线程杀手

Tauri 非 async command 跑在主线程上，遍历/大文件读取/大对象序列化/等子进程都会把窗口卡成「未响应」。
这类命令一律 `async fn` + `spawn_blocking`。

## 判读方法

- `aide.exe` 首帧 100% CPU + `pending` 单调涨 = CPU 烧后转 IO 堵的**两段式**同步命令；
- 全程低 CPU = 纯 IO 同步命令。

## async 化的两个坑

1. 命令带 `State<'_, T>` 等引用参数时，Tauri v2 强制 async 命令返回 `Result<_, _>`
   （编译错误 E0277 `async commands that contain references as inputs must return a Result`）
   ——`scan_plugin_skills` 因此保留 `Result<Vec,_>`；纯 owned 参数的 async 命令可返回裸类型。
2. `State<T>` 不能跨 `spawn_blocking`：须把 state 注册成 `Arc<T>`
   （`lib.rs` `.manage(Arc::new(...))`），命令里 `let x = state.inner().clone();`
   （Arc clone，owned Send）再 move 进闭包。

## 已改 async 的命令清单（重 IO/CPU 全员，截至 2026-07）

`grep_symbol`、`find_files_by_name`、`git_has_file`、`git_log/show/diff_*/status/branches/...`（git 命令全 async）、
`load_messages`、`list_sessions`、`session_last_event`、`session_jsonl_size`、`session_truncate_jsonl`、
`list_sessions_for_workspace`、`load_session_changes`、`save_session_changes`、`read_file_content`、
`read_file_base64`、`read_file_binary`、`write_file_content`、`delete_file`、`copy_file`、`move_file`、
`list_directory`、`detect_run_command`、`detect_run_targets`、`scan_plugin_skills`。

## 2026-07-08 黑匣子两轮真实冻结（事故档案）

1. `session_jsonl_size`：目录遍历 IO，堵主线程 30s+，纯 IO 低 CPU。
2. `save_session_changes`：每轮 Claude 回完 `useConversationChanges.captureChanges → save`
   都把累积的全部 `rounds` 整份 `serde_json::to_string_pretty` 落盘，序列化 CPU 满核、
   `fs::write` 是 IO（杀软扫描/磁盘争抢可拖到 27s）。报告特征：首帧 `aide.exe` 100% CPU
   然后 CPU 掉但主线程仍堵（CPU→IO 两段式）。

两轮后地毯式加固：剩余所有高危/中危同步命令（文件读写/复制/删除/列目录/run-target 检测/skills 扫描）全改 async。

## trace_command 已埋清单（52 条）

- 早期 3 条：`fetch_marketplace` / `install_plugin` / `git_fingerprint`
- 2026-07-08 地毯式加固新增 49 条：全部 customizations / recent / settings / provider / file_assoc /
  file_open / show_in_explorer / get_project_info / pty_spawn_shell / run_process_start / stop / clipboard_*

不埋的（极轻纯内存命令，埋了是噪音）：`file_exists` / `create_file` / `pty_write` / `poll_pty_output` /
`rename_sidecar_session` / `get_default_*` 等。

## 新增同步命令的决策

重 IO/CPU/spawn → 改 async；轻 → 不动；介于之间且保留同步 → 埋 trace_command。
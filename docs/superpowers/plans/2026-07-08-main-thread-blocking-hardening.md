# 主线程阻塞加固 — 实现计划

> 目标：消除偶发「未响应」的根因类——同步 command 在 Tauri 主线程上做重 IO/CPU。
> 2026-07-08 两轮真实冻结实锤两条（`session_jsonl_size` / `save_session_changes`），
> 本计划把剩余所有高危/中危同步命令改成 async + spawn_blocking，并给保留同步的
> 低危命令加 `trace_command` 兜底，确保下次任何同步命令卡死报告都能点名。

Branch: master（直接改，沿用本仓库既定模式，跳过 worktree——用户 CLAUDE.md 要求）
Branch base: b71a448
Started: 2026-07-08

## 全局约束（Global Constraints）

1. **async 改造模式（逐字遵循）**：
   ```rust
   #[tauri::command]
   pub async fn xxx(path: String, ...) -> Result<T, String> {
       tokio::task::spawn_blocking(move || xxx_blocking(path, ...))
           .await
           .map_err(|e| format!("xxx task panicked: {}", e))?
   }
   fn xxx_blocking(path: String, ...) -> Result<T, String> {
       // 原函数体原样搬入
   }
   ```
   参考已落地范例：`session.rs` 的 `session_jsonl_size` / `list_sessions`；`filesystem.rs`
   已改的 `list_directory` / `read_file_content` / `read_file_base64`（本任务工作树已有）。

2. **前端零改动**：Tauri `invoke` 对 sync/async 命令都返回 Promise，前端早已 `await`。
   不改 `src/api.ts`、不改任何 `.vue`/`.ts` 前端文件。

3. **`trace_command` 只埋给保留同步的命令**：async 命令的 spawn_blocking 任务不在主线程，
   guard 在 dispatch 后立刻 drop，埋了也抓不到——**禁止给已改 async 的命令埋点**。
   埋点形式：命令函数体第一行 `let _g = crate::diagnostics::trace_command("name");`，
   在任何 IO / spawn / 外部调用之前。

4. **不碰无关工作区改动**：`src-tauri/Cargo.toml`（仅 CRLF 警告）、
   `docs/discussions/2026-07-07-lsp-alternative-*.md`（历史遗留）与本计划无关，
   每个 task 只 `git add` 自己改的文件。

5. **Windows 子进程仍需 `CREATE_NO_WINDOW (0x08000000)`**：未改 spawn 逻辑，不涉及。

6. **验证**：每个 task 后 `cargo check`（无警告）+ `cargo test --lib`（全绿，已知 LNK1104
   杀软锁偶发，重试即可）。前端无改动，不跑 vitest。

## Task 1：filesystem.rs + run_configs.rs 高危/中危命令改 async

工作树已有 3 条改好（`list_directory` / `read_file_content` / `read_file_base64`，作为范例）。
**剩余要改**（全部纯 path/cwd 参数，不依赖 State，直接 spawn_blocking）：

- `filesystem.rs`：
  - `read_file_binary` → 返回 `tauri::ipc::Response`。需确认 `ipc::Response: Send`（包装
    `Vec<u8>`，应 Send；若 spawn_blocking 返回它报错，把字节读成 `Vec<u8>` 在 blocking 里返回，
    再在外层构造 `ipc::Response`——但优先直接返回，确认 Send 即可）。
  - `write_file_content(path, content)`
  - `delete_file(path)`（含 `remove_dir_all` 递归）
  - `copy_file(src, dest)`（含 `copy_dir_recursive`）
  - `move_file(src, dest)`（含跨盘复制后删源）
  - `detect_run_command(cwd)`（调 `detectors::detect_command_for_path`，纯函数）
- `run_configs.rs`：
  - `detect_run_targets(cwd)`（调 `detectors::detect_run_targets`，含 `SubdirScanDetector`
    递归遍历整工作区 + 18 探测器，重 IO）

`copy_dir_recursive` / `extract_*` 等私有辅助函数保持原样，只是被 blocking 函数调用。
`detect_run_command` / `detect_run_targets` 的 blocking 体直接 `Ok(detect_targets(Path::new(&cwd)))`。

不改：`get_project_info`（读 `.git/HEAD` 极轻，归 Task 3 埋点）、`file_open`/`show_in_explorer`
（spawn 后返回，归 Task 3 埋点）、`file_exists`/`create_file`/`create_dir`（极轻不埋）。

## Task 2：scan_plugin_skills 改 async（Arc<SkillRegistry> 改造）

`scan_plugin_skills`（`shell.rs`）用 `State<SkillRegistry>`，State 不能跨 spawn_blocking。
方案：把 `SkillRegistry` 注册成 `Arc<SkillRegistry>`：
- `lib.rs`：`.manage(skills::SkillRegistry::new())` → `.manage(std::sync::Arc::new(skills::SkillRegistry::new()))`
- `shell.rs` `scan_plugin_skills` 签名 `registry: State<'_, Arc<SkillRegistry>>`，body：
  `let reg = registry.inner().clone();`（Arc clone，owned），`spawn_blocking(move || reg.list(provider.as_deref(), path))`。
- `SkillProvider: Send + Sync`，`Arc<SkillRegistry>` Send ✓。
- 注意 `scan_plugin_skills` 当前返回 `Vec<SkillMeta>`（无 Result），保持返回类型；spawn_blocking
  返回 `Vec<SkillMeta>`，`.await.map_err(...)` 后 `.unwrap_or_default()` 或改返回 `Result<Vec, String>`——
  优先保持现有签名形状（当前无 Result，panic 时 Tauri 自己处理），用 `spawn_blocking(...).await.unwrap_or_default()`。

## Task 3：低危同步命令加 trace_command 兜底

给以下「保留同步、但做 IO/子进程/外部调用」的命令加 `let _g = crate::diagnostics::trace_command("name");`：
- `filesystem.rs`：`get_project_info`、`file_open`、`show_in_explorer`
- `shell.rs`：`pty_spawn_shell`、`scan_plugin_skills`（Task 2 已改 async，则不埋——见约束3）
- `run_process.rs`：`run_process_start`、`run_process_stop`
- `clipboard.rs`：`clipboard_read_files`、`clipboard_read_image`
- `customizations.rs`：所有做文件 IO 的（list_agents/list_skills/get_agent/get_skill/
  create_*/update_*/delete_*/toggle_*/get_global_instructions/save_global_instructions/
  get_project_instructions/save_project_instructions/list_hooks/create_hook/update_hook/
  delete_hook/toggle_hook/list_mcp_servers/create_mcp_server/update_mcp_server/
  delete_mcp_server/toggle_mcp_server）
- `recent.rs`：record_recent_session/record_recent_file/list_recent/remove_recent_session/clear_recent
- `settings.rs`：get_settings/set_settings/notify_send（notify-rust 可能阻塞）
- `provider.rs`：get_providers/set_providers/get_active_provider_id/set_active_provider_id
- `file_assoc.rs`：register_open_with/unregister_open_with/set_open_with_extensions（写注册表）

**不埋**（极轻纯内存或读小静态文件、埋了是噪音）：`file_exists`/`create_file`/`create_dir`/
`pty_write`/`pty_resize`/`pty_kill`/`poll_pty_output`/`consume_pending_open_file`/
`rename_sidecar_session`/`get_default_models`/`get_default_permission_modes`。
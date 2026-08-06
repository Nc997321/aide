# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Agent SDK 提供带会话管理和文件树的 Chat 桌面壳（Node.js sidecar 驱动对话，不再是 xterm 套壳终端）。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2 (Rust 后端 + WebView 前端) |
| 前端 | Vue 3 + Composition API + TypeScript |
| 终端 | xterm.js 5.x + xterm-addon-fit |
| 代码高亮 | highlight.js 11.x（仅打包 12 种语言） |
| Markdown 渲染 | marked 18.x（文件查看器 .md 预览） |
| 样式 | Tailwind CSS 3 + 双暗色主题（warm-dark 默认 / catppuccin），全项目三角箭头统一 `font-size: 14px` |
| 包管理 | pnpm |
| Rust 编译 | MSVC 工具链（VS Build Tools 2022） |

## 架构红线：跨平台

当前主力平台是 Windows，但所有新代码必须兼容 macOS/Linux——路径拼接用 `PathBuf`/`path.join`（不硬编码 `\\`）、平台特有逻辑（如 `creation_flags`）必须 `#[cfg(windows)]` 隔离、shell 脚本 dev.ps1 / dev.sh 保持功能对等。

## ⚠️ Windows 必读坑点：`CREATE_NO_WINDOW`

**所有 `Command::new("git")`（或任何 CLI 工具）必须加 `CREATE_NO_WINDOW (0x08000000)` 标志**，否则 Windows 会为每个子进程弹出一个控制台窗口，在 release build 中表现为大量错误弹窗。

```rust
#[cfg(windows)]
use std::os::windows::process::CommandExt;

let mut cmd = Command::new("git");
cmd.args(…);
#[cfg(windows)]
{ cmd.creation_flags(0x08000000); }  // 必须有！
```

涉及文件：`git.rs`、`marketplace.rs`、`filesystem.rs`、以及未来任何 spawn 外部进程的代码。

## ⚠️ Windows 必读坑点：`resource_dir()` 的 `\\?\` verbatim 路径

**Tauri `app.path().resource_dir()` 在 Windows 上返回带 `\\?\` 前缀的 verbatim（扩展长度）路径。凡是要把这种路径当入口脚本 / 可执行文件传给外部进程（尤其 `node`），传出前必须 `dunce::simplified()` 剥掉前缀**，否则 node 的 `realpathSync` 处理不了 `\\?\`，会在 `run_main` 引导阶段一路退化到 `lstat 'C:'` → `EISDIR` 崩溃。

典型现象：`pnpm tauri dev` 一切正常（dev 走 `CARGO_MANIFEST_DIR` 普通路径），**打包后一发消息就"会话进程已退出"**（release 才走 `resource_dir()`）。崩的是 runtime 进程引导，不是 claude.exe。

```rust
let path = resource_dir.join("agent-runtime").join("aide-agent.exe");
// ✗ cmd.arg(&path)                              // \\?\C:\... → 子进程引导崩
// ✓ cmd.arg(dunce::simplified(&path))           // C:\... 正常
cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&claude_exe)); // SDK 会 spawn 它，同样要剥
```

只用 Rust `fs::read_to_string` 读的资源路径不受影响（std 能吃 `\\?\`）——只有**传给外部进程**的才要剥。涉及文件：`runtime.rs`（`resolve_runtime_path`、`AIDE_CLAUDE_EXE`）、以及未来任何把资源路径交给子进程的代码。复现：把 `\\?\` 前缀路径当入口传给子进程必崩，去掉前缀正常。

## 关键约定

- **同步 command 禁止重 IO / 重 CPU**：Tauri 非 async command 跑在主线程上，遍历/大文件读取/大对象序列化/等子进程都会把窗口卡成「未响应」——这类命令一律 `async fn` + `spawn_blocking`。已改 async 的命令（重 IO/CPU 全员）：`grep_symbol`、`find_files_by_name`、`git_has_file`、`git_log/show/diff_*/status/branches/...`（git 命令全 async）、`load_messages`、`list_sessions`、`session_last_event`、`session_jsonl_size`、`session_truncate_jsonl`、`list_sessions_for_workspace`、`load_session_changes`、`save_session_changes`、`read_file_content`、`read_file_base64`、`read_file_binary`、`write_file_content`、`delete_file`、`copy_file`、`move_file`、`list_directory`、`detect_run_command`、`detect_run_targets`、`scan_plugin_skills`。判读：`aide.exe` 首帧 100% CPU + `pending` 单调涨 = CPU 烧后转 IO 堵的两段式同步命令；全程低 CPU = 纯 IO 同步命令。**async 化的两个坑**：(1) 命令带 `State<'_, T>` 等引用参数时，Tauri v2 强制 async 命令返回 `Result<_, _>`（编译错误 E0277 `async commands that contain references as inputs must return a Result`）——`scan_plugin_skills` 因此保留 `Result<Vec,_>`；纯 owned 参数的 async 命令可返回裸类型。(2) `State<T>` 不能跨 `spawn_blocking`，须把 state 注册成 `Arc<T>`（`lib.rs` `.manage(Arc::new(...))`），命令里 `let x = state.inner().clone();`（Arc clone，owned Send）再 move 进闭包。2026-07-08 黑匣子两轮真实冻结实锤两条漏网之鱼：首次 `session_jsonl_size`（目录遍历 IO，堵主线程 30s+，纯 IO 低 CPU）；第二次 `save_session_changes`——每轮 Claude 回完 `useConversationChanges.captureChanges → save` 都把累积的全部 `rounds` 整份 `serde_json::to_string_pretty` 落盘，序列化 CPU 满核、`fs::write` 是 IO（杀软扫描/磁盘争抢可拖到 27s），报告特征首帧 `aide.exe` 100% CPU 然后 CPU 掉但主线程仍堵（CPU→IO 两段式）。两轮后做了一次地毯式加固：剩余所有高危/中危同步命令（文件读写/复制/删除/列目录/run-target 检测/skills 扫描）全改 async 消灭主线程阻塞这一类。
- **`trace_command` 兜底**：保留同步、但做 IO/子进程/外部调用的命令埋 `diagnostics::trace_command()`，冻结时报告直接点名卡在哪条命令、跑了多久（`mainThread.stuckCommand`/`stuckForMs`）。形式：命令体第一行 `let _trace = crate::diagnostics::trace_command("函数名");`，在任何 IO/spawn 之前（带 `#[cfg]` 平台分支的命令要放在 cfg 块之前）。**只对同步命令有意义**——async 命令的 spawn_blocking 任务不在主线程，guard 在 dispatch 后立刻 drop，埋了也抓不到（禁止给 async 命令埋）。已埋 52 条（早期 3 条 `fetch_marketplace`/`install_plugin`/`git_fingerprint` + 2026-07-08 地毯式加固新增 49 条：全部 customizations/recent/settings/provider/file_assoc/file_open/show_in_explorer/get_project_info/pty_spawn_shell/run_process_start/stop/clipboard_*）。极轻纯内存命令（`file_exists`/`create_file`/`pty_write`/`poll_pty_output`/`rename_sidecar_session`/`get_default_*` 等）不埋（埋了是噪音）。新增同步命令时评估是否做重 IO/CPU/spawn——重则改 async，轻则不动，介于之间且保留同步的则埋 trace_command。
- **主题系统是配色的唯一来源（多主题必须可切换）**：配色一律走 `src/themes/` 的语义 token——`tokens.ts` 定义 `ThemeTokens`（bg / surface / text / accent / success|warning|danger|info / border / shadow / radius / space / **colorScheme** 约 26 个槽位），`warm-dark.ts`（默认）与 `catppuccin.ts` 各实现一份；`apply.ts` 把每个 token 写成 `:root` 上的 `--aide-<kebab>` CSS 变量（camelCase→kebab，如 `bgDeep`→`--aide-bg-deep`），`App.vue` 启动按 `settings.theme` `applyTheme`、`SettingsPanel.vue` 切换时即时 `applyTheme`。**`colorScheme` 是例外**：不是 `--aide-*` 变量而是浏览器原生 `color-scheme` 属性，`apply.ts` 对它特判直接 `root.style.setProperty("color-scheme", value)`，决定原生表单控件（复选框/未主题化 input）按 light/dark 渲染；暗色 `"dark"`、亮色 `"light"`。`global.css :root` 另留 `color-scheme: dark` 作首屏兜底。加亮色主题只需新主题文件给 `colorScheme: "light"`，其余不用动。**硬性规则：所有颜色/背景/边框/阴影/圆角/间距必须用 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空、不定义任何颜色工具类（曾有的一套 Catppuccin 字面量已移除），需要新语义色就往 `ThemeTokens` 加槽位并在每个主题文件给值。** 新增主题＝新增一个实现 `ThemeTokens` 的文件 + 在 `themes/index.ts` 的 `themes` 注册表加 key。**主题开发封闭契约（主题=纯 token 文件、组件清单封闭、不允许主题私自新增/魔改组件、质感槽位表、玻璃后门配方、验收清单）见 [docs/reference/theme-development.md](docs/reference/theme-development.md)。
- **内置 LSP（默认关，工作区级开关）**：`src-tauri/src/lsp/` 自写薄 JSON-RPC 派发器（Content-Length 帧解析 `transport.rs` + 派发 `rpc.rs`）+ `lsp-types` 类型库；复用 runtime stdio 泵范式、codegraph `QueryResult`、cmCtrlHover 三层 CM 扩展范式、`ALWAYS_IGNORE_DIRS`（共享 `src-tauri/src/ignore_dirs.rs`）。基于探测器检测语言自动选 server。**注意：v1 未捆绑任何 server**——registry 预留 Bundled 机制（二进制放 `resource_dir/lsp/<lang>/` 即生效），但 tauri.conf.json 的 bundle.resources 无 lsp 条目、打包未落地，实际全部走 PATH 发现 + 设置覆盖（没装的 server 弹 "LSP server not found" toast，功能降级 codegraph/grep）。Java 走 PATH 发现 jdtls——jdtls 默认即 stdio 不认 `--stdio`，registry 对 Java 特判不注入、自动补 `-data <app_data_dir/lsp/jdtls-workspace/<工作区id>>`（必须在工作区外——data 目录在工作区内会让 jdtls 拒导项目、报「overlaps the workspace location」→ 定义/补全全空；同时防 Eclipse 元数据污染用户工作区）。各语言 server 安装指引见 `docs/lsp-manual-test-checklist.md`。按文件懒启动，`(workspace,lang)` 一对 scoped，关区即杀。设计 `docs/superpowers/specs/2026-08-04-lsp-builtin-design.md`，实施计划 `docs/superpowers/plans/2026-08-04-lsp-builtin.md`。
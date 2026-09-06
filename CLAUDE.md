# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Agent SDK 提供带会话管理和文件树的 Chat 桌面客户端（Node.js sidecar 驱动对话，不再是 xterm 套壳终端）。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2 (Rust 后端 + WebView 前端) |
| 前端 | Vue 3 + Composition API + TypeScript |
| 终端 | xterm.js 5.x + xterm-addon-fit |
| 代码高亮 | highlight.js 11.x（仅打包 15 种语言，含 properties/ini；编辑器侧 yaml/properties 走 @codemirror/legacy-modes + StreamLanguage） |
| Markdown 渲染 | marked 18.x（文件查看器 .md 预览） |
| 样式 | Tailwind CSS 3 + 多主题（glass 默认 / warm-dark / catppuccin / smoky-pink-glass），全项目三角箭头统一 `font-size: 14px` |
| 包管理 | pnpm（workspace：`packages/*` + `remote-pwa`；agent-sidecar 刻意不进 workspace：依赖在子目录独立 pnpm 安装，构建脚本经 `npm --prefix` 执行绕 pnpm stub） |
| Rust 编译 | MSVC 工具链（VS Build Tools 2022） |
| 共享 SDK | `packages/aide-sdk`（@aide/sdk）：types + api 门面 + transport + useChatSession 闭包，桌面与 remote-pwa 共用；TS 源码直出无构建链，改即生效 |
| 鸿蒙端 | ArkTS（`ohos/`，脚手架已建）：WS 客户端连 relay-server，远程协议 v2 的第三个前端；不进 pnpm workspace（ohpm/hvigor 独立），产物由 `ohos/.gitignore` 自治；SDK 走过筛副本（Vue-free 子集）+ 同步脚本，**改协议需三端同步**（remote.rs ↔ remote.ts ↔ ohos） |

## @aide/sdk：能力单一事实源

桌面（Tauri IPC）与 remote-pwa（WS 远程）共用同一套能力实现，**禁止再开第二份平行实现**：

- **传输层** `AideTransport { invoke, listen }`（`packages/aide-sdk/src/transport.ts`）：桌面默认 TauriTransport（直转 `@tauri-apps/api`），远端 `main.ts` 早期 `setTransport(new RemoteTransport(...))`。api 门面与闭包永远只调 `getTransport()`，**禁止在共享代码里直接 import `@tauri-apps/*`**。
- **api 门面**（`api.ts` + `api/*`）：所有命令调用的唯一入口；闭包需要的命令必须收进门面（含 DTO 对象化），不写散 invoke。
- **远程协议 v2**（`src-tauri/src/remote/`）：`invoke{id,command,params}` / `invoke_ok` / `invoke_err` / `event` + pair/auth。`rpc.rs` 的 REGISTRY 静态表 = 白名单 = 可审计暴露面；**新增远程可用命令 = REGISTRY 加一行 + `rpc/handlers.rs` 加一个薄包装**（解析 camelCase DTO → `app.state::<T>()` → 调现有 commands 函数体）。收录原则：共享闭包被动调用 + PWA UI 必需；桌面 UI 专属命令不收。
- **RemoteTransport.listen 只支持 `chat-event`**（远程网关只透传这一种）；其他事件名 no-op + console.warn。
- 共享代码搬动后桌面旧路径留 re-export 壳（`src/api.ts`、`src/composables/*` 等），测试 mock 边界一律指 `@aide/sdk/api`（不是 `@/api`——壳与包内模块实例不同，mock 壳会漏）。

## 架构红线：跨平台

当前主力平台是 Windows，但所有新代码必须兼容 macOS/Linux——路径拼接用 `PathBuf`/`path.join`（不硬编码 `\\`）、平台特有逻辑（如 `creation_flags`）必须 `#[cfg(windows)]` 隔离、shell 脚本 dev.ps1 / dev.sh 保持功能对等。

## 架构红线：多端一致性（命令 / 事件双通道契约）

桌面端、remote-pwa、鸿蒙端共享同一会话。**UI 状态只认事件通道，不认本地乐观更新。**

sidecar 与 UI 之间是两条独立管道：

| 通道 | 方向 | 内容 |
|---|---|---|
| 命令通道 | UI → sidecar（单播） | `send` / `permission_response` / `interrupt` / `set_permission_mode`… |
| 事件通道 | sidecar → **所有** UI（广播） | `permission_request` / `user_message` / `permission_cancelled` / `jump_promoted`… |

**规则**：任何"某个客户端做了操作"要反映到其他客户端（或驱动本端状态机），必须由 sidecar 广播事件。
调用方自己改本地状态（乐观更新）只对本端可见，远端永远看不到。

**判读**：新增一个会改变对话状态的命令时，问一句"别的客户端怎么知道？"——答不上来就是漏了广播。

**已实锤的事故**（前两条同一个根因，2026-09-06）：
1. 远程应答权限后桌面弹窗不消失、状态卡 `attention`——`PermissionManager.resolve()` 只 resolve promise 不发事件。
2. 远程（鸿蒙/PWA）发的消息桌面端看不见——sidecar `send` 处理从不广播用户消息事件。
3. 自动命名恒失效、会话名永远是「新会话 HH:MM:SS」——标题早于 `session_init` 到达，
   写到了临时 id 上（详见下节）。

### 会话命名：落盘时机必须晚于定名

sidecar 在 `send` 时同步发 `session_title`（`agent-sidecar/src/session-worker.ts:1035`，
位于 `startLoop` 之前），那一刻会话只有前端生成的临时 id、元数据尚未落盘。

**规则**：任何"按会话 id 写元数据"的动作（名字 / 模型 / 档位 / provider 绑定）都必须等
`session_init` 定名之后——即 `finalizeSession` → 各端 `onSessionCreated` 那条路径
（`src/App.vue` / `remote-pwa/src/App.vue`）。注意**两处的回调都会跑**（事件是广播的），
所以它们必须算出同一个名字，否则互相覆盖、结果取决于谁后写。早到的值先暂存，
定名时随注册表搬迁：`useSessionNames` 的 pendingTitles、`identity.migrateBinding`、
`useSessionWorkspaces().migrate` 是同一套范式。

判据用 `finalizedSids`（`packages/aide-sdk/src/composables/useChatSession/state.ts`）区分
「已定名，可安全改名」与「还是临时 id，只能暂存」。**不要用「本端是否 pending」判断**：
别的客户端（PWA）发起的会话，本端不是 pending 但同样只是旁观者——抢写会给对方的
tempId 建孤儿元数据，并用 id 前 8 位覆盖对方已经写好的名字。两端都暂存、各自 finalize
时取用，写入的名字一致，谁后写都不出错。

### 用户气泡的单一渲染来源

三端都**不本地渲染用户气泡**，只认 sidecar 广播的 `user_message`
（`agent-sidecar/src/session-worker.ts:410` 的 `pushUserMessage` 统一三处入队点：首条 `:1029` / 续发 `:1056` / 插队 promote `:434`）。
「模型收到」与「各端看见」是同一个动作的两个面。

- **已知代价，接受**：本地发送也多一个 RTT 才出气泡（手机经 relay 约 100ms）。
  **禁止**加"超时兜底本地渲染"来消除延迟——排队消息（`jumpQueue`）可能几十秒后才接入，
  兜底必然误触发，且会重新引入两端状态不一致。
- **插队消息在 promote 时广播**，不是 `jump_queued` 登记时——否则气泡会插在上回合回复中间。
  `jump_promoted` 现在只负责清提示条 + 补忙碌态（`events.ts:592`）。
- automation 的 `send` **不跳过**广播（用 `run_id` 独立会话，事件按 sid 路由，只有打开该 run tab 才订阅）。
- 事件到远程客户端**全量转发无过滤**（`src-tauri/src/remote/relay_client.rs:61` subscribe 即发）；
  白名单（`remote/rpc.rs` 的 REGISTRY）只管**入站 invoke**。所以事件侧改动对三端同时生效，无需分别注册。

### `display` 渲染描述通道

发给模型的 `prompt` 是 @引用**展开后**的完整文本（`packages/aide-sdk/src/composables/useChatSession.ts:228`
`item.mentions?.sendText ?? item.prompt`）——结构信息在前端就被编译掉了，sidecar 只拿到一个字符串，
**无法还原**「正文 / 引用卡片 / 动作胶囊」的边界。所以渲染信息必须随 send 命令下发再回灌：
发起方构造 → Rust 原样搬运（`commands/chat.rs:140` `attach_display`，**不校验结构**）→ sidecar 广播 → 各端渲染。

- **⚠️ `UserMessageBlock` 在两个包各定义一份且必须同形**：`agent-sidecar/src/types.ts:79` 与
  `packages/aide-sdk/src/types/chat.ts:277`。两个包无法共享类型，shape 漂移会让 display
  **静默失效**（接收端识别不了就降级成纯文本，不报错）。**新增 block 形态时两边一起改。**
- 降级约定：display 缺失 / 未知形态 → 纯文本气泡或跳过该块，**整条消息不能消失**。
- `text` 取 display 的原文而非 prompt，让只渲染文本的端（鸿蒙 v1）不会看到展开后的引用内容。

### `permission_cancelled` 的语义

已扩成「这条请求已终结（批准 / 拒绝 / abort / 连带放行）」，**不是**"被取消"。
`permissions.ts:163` 在 `resolve()` 里无条件调用 `emitCancelled()`（先撤 UI 再放行工具）。
**今后新增任何会终结挂起请求的代码路径，都要发它。**

## 架构红线：语言无关（LSP）

Java/jdtls 专属配置**只准**待在 `src-tauri/src/lsp/profiles/java.rs`。公共层
（`manager.rs` / `mod.rs` / `protocol.rs` / `cmLsp.ts`）必须语言无关——新命令一律按文件扩展名分派
（`lang_from_ext_of`），对任何 language server 生效。公共文件的注释里 jdtls 只能作为**例子**出现，不能作为设计原因。

## 架构红线：远程控制是单设备模型（刻意设计，改动前先确认）

`remote/auth.rs` 的 `TokenStore` 只存单个 `remote/token`——**新设备配对 = 覆盖旧 token = 静默踢掉旧设备**
（旧设备下次连上直接 `revoked` 回连接屏）。这是安全设计（限制 token 累积），**不是缺陷**。

若要改成多设备共存，必须意识到这是**安全降级**：配对码泄露后恶意设备不会顶掉合法设备，而是静默共存。改前先跟用户确认。

relay（`relay-server/`）是**哑管道**：只做 device_id/pairing_code 配对与 WS 桥接，不解析业务数据。
agent 始终跑在**用户桌面**，桌面不在线 = `connect: device offline`。

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
- **主题系统是配色的唯一来源（多主题必须可切换）**：配色一律走 `src/themes/` 的语义 token——`tokens.ts` 定义 `ThemeTokens`（bg / surface / text / accent / success|warning|danger|info / border / shadow / radius / space / **colorScheme** 约 26 个槽位），`glass.ts`（默认）与 `warm-dark.ts` / `catppuccin.ts` / `smoky-pink-glass.ts` 各实现一份；`apply.ts` 把每个 token 写成 `:root` 上的 `--aide-<kebab>` CSS 变量（camelCase→kebab，如 `bgDeep`→`--aide-bg-deep`），`App.vue` 启动按 `settings.theme` `applyTheme`、`SettingsPanel.vue` 切换时即时 `applyTheme`。**`colorScheme` 是例外**：不是 `--aide-*` 变量而是浏览器原生 `color-scheme` 属性，`apply.ts` 对它特判直接 `root.style.setProperty("color-scheme", value)`，决定原生表单控件（复选框/未主题化 input）按 light/dark 渲染；暗色 `"dark"`、亮色 `"light"`。`global.css :root` 另留 `color-scheme: dark` 作首屏兜底。加亮色主题只需新主题文件给 `colorScheme: "light"`，其余不用动。**硬性规则：所有颜色/背景/边框/阴影/圆角/间距必须用 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空、不定义任何颜色工具类（曾有的一套 Catppuccin 字面量已移除），需要新语义色就往 `ThemeTokens` 加槽位并在每个主题文件给值。** 新增主题＝新增一个实现 `ThemeTokens` 的文件 + 在 `themes/index.ts` 的 `themes` 注册表加 key。**主题开发封闭契约（主题=纯 token 文件、组件清单封闭、不允许主题私自新增/魔改组件、质感槽位表、玻璃后门配方、验收清单）见 [docs/reference/theme-development.md](docs/reference/theme-development.md)。
- **VC++ Redistributable 随包分发（NSIS POSTINSTALL 静默装）**：aide.exe 由 MSVC 14.3x（VS Build Tools 2022）编译，依赖 `MSVCP140.dll`/`VCRUNTIME140.dll`（来自 `ort`/ONNX Runtime 的 `copy-dylibs` + WebView2/wry）。用户机器若缺/旧/损坏这些运行库，exe 在 C++ 运行库加载阶段即 access violation（`0xc0000005`）崩溃——比 aide 第一行 Rust 代码还早，故无日志无提示，表现为「双击无反应」（release 是 `windows_subsystem = "windows"` 无控制台）。解法：`vc_redist.x64.exe`（微软官方 offline redist，~24MB，`https://aka.ms/vs/17/release/vc_redist.x64.exe`，该 URL 永远指向最新 14.4x）经 `bundle.resources` 打包到 `$INSTDIR/vc-redist/`（Windows 上 `resource_dir()` = exe 同目录，见上面 `\\?\` 坑点），`bundle.windows.nsis.installerHooks` 指向 `src-tauri/nsis/installer-hooks.nsh` 的 `NSIS_HOOK_POSTINSTALL` 宏 `ExecWait` 跑 `vc_redist.x64.exe /install /quiet /norestart`。返回码白名单 `0`=成功 / `1638`=已装相同或更新 / `3010`=需重启，失败不中断 aide 安装、非 silent 模式弹 MessageBox 提示手动装。不写 `PREUNINSTALL`/`POSTUNINSTALL`——vc_redist 是系统共享运行库，aide 卸载不卸它（其他应用可能依赖）。`install_mode` 保持默认 `CurrentUser`（per-user、无 UAC、匹配 vc_redist per-user 静默装）。**维护**：VC++ 运行库安全更新不自动跟进，定期重新下载 `vc_redist.x64.exe` 覆盖 `src-tauri/resources/vc-redist/` 即更新；更新后在 commit message 记新版本号（文件属性可见）。installer 体积 +24MB 是该方案的已知代价（换离线机也能装、装一次系统级、可被 Windows Update 维护）。
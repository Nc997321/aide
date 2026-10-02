# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Agent SDK 提供带会话管理和文件树的 Chat 客户端（Node.js sidecar 驱动对话，不是 xterm 套壳终端）。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2（Rust 后端 + WebView 前端），Windows 用 MSVC 工具链 |
| 前端 | Vue 3 + Composition API + TypeScript |
| 样式 | Tailwind CSS 3 + 多主题（glass 默认 / warm-dark / catppuccin / smoky-pink-glass），全项目三角箭头统一 `font-size: 14px` |
| 包管理 | pnpm workspace：`packages/*` + `remote-pwa`；**agent-sidecar 刻意不进 workspace**：依赖在子目录独立 pnpm 安装，构建脚本经 `npm --prefix` 执行 |
| 共享 SDK | `packages/aide-sdk`（@aide/sdk）：types + api 门面 + transport + useChatSession，桌面与 remote-pwa 共用；TS 源码直出无构建链 |
| 鸿蒙端 | ArkTS（`ohos/`）：WS 客户端连 relay-server；不进 workspace，SDK 走过筛副本 + 同步脚本 |

**手机端（remote-pwa / ohos / SDK 的 `remote.ts`）由手机端自己演进，桌面侧不替它改**——只交付协议（见「手机 ↔ Host」）。

## 已删除，不许复活

| 东西 | 删于 | 备注 |
|---|---|---|
| 桌面网关 v2（`src-tauri/src/remote/`、REGISTRY / CORE_EXPOSED） | 2026-10-01 | 手机协议只有 Aide Link |
| codegraph 代码索引 | 2026-10-01 | 实测 agent / 用户都不用；要找回用 git tag `codegraph-final`。agent 导航只走 aide-lsp + grep 顺带作答 hook |
| 远程工作区「逐命令转发 + UNC 路径翻译」 | 2026-09-30 | Host 窗口里前后端之间一律是 Host 原生路径 |
| headless HTTP/SSE 宿主 | 2026-09-30 | 多端接入走 Host 模型 |
| 配对码路由（`connect{code}` 恒 `unknown_code`）、`settings.remote.relayUrl` | — | 配对靠扫二维码；中继地址见下 |

## @aide/sdk：能力单一事实源

桌面（Tauri IPC）与手机端共用同一套能力实现，**禁止再开第二份平行实现**：

- **传输层** `AideTransport { invoke, listen }`：桌面默认 TauriTransport，远端 `main.ts` 早期 `setTransport(new RemoteTransport(...))`。共享代码只调 `getTransport()`，**禁止直接 import `@tauri-apps/*`**。
- **api 门面**（`api.ts` + `api/*`）是所有命令调用的唯一入口，闭包需要的命令必须收进门面，不写散 invoke。
- **手机能调什么 = `crates/aide-link/src/catalog.rs` 的暴露目录**（整张表即远程暴露面，命令名 = Host 命令表里的命令，零包装；远程专属预处理如 send_message 的权限模式兜底只在目录的 `prepare` 一处）。Link 的事件目录只有 `chat-event` / `system-notification` / `permissions-changed`。
- 共享代码搬动后桌面旧路径留 re-export 壳；测试 mock 边界一律指 `@aide/sdk/api`（不是 `@/api`——壳与包内模块实例不同，mock 壳会漏）。

## 架构红线：跨平台

主力平台是 Windows，但所有新代码必须兼容 macOS/Linux：路径用 `PathBuf`/`path.join`（不硬编码 `\\`）；平台特有逻辑（如 `creation_flags`、Windows 句柄类型、仅 Windows 存在的 crate API）必须 `#[cfg(windows)]` 隔离；dev.ps1 / dev.sh 保持功能对等；测试不许写死平台（用 `std::env::consts::OS`）。

macOS 上踩过的坑（2026-10-02 桌面壳首次编过 macOS）：`objc2` 不单独声明（由 `objc2-app-kit` / `objc2-foundation` 0.2.x 传递引入，写错一代就编不过）；`notify_rust::Notification::app_id` 仅 Windows 存在，通知身份一律走 `host_door::apply_notification_identity`；`NSArray::iter` 要开 `NSEnumerator` feature。

## GitHub 公开镜像与 CI

- **Gitee（`origin`）是完整历史的真相源；GitHub（`github`，Nc997321/aide，公开）是清洗后的镜像，只经 `scripts/publish-github.sh` 同步，禁止直接 `git push github`**（会把未清洗的历史公开）。需要 `git-filter-repo`；`--dry-run` 只清洗扫描不推送。
- 清洗规则（`rules.txt` / `mailmap.txt` / `forbidden.txt`）放 `~/.config/aide-publish/`，**不进仓库**——规则本身含有要抹掉的字符串。清洗确定性，日常是快进推送；只有规则改动才需要 `--force`。脚本清洗后会扫全历史，命中 `forbidden.txt` 即中止。
- 仓库里不要再写入真实隧道 UUID / 镜像仓库账号 / 内网 IP / 个人邮箱或本机路径；新增敏感类型时同步更新规则与 `forbidden.txt`。
- CI（`.github/workflows/ci.yml`，只在 GitHub 触发）在 **macOS** 跑四项：frontend（`pnpm build` + `pnpm test`）/ rust crates（aide-workspace、aide-core、aide-link、aide-host）/ sidecar / tauri-shell（`cargo check` 桌面壳，占位资源）——**跨平台红线靠它兜底**。Windows 暂无 CI。
- CI 里必须还原本地的依赖布局：根 vitest 含 `agent-sidecar/src/**`，需装 sidecar 依赖；`jsdom` 只声明在根 package.json；macOS bundle 资源的 glob 要 `pnpm --dir agent-sidecar install` 才有。

## 架构红线：多端一致性（命令 / 事件双通道契约）

桌面端、remote-pwa、鸿蒙端共享同一会话。**UI 状态只认事件通道，不认本地乐观更新。**

| 通道 | 方向 | 内容 |
|---|---|---|
| 命令通道 | UI → sidecar（单播） | `send` / `permission_response` / `interrupt` / `set_permission_mode`… |
| 事件通道 | sidecar → **所有** UI（广播） | `permission_request` / `user_message` / `permission_cancelled` / `jump_promoted`… |

**规则**：任何"某个客户端做了操作"要反映到其他客户端（或驱动本端状态机），必须由 sidecar 广播事件。新增会改变对话状态的命令时问一句"别的客户端怎么知道？"——答不上来就是漏了广播。

- **会话元数据落盘时机**：任何"按会话 id 写元数据"（名字/模型/档位/provider 绑定/工作区归属）都必须等 `session_init` 定名（`finalizeSession` → `onSessionCreated`）。早到的值暂存、定名时随注册表搬迁（pendingTitles / `identity.migrateBinding` / `useSessionWorkspaces().migrate` 同一范式）；判据用 `finalizedSids`，**不要用「本端是否 pending」**。
- **会话工作区归属是会话自持属性**：`wsPath`/`wsKey` 落 `~/.aide/sessions/<id>.json`，唯一读写入口 `set_session_workspace` / `session_workspace`。send 的 cwd 解析链只有三级：客户端 `workspaceRoot` → 档案 `wsPath`（须 `exists`）→ **活动工作区 + `tracing::warn`**；最后一级就是"跑错项目"的来源，**不许无声**。前端 `useSessionWorkspaces` 只是可回种的缓存（缺条目由 `ensureWorkspaceKnown` 从档案补，绝不覆盖已有值），别再造第三份只读内存的来源。
- **用户气泡单一渲染来源**：三端都只认 sidecar 广播的 `user_message`，不本地渲染。多一个 RTT 才出气泡是已接受的代价，**禁止加"超时兜底本地渲染"**（jumpQueue 排队消息会误触发）。插队消息在 promote 时广播。
- **事件到手机按订阅投递**（Link 的 `subscribe`：可按会话过滤、`since` 续传）；入站调用由暴露目录挡。
- **`permission_cancelled` 的语义**是「这条请求已终结（批准/拒绝/abort/连带放行）」，不是"被取消"。`permissions.ts` 的 `resolve()` 无条件发它，今后任何会终结挂起请求的新路径都要发。

### `display` 渲染描述通道

`prompt` 是 @引用展开后的纯文本，sidecar 无法还原「正文/引用卡片/动作胶囊」边界，所以渲染信息随 send 命令下发再回灌：发起方构造 → Rust `attach_display` 原样搬运（不校验结构）→ sidecar 广播 → 各端渲染。

- **⚠️ `UserMessageBlock` 在两个包各定义一份且必须同形**（`agent-sidecar/src/types.ts` 与 `packages/aide-sdk/src/types/chat.ts`）。shape 漂移会让 display **静默失效**（降级成纯文本，不报错）；新增 block 形态两边一起改。
- 降级约定：display 缺失/未知形态 → 纯文本或跳过该块，**整条消息不能消失**；`text` 取 display 原文而非 prompt。

### @引用的行号区间（`@path:12-48`）

解析唯一真相源 `packages/aide-sdk/src/utils/fileMentions.ts`（`parseMentionPath` / `formatMentionPath` / `splitMentionSections`，收发两端共用）。省 token 靠发送前切片注入，不靠 Read 的 offset/limit；引用读**磁盘内容**（未保存的编辑不在里面）。

## 架构红线：语言无关（LSP）

Java/jdtls 专属配置**只准**在 `src-tauri/crates/aide-core/src/lsp/profiles/java.rs`。公共层（`manager.rs` / `mod.rs` / `protocol.rs` / `cmLsp.ts`）必须语言无关——新命令一律按文件扩展名分派（`lang_from_ext_of`）。

- **扩展名有三条轴，别混用**：**服务归属** = `LanguageId::from_ext`（唯一权威表；`.vue`/`.tsx` 归 TypeScript、`.jsx` 归 JavaScript，**没有独立的 vue 语言**）；**文档 languageId** = `document_lang_id`（`.vue` 发 `"vue"`、`.tsx`/`.jsx` 发 `*react`，字符串由 Rust 推，前端只报服务 id）；**探针靶子** = `probe_exts`（只递 server 原生能解析的形态，`.vue` 不算）。语言探测必须下钻（marker 链认领一级子目录里的项目，扩展名计数走有界遍历）。
- 前端影子表 `src/utils/lspLang.ts` 必须与 `from_ext` 同步（`pnpm check:lsp-parity` 构建期兜）。
- **TS 的 typescript SDK 必须由 `lsp/profiles/ts_sdk.rs` 解析后用 `initializationOptions.tsserver.path` 递进去**（TLS 只在工作区根及祖先里找 SDK，工程在子目录时 `initialize` 直接失败；路径必须是平台原生分隔符）。**且必须恒发 `disableAutomaticTypingAcquisition: true`**：否则 tsserver 会在用户工作区跑包管理器装 `@types/*`——实测把 `frontend/` 的顶层依赖挪进 `node_modules/.ignored/` 让前端跑不起来，用户既没批准也不可见。
- **agent 的 LSP 工具每一发都必须比 grep 值**（实测用户跑 DeepSeek 等模型，旧工具只回裸坐标 + 冷窗口空等，被调用 1 次 vs grep 1667 次）：定义带函数体、引用带行文本与所在函数、没答上时同一发给文本兜底（标 UNVERIFIED）；grep 顺带作答 hook（`lspGlance.ts`）**未命中必须廉价**（预算 1.5s + 负缓存）；按名查询的命中要挪到名字本身上（`agent_nav::refine_to_name`，否则拿声明起点查引用 = 查 `export` 关键字 → 假「确认没有」）。

详见 `src-tauri/crates/aide-workspace/src/detect/languages.rs` 抬头与 `profiles/ts_sdk.rs`。

## 架构红线：远程控制是单设备模型（刻意设计，改动前先确认）

`aide-link` 的 `Identity` 只存**一把**已配对的手机公钥——**新设备配对 = 覆盖旧公钥 = 旧设备被踢（`bye{superseded}`）**。这是安全设计，不是缺陷；改成多设备共存是**安全降级**（二维码泄露后恶意设备静默共存），改前先跟用户确认。

- **中继地址是产品内置的固定值**（`aide-core/src/link/mod.rs` 的 `DEFAULT_RELAY_URL` = `wss://relay.aideai.store`）：不是设置、UI 不展示不可改；唯一覆盖口是环境变量 `AIDE_RELAY_URL`（开发 / 自建 / 集成测试）。
- **relay（`relay-server/`）是哑管道且不被信任**：只按 `device_id` 做 WS 桥接，读不懂业务数据（端到端加密）。agent 跑在 **Host** 上，Host 不在线 = `connect_error{device_offline}`。relay 层帧契约改动 = 改 `relay-server/src/protocol.rs` + `docs/aide-link-protocol.md` §2.2，并告知手机端。

### 手机 ↔ Host：Aide Link

协议见 [docs/aide-link-protocol.md](docs/aide-link-protocol.md)，实现分两处：**协议本体、帧、暴露目录、配对规则只改 `crates/aide-link`**（`frame.rs` / `secure.rs` / `catalog.rs` / `identity.rs`），同步 `docs/aide-link-protocol.md` 与 `docs/aide-link/frames.d.ts`（有对账测试），并补一致性向量（`tests/fixtures/`）；**Host 端网关在 `aide-core` 的 `link/`**（`LinkService` 随 `host::start` 启动；`link_*` 命令是 Host 设置面板用的，不对手机开放）。

**配对靠扫二维码**（含 Host 公钥 + 一次性 psk），帧经 Noise 端到端加密，没有配对码、没有 token，手机静态密钥即凭据——别退回短码 / 明文。开发手机端可直连本地测试 Host：`cargo run -p aide-link --features transport --example test_host`。

## 架构红线：Host 模型——一张命令表，多个前门

**一个 Host = 一整个 Aide 后端**（会话 / agent / 文件 / git / 终端 / LSP / 插件 / 记忆 / 供应商），GUI 只是连到某个 Host 的屏幕；**一个窗口 = 一个 Host**（本机 / WSL / SSH）。**没有「主窗口」**：窗口连着谁是它当下的属性，可以换（`switch_window_host`：改绑 + 重载页面，旧 Host 没别的窗口了就断开）；标签（第一扇碰巧叫 `main`）只是身份，**禁止用标签判断「是不是本机」或「该唤起谁」**——要「哪扇窗口」一律问 `host_window::current_window`（最近获得焦点的）/ `local_window`（连着本机 Host 的；没有就新开一扇）。关的是应用里唯一一扇窗口 = 收进托盘，否则真关。设计与迁移阶梯见 [docs/host-model.md](docs/host-model.md)。

- **命令唯一实现 = `crates/aide-core` 的命令表**（Tauri 无关）：本机窗口由 `src/host_door.rs` 进程内直调；Host 窗口由 `host_door::forward` 原样转发给那台 Host 的 `aide-host serve`。已迁入的命令**不写 `#[tauri::command]`、不进 `generate_handler!`**；新命令按 docs/host-model.md §4；**禁止再开平行分派**。
- **Host 自持状态住 `aide_core::Core`**；宿主能力一律经端口注入：事件 `EventSink`、随包资源 `HostResources`、GUI 侧能力 `runtime::ports::AgentHooks`。**aide-core 禁止依赖 Tauri**，且与 aide-host 同守「无系统 C 库、单静态二进制」：crate 自带源码的 C/汇编（如 rustls 的 ring）允许，需要目标机装 `.so` / 头文件 / pkg-config 的依赖（libdbus、openssl-sys 动态链接等）一律禁止。Host 不弹系统通知：`Core::notify` 发 `system-notification` 事件，由 GUI 前门弹。
- **事件总线是 Host 自己的**（`aide_core::bus`）：全部事件在这里编号、留底（16MiB / 5 万条）、按会话订阅投递、断线回放。**新的多客户端出口一律实现 `bus::Consumer`，不要再造平行的广播。**
- **事件隔离两头做**：后端本机 Core 事件只 `emit_to` 本机窗口、serve 通知只 `emit_to` 该 Host 的窗口（`src/host_window.rs`）；前端监听一律窗口作用域（`TauriTransport.listen`），**不要在共享代码里用 Tauri 默认的全局 `listen`**（会让 WSL 窗口看到本机会话的 chat-event）。
- **GUI 与 Host 之间的跨界必须显式、用户看得见**（`src/host_window.rs`）：本机文件进对话 = 上传到 Host 暂存（`upload_local_files`）；「用本机程序打开 / 在资源管理器中显示」对 WSL 路径译成 `\\wsl.localhost\…`、SSH 如实拒绝（`host_window::gui_path`）；「从本机复制供应商」是一次显式动作，不自动同步。GUI 侧工具（内嵌浏览器）的应答经 core `agent_tool_result` 回到 Host 的 runtime。
- **供应商 / 插件 / MCP / hooks / 记忆都按 Host 自持**：每个 Host 一份，装到它自己的 `~/.aide`。远程 Host 的密钥落 `~/.aide/secrets.json`（0600，`FileSecretStore`）；**不同步 OAuth 凭据**（refresh token 轮换会互相顶掉），官方账号登录在目标机上跑 `~/.aide/host/aide-claude` → `/login`。
- **远程套件**：`pnpm build:remote-kit`（aide-host musl 静态二进制 + runtime.js，已挂进 `pnpm release`）；桌面按内容哈希装到目标机 `~/.aide/host/<ver>/`，连接首行 `ServeInit`（协议 v5，`crates/aide-host/src/protocol.rs` 是两端唯一真相源）。**Host 是常驻守护进程**（`aide-host daemon`，一个用户一个，`~/.aide/host/daemon.sock`）：`aide-host serve` 只是桌面一条连接与它之间的桥；**连接断开不收掉 Host**，事件带全局序号 `seq`，桌面重连凭 `resume` 补回（补不齐报 `resync`）；没有客户端且静默超过 `AIDE_HOST_IDLE_SECS`（默认 30 分钟）才自行退出。
- **Host 的启动职责只写在 `aide_core::host`**（`prepare_workspace` + `start`），桌面 setup 与 `aide-host serve` 都调它，**不许只写在某一扇前门里**（2026-09-30：serve 漏了日常目录引导，WSL 会话 cwd 不存在，claude 起不来，SDK 还误报成 libc 不匹配）。
- **「目录还在吗」一律 `aide_core::workspace::present`**：误判 = 会话 cwd 回落活动工作区 = 2026-09-18「跑错项目」事故的形态。
- 真机回归：`src/remote_workspace/e2e_tests.rs`（WSL 上的安装 / 工作区操作 / 真实会话 / Host 里的语言服务器），运行方式见文件头。

## 架构红线：可替换技术必须藏在端口后面

**凡是「有多个竞争实现」或「成熟度不确定」的第三方技术，不许在业务代码里直接引用**：领域层只定义 trait（端口），实现放适配器层。判据：这个技术点未来是否可能出现第二个实现、且切换只需替换一个文件？有 → 抽象；没有 → **不要抽象**（换 HTTP 框架 / ORM 等于重写，抽象层是仪式感债务）。

样板 `knowledge-server/`：`src/port/`（只定义 trait 与领域类型）→ `src/adapter/`（整个 crate 唯一允许第三方库的地方）→ `src/domain/`（只依赖 port）→ `src/api/`。约束：按扩展名分派（不写 `if is_docx()`）；同扩展名多后端 = 回退链；产物类型是领域自己的；降级如实上报（丢失信息进 `warnings`）；CPU 密集端口保持同步（调用方 `spawn_blocking`）。**验收**：grep 第三方库名，`src/adapter/` 之外不允许出现任何 `use`/类型引用/函数调用（注释不算）。

## ⚠️ Windows 必读坑点

- **`CREATE_NO_WINDOW`**：所有 `Command::new(...)`（git 或任何 CLI）必须加 `creation_flags(0x08000000)`，否则 Windows 为每个子进程弹控制台窗口，release 中表现为大量错误弹窗。必须 `#[cfg(windows)]` 隔离（`use std::os::windows::process::CommandExt`）。涉及 `git.rs`、`marketplace.rs`、`filesystem.rs` 及任何 spawn 外部进程的代码。
- **`resource_dir()` 的 `\\?\` verbatim 路径**：Tauri 在 Windows 返回带该前缀的路径，**传给外部进程（尤其 `node`）前必须 `dunce::simplified()`**，否则 node 的 `realpathSync` 在引导阶段 `EISDIR` 崩溃——典型现象：dev 正常，**打包后一发消息就"会话进程已退出"**。Rust 自己 `fs::read` 不受影响。涉及 `src/host_door.rs` 的 `DesktopResources`。
- **VC++ Redistributable 随包分发**（NSIS POSTINSTALL 静默装 vc_redist）：aide.exe 依赖 `MSVCP140.dll`/`VCRUNTIME140.dll`，缺/旧 → 「双击无反应」（C++ 运行库加载阶段崩溃，早于任何 Rust 代码）。

## 关键约定

- **同步 command 禁止重 IO / 重 CPU**：一律 `async fn` + `spawn_blocking`。两个坑：带 `State<'_,T>` 引用参数的 async 命令必须返回 `Result`（E0277）；`State<T>` 不能跨 `spawn_blocking`，注册成 `Arc<T>` 后 clone 进闭包。
- **`trace_command` 兜底**：保留同步但做 IO/子进程/外部调用的命令，第一行埋 `let _trace = crate::diagnostics::trace_command("函数名");`（在任何 IO/spawn 与 cfg 分支之前）。**只对同步命令有意义，禁止给 async 命令埋**。由构建期守卫 `pnpm check:sync-io`（已挂进 `pnpm build`）强制；豁免在 `scripts/check-sync-io-commands.mjs` 登记并写明理由。（缘由：未埋点的同步命令卡死时冻结报告 `stuckCommand` 恒为 `None`，肇事者定不到。）
- **主题系统是配色的唯一来源**：颜色/背景/边框/阴影/圆角/间距一律走 `src/themes/` 语义 token 的 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空。新增语义色 → `ThemeTokens` 加槽位 + 每个主题文件给值；新增主题 → 新文件实现 `ThemeTokens` + `themes/index.ts` 注册。`colorScheme` 是例外。

## agent-sidecar 职责边界（engine / extensions / desktop 三层）

**判据：换一个宿主（如 WSL / SSH 目标机上的 Host）还需要的 → engine；只有桌面 UI 需要的 → 留在桌面协议层。**

| 层 | 内容 |
|---|---|
| **engine 核心**（保持纯净） | 会话驱动（`session-worker`/`session-manager`）、权限（`permissions`/`policy`）、事件广播与流式帧（`deltaCoalescer`/`stdoutFrames`）、子代理（`subagents`）、MCP/hooks 装配（`userExtensions`）、运行环境（`claudeExe`/`winBashEnv`） |
| **extensions**（可选，按宿主装配） | `docsMcp` + `docx/` + `pdf/`、`testMcp`、`skillGuard`/`dispatchPlugins`；已成型的独立 server 应逐步外迁为独立目录/进程（参照 knowledge-server 的 port/adapter 范式） |
| **desktop 语义** | `display` 渲染通道、`jumpQueue` 插队、会话 tab 管理、automation/btw——只属于桌面协议层，不进 engine |

1. 新增逻辑先判归：不要默认"跟会话有关就进 sidecar"，先问是不是 engine 职责。
2. 内置 MCP/Hooks 新增必须同步登记前端镜像（`useCustomizations`）。
3. 拆分走渐进：新代码守边界，已成型大块（docx/pdf）在触碰时顺势外迁，**不做一次性大动刀**。
4. **机制/策略边界**：引擎提供机制，宿主决定策略（门面不认识「用途」，browser facade / browser_agent 即此口径）。事件**按会话订阅路由**是 Host 网关协议的硬要求（桌面全量转发在多窗口 / 手机连同一 Host 时是泄露隐患）。

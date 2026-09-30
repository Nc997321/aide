# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Agent SDK 提供带会话管理和文件树的 Chat 桌面客户端（Node.js sidecar 驱动对话，不再是 xterm 套壳终端）。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2 (Rust 后端 + WebView 前端) |
| 前端 | Vue 3 + Composition API + TypeScript |
| 终端 | xterm.js 5.x + xterm-addon-fit |
| 代码高亮 | highlight.js 11.x（仅打包 15 种语言；编辑器侧 yaml/properties 走 @codemirror/legacy-modes + StreamLanguage） |
| Markdown 渲染 | marked 18.x（文件查看器 .md 预览） |
| 样式 | Tailwind CSS 3 + 多主题（glass 默认 / warm-dark / catppuccin / smoky-pink-glass），全项目三角箭头统一 `font-size: 14px` |
| 包管理 | pnpm（workspace：`packages/*` + `remote-pwa`；agent-sidecar 刻意不进 workspace：依赖在子目录独立 pnpm 安装，构建脚本经 `npm --prefix` 执行绕 pnpm stub） |
| Rust 编译 | MSVC 工具链（VS Build Tools 2022） |
| 共享 SDK | `packages/aide-sdk`（@aide/sdk）：types + api 门面 + transport + useChatSession 闭包，桌面与 remote-pwa 共用；TS 源码直出无构建链，改即生效 |
| 鸿蒙端 | ArkTS（`ohos/`）：WS 客户端连 relay-server，远程协议 v2 的第三个前端；不进 pnpm workspace；SDK 走过筛副本（Vue-free 子集）+ 同步脚本，**改协议需三端同步**（remote.rs ↔ remote.ts ↔ ohos） |

## @aide/sdk：能力单一事实源

桌面（Tauri IPC）与 remote-pwa（WS 远程）共用同一套能力实现，**禁止再开第二份平行实现**：

- **传输层** `AideTransport { invoke, listen }`（`packages/aide-sdk/src/transport.ts`）：桌面默认 TauriTransport，远端 `main.ts` 早期 `setTransport(new RemoteTransport(...))`。api 门面与闭包永远只调 `getTransport()`，**禁止在共享代码里直接 import `@tauri-apps/*`**。
- **api 门面**（`api.ts` + `api/*`）：所有命令调用的唯一入口；闭包需要的命令必须收进门面（含 DTO 对象化），不写散 invoke。
- **远程协议 v2**（`src-tauri/src/remote/`）：`rpc.rs` 的 REGISTRY 静态表 = 白名单 = 可审计暴露面；**新增远程可用命令 = REGISTRY 加一行 + `rpc/handlers.rs` 加一个薄包装**。收录原则：共享闭包被动调用 + PWA UI 必需。
- **RemoteTransport.listen 只支持 `chat-event`**（远程网关只透传这一种）；其他事件名 no-op + console.warn。
- 共享代码搬动后桌面旧路径留 re-export 壳，测试 mock 边界一律指 `@aide/sdk/api`（不是 `@/api`——壳与包内模块实例不同，mock 壳会漏）。

## 架构红线：跨平台

当前主力平台是 Windows，但所有新代码必须兼容 macOS/Linux——路径拼接用 `PathBuf`/`path.join`（不硬编码 `\\`）、平台特有逻辑（如 `creation_flags`）必须 `#[cfg(windows)]` 隔离、shell 脚本 dev.ps1 / dev.sh 保持功能对等。

## 架构红线：多端一致性（命令 / 事件双通道契约）

桌面端、remote-pwa、鸿蒙端共享同一会话。**UI 状态只认事件通道，不认本地乐观更新。**

| 通道 | 方向 | 内容 |
|---|---|---|
| 命令通道 | UI → sidecar（单播） | `send` / `permission_response` / `interrupt` / `set_permission_mode`… |
| 事件通道 | sidecar → **所有** UI（广播） | `permission_request` / `user_message` / `permission_cancelled` / `jump_promoted`… |

**规则**：任何"某个客户端做了操作"要反映到其他客户端（或驱动本端状态机），必须由 sidecar 广播事件。新增一个会改变对话状态的命令时，问一句"别的客户端怎么知道？"——答不上来就是漏了广播。
（三类已实锤事故：权限 resolve 不广播 / send 不广播用户消息 / 标题早于 `session_init` 写到临时 id。）

- **会话元数据落盘时机**：任何"按会话 id 写元数据"（名字/模型/档位/provider 绑定/工作区归属）都必须等 `session_init` 定名（`finalizeSession` → `onSessionCreated`）。早到的值暂存、定名时随注册表搬迁（pendingTitles / `identity.migrateBinding` / `useSessionWorkspaces().migrate` 同一范式）；判据用 `finalizedSids`，**不要用「本端是否 pending」判断**。
- **会话工作区归属是会话自持属性**：`wsPath`/`wsKey` 落 `~/.aide/sessions/<id>.json`，唯一读写入口 `set_session_workspace` / `session_workspace`（与身份字段分开但共用同一个加锁的合并写）。send 的 cwd 解析链只有三级：客户端 `workspaceRoot` → 档案 `wsPath`（须 `exists`）→ **活动工作区 + `tracing::warn`**；最后一级就是"跑错项目"的来源，**不许无声**。前端 `useSessionWorkspaces` 只是**可回种的缓存**（缺条目由 `ensureWorkspaceKnown` 从档案补，且绝不覆盖已有值），新增客户端 / 新功能一律走这条链，别再造第三份只读内存的来源。
  （已实锤事故 2026-09-18：归属只在内存里，关 tab / WebView 重载即失 → 静默回落活动工作区 → 进程 cwd、记忆目录、CLAUDE.md、转录落点全跑错项目。）
- **用户气泡单一渲染来源**：三端都只认 sidecar 广播的 `user_message`，不本地渲染。已知代价（本地发送多一个 RTT 才出气泡）已接受，**禁止加"超时兜底本地渲染"**（jumpQueue 排队消息会误触发）。插队消息在 promote 时广播。
- **事件到远程客户端全量转发无过滤**（`relay_client.rs` subscribe 即发）；白名单（REGISTRY）只管入站 invoke。

### `display` 渲染描述通道

`prompt` 是 @引用展开后的纯文本，sidecar **无法还原**「正文/引用卡片/动作胶囊」边界——渲染信息随 send 命令下发再回灌：发起方构造 → Rust `attach_display` 原样搬运（不校验结构）→ sidecar 广播 → 各端渲染。

- **⚠️ `UserMessageBlock` 在两个包各定义一份且必须同形**（`agent-sidecar/src/types.ts` 与 `packages/aide-sdk/src/types/chat.ts`）。shape 漂移会让 display **静默失效**（降级成纯文本，不报错）。新增 block 形态两边一起改。
- 降级约定：display 缺失/未知形态 → 纯文本或跳过该块，**整条消息不能消失**；`text` 取 display 原文而非 prompt。

### @引用的行号区间（`@path:12-48`）

解析唯一真相源 = `packages/aide-sdk/src/utils/fileMentions.ts`（`parseMentionPath` / `formatMentionPath` / `splitMentionSections`，收发两端共用）。省 token 靠发送前切片注入，不靠 Read 的 offset/limit；引用读**磁盘内容**（未保存的编辑不在引用里）。

### `permission_cancelled` 的语义

「这条请求已终结（批准/拒绝/abort/连带放行）」，**不是**"被取消"。`permissions.ts` 的 `resolve()` 无条件发它。今后新增任何会终结挂起请求的代码路径，都要发它。

## 架构红线：语言无关（LSP）

Java/jdtls 专属配置**只准**待在 `src-tauri/src/lsp/profiles/java.rs`。公共层（`manager.rs` / `mod.rs` / `protocol.rs` / `cmLsp.ts`）必须语言无关——新命令一律按文件扩展名分派（`lang_from_ext_of`）。

**扩展名有三条轴，别混用**（2026-09-29 立，起因：agri-ai-agent 只探测出 Java）：**服务归属** = `LanguageId::from_ext`（唯一权威表；`.vue`/`.tsx` 归 TypeScript、`.jsx` 归 JavaScript，**没有独立的 vue 语言**——`vue-language-server` 是要客户端桥接的 proxy，装了也零响应）；**文档 languageId** = `document_lang_id`（`.vue` 必须发 `"vue"`、`.tsx`/`.jsx` 必须发 `*react`，否则 TLS 丢弃文档 / 按 TS 解析 SFC 与 JSX；前端只报服务 id，这个字符串由 Rust 推）；**探针靶子** = `probe_exts`（只递 server 原生能解析的形态，`.vue` 不算）。语言探测必须下钻：marker 链认领一级子目录里的项目，扩展名计数走有界遍历。前端影子表 `src/utils/lspLang.ts` 必须与 `from_ext` 同步（`pnpm check:lsp-parity` 构建期兜）。**TS 的 typescript SDK 必须由 `lsp/profiles/ts_sdk.rs` 解析后用 `initializationOptions.tsserver.path` 递进去**（**且必须恒发 `disableAutomaticTypingAcquisition: true`**：tsserver 默认会在用户工作区跑包管理器装 `@types/*`——实测把 `frontend/` 的顶层依赖挪进 `node_modules/.ignored/` 让前端跑不起来，用户既没批准也不可见；缺 `@types` 由用户自己装）——TLS 只在工作区根及其祖先里找 SDK，工程在子目录（`frontend/`）时它看不见，`initialize` 直接失败；路径还必须是平台原生分隔符（它按 `path.sep` 切分反推模块根）。详见 `src-tauri/src/lsp/detector.rs` 抬头与 `profiles/ts_sdk.rs`。

## 架构红线：远程控制是单设备模型（刻意设计，改动前先确认）

`remote/auth.rs` 的 `TokenStore` 只存单个 `remote/token`——**新设备配对 = 覆盖旧 token = 静默踢掉旧设备**。这是安全设计，不是缺陷。若要改成多设备共存必须意识到这是**安全降级**（配对码泄露后恶意设备静默共存），改前先跟用户确认。

relay（`relay-server/`）是**哑管道**：只做配对与 WS 桥接，不解析业务数据。agent 始终跑在**用户桌面**，桌面不在线 = `connect: device offline`。

**relay 层帧契约**（register/connect/update_code/keepalive/connect_error + 码 TTL/双向活体常量、supersede 与 opt-in 静默语义）；**新增/改帧 = 三端同步**（relay ↔ aide-sdk remote.ts ↔ ohos 镜像）。

## 架构红线：远程工作区（WSL / SSH）——一份实现，两处运行

GUI 永远在桌面；工作区可以住在无 GUI 的目标机（WSL 发行版 / SSH 服务器）。设计全文见 [docs/remote-workspaces.md](docs/remote-workspaces.md)。与上面的「远程控制」（手机遥控桌面）无关。

- **工作区操作只有一份实现**：fs / 搜索 / git / 文件监听 / 会话转录读取在 Tauri 无关的 `src-tauri/crates/aide-workspace`；桌面 `#[tauri::command]` 是一行转调，目标机上的 `crates/aide-host` 分派到同一批函数。**禁止为远程再写第二份**；新代码需要工作区根就显式收 `root`，别在 crate 里认「活动工作区」。
- **新增「按路径操作工作区文件」的命令 = 三处**：aide-workspace 实现 → `aide-host/src/commands.rs` 登记 + 分派 → `src-tauri/src/remote_workspace/routes.rs` 登记路径参数。缺一处，远程工作区里它就回落本机执行（跑错机器）。会在本机起进程操作工作区的命令（LSP / 索引 / 运行配置）遇到远程路径必须**拒绝**，不许回落。
- **远程路径形态唯一真相源** `remote_workspace/path.rs`（`\\wsl.localhost\<distro>\…` / `\\aide-ssh.invalid\<alias>\…`）；前端 `@aide/sdk` 的 `parseRemotePath` 只做显示。
- **「目录还在吗」一律 `remote_workspace::path::present`**：远程路径同步 stat 不了，按存在处理。对远程路径返回 false 会让会话 cwd 静默回落活动工作区——2026-09-18 事故的同一形态。
- **agent 车道**：会话按工作区归属绑定车道（`runtime/remote_lane.rs`），事件泵与本机同一条（`runtime/pump.rs`）；事件里只译**结构化字段**的路径，不改模型正文（正文路径由前端 `resolveFileLinkPath` 按会话工作区解析）。进程级 env 走 `aide-host agent` 首行 stdin，不上命令行（目标机 `ps` 全员可见）。
- **不同步 OAuth 凭据到目标机**（refresh token 轮换会互相顶掉；服务器可能多人共用）。官方账号登录在目标机上跑 `~/.aide/host/aide-claude` → `/login`；API Key 类供应商随 send 下发，无需登录。
- 远程套件：`pnpm build:remote-kit`（aide-host musl 静态二进制 + runtime.js，已挂进 `pnpm release`）；aide-host 必须保持**纯 Rust 无 C 依赖**（一个静态二进制跑遍任意发行版）。

## 架构红线：可替换技术必须藏在端口后面

**凡是「有多个竞争实现」或「成熟度不确定」的第三方技术，一律不许在业务代码里直接引用。** 领域层只定义 trait（端口），实现放适配器层。判据：**这个技术点未来是否可能出现第二个实现，且切换只需替换一个文件？** 有 → 抽象；没有 → **不要抽象**（换 HTTP 框架/ORM 等于重写，抽象层是仪式感债务）。

`knowledge-server/` 是样板：`src/port/`（只定义 trait 与领域类型）→ `src/adapter/`（整个 crate 唯一允许第三方库的地方）→ `src/domain/`（只依赖 port）→ `src/api/`（只依赖 port + domain）。配套约束：按扩展名分派（不写 `if is_docx()`）；同扩展名多后端 = 回退链（新后端先上、老后端兜底是配置问题）；产物类型是领域自己的（不泄漏第三方类型）；降级如实上报（丢失信息进 `warnings`）；CPU 密集端口保持同步（调用方 `spawn_blocking`）；回退留痕。

**验收（进 review checklist）**：grep 第三方库名，`src/adapter/` 之外不允许出现任何 `use`/类型引用/函数调用，注释不算违例。

## ⚠️ Windows 必读坑点：`CREATE_NO_WINDOW`

**所有 `Command::new("git")`（或任何 CLI 工具）必须加 `CREATE_NO_WINDOW (0x08000000)` 标志**，否则 Windows 为每个子进程弹控制台窗口，release 中表现为大量错误弹窗。

```rust
#[cfg(windows)]
use std::os::windows::process::CommandExt;
let mut cmd = Command::new("git");
#[cfg(windows)]
{ cmd.creation_flags(0x08000000); }  // 必须有！
```

涉及：`git.rs`、`marketplace.rs`、`filesystem.rs`、以及未来任何 spawn 外部进程的代码。

## ⚠️ Windows 必读坑点：`resource_dir()` 的 `\\?\` verbatim 路径

**Tauri `resource_dir()` 在 Windows 返回带 `\\?\` 前缀的 verbatim 路径。凡要把这种路径传给外部进程（尤其 `node`），必须先 `dunce::simplified()` 剥掉前缀**，否则 node 的 `realpathSync` 处理不了，会在引导阶段 `EISDIR` 崩溃。典型现象：dev 正常（走 `CARGO_MANIFEST_DIR`），**打包后一发消息就"会话进程已退出"**。Rust 自己 `fs::read` 不受影响——只有传给子进程的才要剥。涉及：`runtime.rs`（`resolve_runtime_path`、`AIDE_CLAUDE_EXE`）。

## 关键约定

- **同步 command 禁止重 IO / 重 CPU**：一律 `async fn` + `spawn_blocking`。两个坑：(1) 带 `State<'_,T>` 引用参数的 async 命令必须返回 `Result`（E0277）；(2) `State<T>` 不能跨 `spawn_blocking`，state 注册成 `Arc<T>` 后 clone 进闭包。
- **`trace_command` 兜底**：保留同步但做 IO/子进程/外部调用的命令，第一行埋 `let _trace = crate::diagnostics::trace_command("函数名");`（在任何 IO/spawn 之前，cfg 分支之前）。**只对同步命令有意义，禁止给 async 命令埋**（guard 在 dispatch 后立刻 drop）。已埋 52 条。决策：重 IO/CPU → async；轻 → 不动；介于之间且保留同步 → 埋。**这条规则由构建期守卫强制**：`pnpm check:sync-io`（已挂进 `pnpm build`）扫描所有同步 Tauri 命令，做 IO/子进程却没埋点的直接报错——未埋点的同步命令卡死时冻结报告 `stuckCommand` 恒为 `None`，肇事者定不到（2026-07 一整轮误判就死在这个盲区）。豁免在 `scripts/check-sync-io-commands.mjs` 登记并写明理由。
- **主题系统是配色的唯一来源**：所有颜色/背景/边框/阴影/圆角/间距必须走 `src/themes/` 语义 token 的 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空。新增语义色 → `ThemeTokens` 加槽位 + 每个主题文件给值；新增主题 → 新增实现 `ThemeTokens` 的文件 + `themes/index.ts` 注册。`colorScheme` 是例外（浏览器原生 `color-scheme` 属性）。
- **VC++ Redistributable 随包分发**（NSIS POSTINSTALL 静默装 vc_redist）：aide.exe 依赖 `MSVCP140.dll`/`VCRUNTIME140.dll`，缺/旧 → 「双击无反应」（C++ 运行库加载阶段崩溃，早于任何 Rust 代码）。

## agent-sidecar 职责边界（engine / extensions / desktop 三层）

sidecar 名义是「引擎副车架」，实际长成了「所有 Node 侧逻辑的家」（50+ 文件，含 docx/pdf 解析、codegraph、automation 等完整产品）。**边界现在开始命名**，新代码按判据归位：

**判据：换一个宿主（如 headless 服务端 agent）还需要的 → engine；只有桌面 UI 需要的 → 留在桌面协议层。**

| 层 | 内容 | 归位 |
|---|---|---|
| **engine 核心** | 会话驱动（`session-worker`/`session-manager`）、权限（`permissions`/`policy`）、事件广播与流式帧（`deltaCoalescer`/`stdoutFrames`）、子代理（`subagents`）、MCP/hooks 装配机制（`userExtensions`）、运行环境（`claudeExe`/`winBashEnv`） | 引擎本体，保持纯净 |
| **extensions**（可选，按宿主装配） | `codegraphTools`、`docsMcp` + `docx/` + `pdf/`（完整 MCP server）、`testMcp`、`skillGuard`/`dispatchPlugins` | 已成型的独立 server 应逐步外迁为独立目录/进程形态（参照 knowledge-server 的 port/adapter 范式） |
| **desktop 语义** | `display` 渲染通道、`jumpQueue` 插队、会话 tab 管理、automation/btw | 只属于桌面协议层，不进 engine |

**规则**：
1. sidecar 新增逻辑先判归——不要默认"跟会话有关就进 sidecar"，先问是不是 engine 职责。
2. 内置 MCP/Hooks 新增必须同步登记前端镜像（`useCustomizations`），这条义务是 extensions 层的现状约束，未来外迁后随迁。
3. 拆分走渐进：新代码守边界，已成型大块（docx/pdf、codegraph）在触碰时顺势外迁，**不做一次性大动刀**（协议双通道契约与测试体系都挂在这个进程上）。
4. headless 引擎组件**已落地**（`src/headless-server.ts` + `--headless` 子命令，PROTOCOL_VERSION=1，2026-09-11 正式验收 P0 清零）：验收台账 [docs/headless-test-checklist.md](docs/headless-test-checklist.md)（smoke-headless-* 家族可复跑）。**机制/策略边界**：引擎提供机制，不认识"租户"——① 会话创建接受任意元数据（hooks 可读、工具调用可注入请求头）；② 事件**按会话路由**（订阅制；桌面版全量转发是多客户端下的泄露隐患，automation 按 sid 路由即此隐含能力，headless 升为契约）。"多租户"是宿主网关的策略（鉴权/会话映射/计费）：网关在会话元数据里塞 token = 单实例多用户；每实例只装一个租户 = 实例级隔离（后者不改 TokenStore 单设备安全模型）。两条路线引擎都支持，靠的只是上述两个机制。
# CLAUDE.md — Aide

非官方桌面应用：Tauri v2 + Vue 3，为 Claude Agent SDK 提供带会话管理和文件树的 Chat 客户端（Node.js sidecar 驱动对话）。

- 栈：Tauri v2（Windows 用 MSVC）+ Vue 3 / TS + Tailwind 3 多主题（全项目三角箭头统一 `font-size: 14px`）。
- 包管理 pnpm workspace（`packages/*` + `remote-pwa`）；**agent-sidecar 刻意不进 workspace**：依赖在子目录独立 pnpm 安装，构建脚本经 `npm --prefix` 执行。
- `packages/aide-sdk`（@aide/sdk）：types + api 门面 + transport + useChatSession，桌面与 remote-pwa 共用，TS 源码直出无构建链。鸿蒙端 `ohos/`（ArkTS）不进 workspace。
- **手机端（remote-pwa / ohos / SDK 的 `remote.ts`）由手机端自己演进，桌面侧不替它改**，只交付协议。

## 已删除，不许复活

桌面网关 v2（`src-tauri/src/remote/`，2026-10-01）· codegraph 代码索引（2026-10-01，要找回用 tag `codegraph-final`；agent 导航只走 aide-lsp + grep 顺带作答 hook）· 远程工作区「逐命令转发 + UNC 路径翻译」（2026-09-30）· headless HTTP/SSE 宿主（2026-09-30）· 配对码路由、`settings.remote.relayUrl`。

## @aide/sdk：能力单一事实源

桌面（Tauri IPC）与手机共用同一套能力实现，**禁止再开第二份平行实现**：

- 传输层 `AideTransport { invoke, listen }`：共享代码只调 `getTransport()`，**禁止直接 import `@tauri-apps/*`**（`check:tauri-imports` 兜）。所有命令调用只走 api 门面（`api.ts` + `api/*`），不写散 invoke。
- **手机能调什么 = `crates/aide-link/src/catalog.rs` 的暴露目录**（整张表即远程暴露面，命令名 = Host 命令表里的命令，零包装；远程专属预处理只在目录的 `prepare` 一处）。Link 事件目录只有 `chat-event` / `system-notification` / `permissions-changed`。
- 共享代码搬动后桌面旧路径留 re-export 壳；测试 mock 边界一律指 `@aide/sdk/api`（不是 `@/api`——壳与包内模块实例不同，mock 壳会漏）。

## 红线：跨平台

主力是 Windows，但新代码必须兼容 macOS/Linux：路径用 `PathBuf`/`path.join`；平台特有逻辑（`creation_flags`、Windows 句柄类型、仅 Windows 存在的 crate API）必须 `#[cfg(windows)]` 隔离；dev.ps1 / dev.sh 功能对等；测试不许写死平台（用 `std::env::consts::OS`）。

macOS 已踩的坑：`objc2` 不单独声明（由 `objc2-app-kit` / `objc2-foundation` 0.2.x 传递引入，错一代就编不过）；`Notification::app_id` 仅 Windows 存在，通知身份走 `host_door::apply_notification_identity`；`NSArray::iter` 要开 `NSEnumerator` feature。

## GitHub 公开镜像与 CI

- **Gitee（`origin`）是完整历史；GitHub（`github`，公开）是清洗后的镜像，只经 `scripts/publish-github.sh` 同步，禁止直接 `git push github`**（会公开未清洗的历史）。需 `git-filter-repo`；`--dry-run` 只清洗扫描。
- 清洗规则（`rules.txt` / `mailmap.txt` / `forbidden.txt`）放 `~/.config/aide-publish/`，**不进仓库**（规则本身含要抹掉的字符串）。清洗确定性，日常快进；规则改了才需 `--force`；清洗后扫全历史，命中 `forbidden.txt` 即中止。
- 仓库里不要写真实隧道 UUID / 镜像仓库账号 / 内网 IP / 个人邮箱或本机路径；新增敏感类型时同步改规则与 `forbidden.txt`。
- CI（`.github/workflows/ci.yml`，仅 GitHub 触发）在 **macOS** 跑 frontend / rust crates（aide-workspace、core、link、host）/ sidecar / tauri-shell（`cargo check`）——跨平台红线靠它兜底，**Windows 暂无 CI**。CI 需还原本地依赖布局：根 vitest 含 `agent-sidecar/src/**`，要装 sidecar 依赖；`jsdom` 只在根 package.json；macOS bundle 资源 glob 要 `pnpm --dir agent-sidecar install`。

## 红线：多端一致性（命令 / 事件双通道）

桌面、remote-pwa、鸿蒙共享同一会话。**UI 状态只认事件通道，不认本地乐观更新。** 命令通道（UI → sidecar 单播：`send` / `permission_response` / `interrupt`…）；事件通道（sidecar → **所有** UI 广播：`permission_request` / `user_message` / `permission_cancelled` / `jump_promoted`…）。任何"某客户端做了操作"要反映到其他客户端，必须由 sidecar 广播事件——新增会改变对话状态的命令时问一句"别的客户端怎么知道？"。

- **会话元数据落盘**（名字/模型/档位/provider/工作区归属）必须等 `session_init` 定名（`finalizeSession` → `onSessionCreated`）；早到的值暂存、随注册表搬迁（pendingTitles / `identity.migrateBinding` / `useSessionWorkspaces().migrate`）；判据用 `finalizedSids`，**不用「本端是否 pending」**。
- **工作区归属是会话自持属性**：`wsPath`/`wsKey` 落 `~/.aide/sessions/<id>.json`，唯一入口 `set_session_workspace` / `session_workspace`。send 的 cwd 解析只有三级：客户端 `workspaceRoot` → 档案 `wsPath`（须 `exists`）→ **活动工作区 + `tracing::warn`**；末级就是"跑错项目"的来源，**不许无声**。前端 `useSessionWorkspaces` 只是可回种的缓存，别造第三份来源。
- **用户气泡只认 sidecar 广播的 `user_message`**，不本地渲染；**禁止加"超时兜底本地渲染"**（jumpQueue 排队消息会误触发）。插队消息在 promote 时广播。
- **`permission_cancelled` = 「这条请求已终结」**（批准/拒绝/abort/连带放行都发），不是"被取消"。`permissions.ts` 的 `resolve()` 无条件发，新增任何终结挂起请求的路径都要发。
- 事件到手机按订阅投递（`subscribe` 可按会话过滤、`since` 续传）。
- **`display` 渲染描述通道**：`prompt` 是 @引用展开后的纯文本、sidecar 无法还原「正文/引用卡片/动作胶囊」边界，所以渲染信息随 send 下发再回灌（Rust `attach_display` 原样搬运不校验）。**⚠️ `UserMessageBlock` 在 `agent-sidecar/src/types.ts` 与 `packages/aide-sdk/src/types/chat.ts` 各一份且必须同形**，漂移会让 display **静默失效**；新增 block 形态两边一起改。display 缺失/未知 → 降级成纯文本或跳过该块，**整条消息不能消失**。
- **知识库圈选编辑（`kbref`）= 授权，不是引用**：用户在文档里圈的范围经 `display` 的 `kbref` 块进 sidecar，登记进 `KbScopeStore`（`extensions/knowledge/scope.ts`，按最新一条用户消息整表替换）；agent 只能 `edit_selection(selectionId,newText)` 改那一段（没有范围参数），圈选生效期间其余知识库写工具一律被拒。两份 `UserMessageBlock` 同形由 `userMessageBlockParity.test.ts` 对账。设计见 docs/superpowers/specs/2026-10-02-kb-selection-edit-design.md。
- **@引用行号区间**（`@path:12-48`）解析唯一真相源 `packages/aide-sdk/src/utils/fileMentions.ts`；省 token 靠发送前切片注入；引用读**磁盘内容**（未保存的编辑不在里面）。

## 红线：语言无关（LSP）

Java/jdtls 专属配置**只准**在 `aide-core/src/lsp/profiles/java.rs`；公共层（`manager.rs` / `mod.rs` / `protocol.rs` / `cmLsp.ts`）必须语言无关，新命令按文件扩展名分派（`lang_from_ext_of`）。

- **扩展名三条轴别混用**：服务归属 `LanguageId::from_ext`（唯一权威表；`.vue`/`.tsx` 归 TypeScript、`.jsx` 归 JavaScript，**没有独立的 vue 语言**）；文档 languageId `document_lang_id`（`.vue` 发 `"vue"`、`.tsx`/`.jsx` 发 `*react`）；探针靶子 `probe_exts`（只递 server 原生能解析的形态）。语言探测必须下钻。前端影子表 `src/utils/lspLang.ts` 与 `from_ext` 同步（`check:lsp-parity` 兜）。
- **TS 的 typescript SDK 由 `lsp/profiles/ts_sdk.rs` 解析后经 `initializationOptions.tsserver.path` 递进去**（TLS 只在工作区根及祖先找 SDK；路径须平台原生分隔符）。**且恒发 `disableAutomaticTypingAcquisition: true`**：否则 tsserver 会在用户工作区跑包管理器装 `@types/*`，实测把 `frontend/` 的顶层依赖挪进 `node_modules/.ignored/` 让前端跑不起来，用户既没批准也不可见。
- **agent 的 LSP 工具每一发都必须比 grep 值**：定义带函数体、引用带行文本与所在函数、没答上时同一发给文本兜底（标 UNVERIFIED）；grep 顺带作答 hook（`lspGlance.ts`）**未命中必须廉价**（预算 1.5s + 负缓存）；按名查询命中要挪到名字本身（`agent_nav::refine_to_name`，否则查的是 `export` 关键字 → 假「确认没有」）。

## 红线：远程控制是单设备模型（刻意设计，改前先确认）

`aide-link` 的 `Identity` 只存**一把**已配对的手机公钥——**新设备配对 = 覆盖旧公钥 = 旧设备被踢（`bye{superseded}`）**。这是安全设计；改成多设备共存是**安全降级**（二维码泄露后恶意设备静默共存）。

- **中继地址是产品内置固定值**（`aide-core/src/link/mod.rs` 的 `DEFAULT_RELAY_URL` = `wss://relay.aideai.store`）：不是设置、UI 不展示；唯一覆盖口是环境变量 `AIDE_RELAY_URL`。
- **relay（`relay-server/`）是不被信任的哑管道**：只按 `device_id` 做 WS 桥接，业务数据端到端加密；Host 不在线 = `connect_error{device_offline}`。改 relay 帧 = 改 `relay-server/src/protocol.rs` + `docs/aide-link-protocol.md` §2.2，并告知手机端。
- **手机 ↔ Host 协议 = Aide Link**（[docs/aide-link-protocol.md](docs/aide-link-protocol.md)）：协议本体、帧、暴露目录、配对规则只改 `crates/aide-link`，同步 `docs/aide-link/frames.d.ts`（有对账测试）并补 `tests/fixtures/` 一致性向量；Host 端网关在 `aide-core/src/link/`（`link_*` 命令是 Host 设置面板用的，不对手机开放）。**配对靠扫二维码**（Host 公钥 + 一次性 psk），帧经 Noise 端到端加密，手机静态密钥即凭据——别退回短码 / 明文。本地测试 Host：`cargo run -p aide-link --features transport --example test_host`。

## 红线：Host 模型——一张命令表，多个前门

**一个 Host = 一整个 Aide 后端**（会话 / agent / 文件 / git / 终端 / LSP / 插件 / 记忆 / 供应商），GUI 只是连到某个 Host 的屏幕；**一个窗口 = 一个 Host**（本机 / WSL / SSH）。**没有「主窗口」**：窗口连着谁是它当下的属性，可换（`switch_window_host`）；标签 `main` 只是身份，**禁止用标签判断「是不是本机」或「该唤起谁」**——一律问 `host_window::current_window` / `local_window`。设计、守护进程、`resume`、`ServeInit` 协议见 [docs/host-model.md](docs/host-model.md)。

- **命令唯一实现 = `crates/aide-core` 的命令表**（Tauri 无关）：本机窗口由 `src/host_door.rs` 进程内直调，Host 窗口由 `host_door::forward` 转发。已迁入的命令**不写 `#[tauri::command]`**；新命令按 docs/host-model.md §4；**禁止再开平行分派**。
- **Host 自持状态住 `aide_core::Core`**，宿主能力经端口注入（`EventSink` / `HostResources` / `AgentHooks`）。**aide-core 禁止依赖 Tauri**，且与 aide-host 同守「无系统 C 库、单静态二进制」（crate 自带源码的 C/汇编如 ring 允许；要目标机装 `.so`/头文件/pkg-config 的依赖一律禁止）。Host 不弹系统通知：`Core::notify` 发 `system-notification`，由 GUI 前门弹。
- **事件总线是 Host 自己的**（`aide_core::bus`）：编号、留底、按会话订阅、断线回放。**新的多客户端出口一律实现 `bus::Consumer`，别再造平行广播。**
- **事件隔离两头做**：后端只 `emit_to` 对应窗口（`src/host_window.rs`）；前端监听一律窗口作用域（`TauriTransport.listen`），**共享代码里不要用 Tauri 默认的全局 `listen`**（WSL 窗口会看到本机会话的 chat-event）。
- **GUI 与 Host 之间的跨界必须显式、用户看得见**：本机文件进对话 = 上传到 Host 暂存（`upload_local_files`）；「用本机程序打开」对 WSL 路径译成 `\\wsl.localhost\…`、SSH 如实拒绝（`host_window::gui_path`）；「从本机复制供应商」是显式动作，不自动同步。
- **供应商 / 插件 / MCP / hooks / 记忆都按 Host 自持**（各装各的 `~/.aide`）。**不同步 OAuth 凭据**（refresh token 轮换会互相顶掉）；官方账号登录在目标机上跑 `~/.aide/host/aide-claude` → `/login`。
- **Host 的启动职责只写在 `aide_core::host`**（`prepare_workspace` + `start`），桌面 setup 与 `aide-host serve` 都调它，**不许只写在某一扇前门里**（2026-09-30 事故：serve 漏了日常目录引导，WSL 会话 cwd 不存在，SDK 还误报成 libc 不匹配）。
- **「目录还在吗」一律 `aide_core::workspace::present`**：误判 = 会话 cwd 回落活动工作区 = 「跑错项目」。
- 远程套件 `pnpm build:remote-kit`（aide-host musl 静态二进制 + runtime.js，已挂进 `pnpm release`）；真机回归 `src/remote_workspace/e2e_tests.rs`（运行方式见文件头）。

## 红线：可替换技术必须藏在端口后面

「有多个竞争实现」或「成熟度不确定」的第三方技术，不许在业务代码里直接引用：领域层只定义 trait（端口），实现放适配器层。判据：**未来是否可能出现第二个实现、且切换只需替换一个文件？** 有 → 抽象；没有 → **不要抽象**（换 HTTP 框架 / ORM 等于重写，抽象层是仪式感债务）。样板 `knowledge-server/`：`port/` → `adapter/`（整个 crate 唯一允许第三方库的地方）→ `domain/` → `api/`；按扩展名分派、同扩展名多后端 = 回退链、降级如实上报（进 `warnings`）、CPU 密集端口保持同步。**验收**：grep 第三方库名，`adapter/` 之外不许有 `use`/类型引用/函数调用（注释不算）。

## ⚠️ Windows 必读坑点

- **`CREATE_NO_WINDOW`**：所有 `Command::new(...)` 必须 `#[cfg(windows)]` 下加 `creation_flags(0x08000000)`（`use std::os::windows::process::CommandExt`），否则每个子进程弹控制台窗口，release 里表现为大量错误弹窗。
- **`resource_dir()` 的 `\\?\` verbatim 路径**：传给外部进程（尤其 `node`）前必须 `dunce::simplified()`，否则 node 的 `realpathSync` 引导阶段 `EISDIR` 崩溃——**dev 正常，打包后一发消息就"会话进程已退出"**。涉及 `host_door.rs` 的 `DesktopResources`。
- **VC++ Redistributable 随包分发**（NSIS POSTINSTALL 静默装）：缺/旧 → 「双击无反应」（运行库加载阶段崩溃，早于任何 Rust 代码）。

## 关键约定

- **同步 command 禁止重 IO / 重 CPU**：`async fn` + `spawn_blocking`（带 `State<'_,T>` 引用的 async 命令必须返回 `Result`；`State<T>` 不能跨 `spawn_blocking`，注册成 `Arc<T>` 后 clone 进闭包）。保留同步但做 IO 的命令，第一行埋 `let _trace = crate::diagnostics::trace_command("函数名");`，**禁止给 async 命令埋**；`pnpm check:sync-io`（挂在 `pnpm build`）强制，豁免在 `scripts/check-sync-io-commands.mjs` 登记并写理由。
- **主题系统是配色唯一来源**：颜色/背景/边框/阴影/圆角/间距一律走 `src/themes/` 的 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空。新增语义色 → `ThemeTokens` 加槽位 + 每个主题给值；新增主题 → 实现 `ThemeTokens` + `themes/index.ts` 注册。

## agent-sidecar 职责边界

**判据：换一个宿主（WSL / SSH 目标机上的 Host）还需要的 → engine；只有桌面 UI 需要的 → 桌面协议层。**
- **engine**（保持纯净）：会话驱动（`session-worker`/`session-manager`）、权限（`permissions`/`policy`）、事件广播与流式帧、子代理、MCP/hooks 装配（`userExtensions`）、运行环境（`claudeExe`/`winBashEnv`）。
- **extensions**（可选，按宿主装配）：`docsMcp` + `docx/` + `pdf/`、`testMcp`、`skillGuard`/`dispatchPlugins`；已成型的独立 server 在触碰时顺势外迁（参照 knowledge-server 的 port/adapter），**不做一次性大动刀**。
- **desktop 语义**：`display` 通道、`jumpQueue`、会话 tab 管理、automation/btw——不进 engine。

新增逻辑先问是不是 engine 职责，别默认"跟会话有关就进 sidecar"。内置 MCP/Hooks 新增必须同步登记前端镜像（`useCustomizations`）。引擎提供机制、宿主决定策略（browser facade / browser_agent 即此口径）。

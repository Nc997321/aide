# Host 模型：后端整体跑在 Host 上，GUI 只是屏幕

> 状态：P0、P1（含 P1e）、P2、P3a（Host 常驻守护进程）已落地（2026-09-30）——本机与 WSL / SSH 都是 Host，一个窗口连一个；远程 Host 是常驻守护进程，连接断了会话还在。手机直连 Host（Aide Link）已落地，旧桌面网关已退役；手机端迁移由手机端自己推进。

## 1. 产品模型

**一个 Host = 一整个 Aide 后端**：会话与转录、agent 进程、文件 / git / 终端 / LSP / 索引、MCP / hooks / 插件、记忆、权限策略、模型与供应商绑定。**GUI = 连到某个 Host 的一块屏幕**（VS Code Remote 同款心智）。

- Host 有三种：**本机**、**WSL: <发行版>**、**SSH: <主机>**。本机不特殊，只是零距离的 Host。
- **一个窗口 = 一个 Host**（已拍板）。要多个 Host 就开多个窗口；同窗混用会把「这次在哪跑」的边界问题带回来。
- 「在哪执行」只在**连接时决定一次**，功能本身不知道也不关心——这从结构上消灭了「跑错机器 / cwd 静默回落本机」这一整类事故（2026-09-18）。

### 边界：谁归 Host，谁归 GUI

| 归 Host（跟着世界走） | 归 GUI（跟着人走） |
|---|---|
| 会话、工作区、CLAUDE.md、记忆 | 主题、布局、窗口、快捷键 |
| agent、MCP、hooks、插件 | Host 列表（连接方式） |
| 文件 / 搜索 / git / 终端 / LSP / 索引 | 剪贴板、拖拽、系统文件选择器 |
| 权限策略、模型与供应商绑定 | 通知、内嵌浏览器、用本机程序打开 |

GUI 独有的动作要**显式跨界且用户可见**：粘贴截图 / 拖入本机文件 = 上传到 Host；「在资源管理器中打开」对 WSL 路径做路径翻译，SSH 如实拒绝。

### 两条纪律（验收标准）

1. **只有一套模型**：旧的逐命令路由（`routes.rs` 的转发与路径翻译）已删除，不许复活，不许两种「远程」并存。
2. **本机零退化**：本机 Host 在桌面进程内直调，不绕传输层；本机模式的速度与体验不得比迁移前差。

## 2. 架构：一张命令表，多个前门

```
主窗口  invoke ─ host_door::dispatch ─▶ ┌──────────── aide-core ────────────┐  本机 Host（进程内）
                                         │ registry: 命令名 → handler         │
Host 窗口 invoke ─ host_door::forward     │ Core: 工作区 · 设置 · runtime · LSP │
          ─ stdio(wsl/ssh) ─ aide-host serve ─▶ 同一个 aide-core            远程 Host（目标机）
```

- **`crates/aide-core`**：Tauri 无关。`Core` 持有 Host 自持状态（活动工作区等）与事件出口 `EventSink`；`registry` 是命令表 = Host 的全部能力面（可审计）。命令名 = 前端 invoke 名，参数 = invoke 原样 JSON。处理器一律 async，阻塞 IO 经 `blocking` 离开异步线程。
- **桌面前门** `src-tauri/src/host_door.rs`：invoke 链 `host_door::forward`（Host 窗口 → 它那台 Host 的 serve）→ `host_door::dispatch`（本机窗口 → 进程内 core）→ Tauri 命令表（GUI 能力）。已迁入 core 的命令不写 `#[tauri::command]`、不进 `generate_handler!`。事件出口 `TauriSink` 只 `emit_to` 本机窗口；serve 的通知只 `emit_to` 该 Host 的窗口（`src/host_window.rs`）。
- **远程前门** `aide-host serve`：首行 `ServeInit`（协议 v4），`invoke` 方法查同一张表；二进制结果包成 `{"$bytes": b64}`。serve 就是一个完整 Host：agent runtime / 自动化 / LSP 都在它里面，进程整体跑在用户登录环境里。aide-host 以 musl 静态链接嵌入 aide-core，故 **aide-core 与 aide-host 同守「不依赖系统 C 库、单静态二进制」**（crate 自带的 C/汇编如 ring 可静态编入，2026-09-30 定）。
- **agent 引擎**（Node sidecar）仍是 Host 的子进程，stdin/stdout 协议不变。

### 事件契约（P3a 兑现）

多个窗口 / 手机可能连同一个 Host。守护进程的事件中心（`crates/aide-host/src/hub.rs`）给每个事件编全局序号并留底，按**会话订阅投递**：`chat-event` 只送订阅了该会话的客户端，不带会话号的事件（文件变更 / LSP / 系统通知…）全送；默认订阅全部（桌面行为不变）；回放也按订阅过滤，受限订阅者重连看不到别的会话。本机进程内 Host 仍是桌面 `TauriSink` 的全量 `emit_to` 本机窗口（没有多客户端）。

**常驻 Host 的生命周期**：窗口的最后一扇关掉 = 桥断开，守护进程**留着**（会话继续跑完，下次连上还在），无客户端且静默超过宽限才退。WSL 注意：Windows 在没有 `wsl.exe` 进程时会让发行版空闲关机（守护进程随之消失，重连时按「Host 重启」如实报断开）；要让 WSL Host 长驻需开 systemd 或自行保活。孤儿守护进程被 WSL 的 `/init` 收养、退出后留一个无害的僵尸，随虚拟机重启消失。

## 3. 迁移阶梯

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0-1 | aide-core 骨架（Core / EventSink / registry）+ fs / 搜索 / git 51 条命令迁入；桌面与 aide-host 共用，删除两份平行分派（Tauri 薄包装 + `git_dispatch.rs`） | ✅ 2026-09-30 |
| P0-2 | 文件监听迁入（首个经 `EventSink` 推事件的能力）：`file_tree_watch` 成为 core 命令；aide-host 的通知帧 = Core 事件原样外送，专用 `watch` 方法删除（协议 v2，桌面握手强校验版本） | ✅ 2026-09-30 |
| P0-3a | 地基迁入：Host 数据目录布局（`paths`）、分层设置服务（`settings`，密钥端口 `SecretStore`：桌面 = OS 钥匙串，远程 = 内存）、`app_settings` + state.json、权限策略（`policy`）、JDK 扫描；`get_settings` / `set_settings` / `scan_jdks` / `resolve_jdk` 成为 core 命令；手机远程 RPC 白名单新增 `CORE_EXPOSED`（只登记名字，执行走 core 表） | ✅ 2026-09-30 |
| P0-3b | 前端命令按模块迁入：会话档案 / 会话域（18）/ 会话变更 / 最近 / 通知 / 迁移 / 知识库配置 / 引导 / 定制项（32）/ 工作区（14）/ 记忆观测 / 运行配置 / 插件市场（9）。「工作区还在吗」统一为进程级注入判定 `aide_core::workspace::present`；key 解码补 Unix 形态。旧模型的远程会话分支集中到 `remote_workspace::sessions`（两个前门共用 `route`）。手机远程 RPC 的对应包装全部改为 `CORE_EXPOSED` 登记 | ✅ 2026-09-30 |
| P0-3c | 供应商层迁入 `aide_core::provider`（HTTPS = ureq + rustls，ring 静态编入——2026-09-30 定：约束改为「不依赖系统 C 库」）；12 条供应商命令 + `detect_available_proxy` 成为 core 命令；provider catalog **编译进二进制**（删除资源目录注入）；扩展 trait `ProviderSettings` 删除 | ✅ 2026-09-30 |
| P0-4a | 终端（PTY 6 + 运行进程 2）+ 技能扫描迁入，`Core::pty`；远程工作区终端改为过渡钩子 `terminal::set_remote_shell` | ✅ 2026-09-30 |
| P0-4b | CodeGraph 迁入 `Core::codegraph`；Core 增**资源端口** `HostResources`（随包二进制 / 目录由前门回答：桌面 = Tauri 资源目录 / dev 源码树，aide-host 暂 `NoResources`，如实报错） | ✅ 2026-09-30 |
| P0-4c | LSP 迁入 `Core::lsp`（20 条编辑器命令 + workspace_symbol）；事件经 `EventSink`、捆绑 server 经 `HostResources::lsp_dir`；旧模型远程 LSP 经过渡端口 `lsp::remote`（桌面 `remote_workspace/lsp_bridge.rs`） | ✅ 2026-09-30 |
| P0-4d | agent runtime 迁入 `Core::runtime`（sidecar 进程 / 事件泵 / 会话表 / 后台任务表 / Windows Job Object）；chat（12）/ 权限（6）/ 信任（2）/ session_alive / 通知上下文 / 后台任务快照 / MCP 探活成为 core 命令。宿主端口：`runtime::ports::AgentHooks`（GUI 侧：内嵌浏览器查询 / 冻结诊断 / 自动化观测，桌面注入）与过渡端口 `LaneRouter` / `LaneAdapter`（旧模型远程车道，桌面 `remote_workspace/lanes.rs`）。权限模式默认表编译进二进制。手机 RPC 对应包装改为 `CORE_EXPOSED`（send_message 保留远程权限模式兜底的薄预处理） | ✅ 2026-09-30 |
| P0-4e | automation（11）迁入 `Core::automation`：调度器常驻 Host，运行 / 蒸馏直接写 `Core::runtime`，自动化观测回到事件泵内部。系统通知改为 Host 事件 `system-notification`（`Core::notify`），由 GUI 前门弹出（桌面 = `TauriSink` 转系统通知）——Host 不弹窗、也不带 D-Bus | ✅ 2026-09-30 |
| P1a | `aide-host serve` 成为完整 Host：首行 `ServeInit`（协议 v3）；进程整体切到用户登录环境；`HostKit` 资源（套件里的 runtime.js + 登录 PATH 的 node + 套件的 claude CLI）；agent runtime 与自动化随 serve 起、随断开收；**供应商按 Host 自持**（2026-09-30 定），密钥落 Host 的 `~/.aide/secrets.json`（0600，`FileSecretStore`）；首条消息先于 runtime 拉起时 `send_message` 就地拉起。真机 e2e：前端同一个 `send_message` 发给 serve，Bash 在 WSL 上按会话 cwd 跑、chat-event 经通知帧回来 | ✅ 2026-09-30 |
| P1b | 桌面「窗口 ↔ Host」绑定（`src/host_window.rs`）：`open_host_window` / `current_host`；Host 窗口的 core 命令由 `host_door::forward` 原样转发给该 Host 的 serve（`$bytes` 还原原始字节），GUI 命令留本机；事件隔离两头做——后端本机 Core 事件只 `emit_to` 本机窗口、serve 通知只 `emit_to` 该 Host 的窗口，前端 `TauriTransport.listen` 改为窗口作用域（Tauri 默认 Any 监听会收到发给任何窗口的事件）；Host 窗口关闭 = 真关，最后一扇关掉即断开（serve 退出，Host 上的 runtime / LSP 随之收掉）；capabilities 放行 `host-*` | ✅ 2026-09-30 |
| P1c | 前端与跨界动作：打开目录对话框——本窗口 Host 的目录就地选（Host 窗口列 Host 自己的文件系统），别的机器 =「在新窗口中打开」（`open_host_window`，可带 Host 原生目录，新窗口经 `?openFolder=` / `host-open-folder` 直接打开）；旧版登记的 `\\wsl.localhost\…` 工作区点开即进它的 Host 窗口；标题栏标 Host；终端 shell 名与 xterm 的 ConPTY 判定跟 Host 的系统走；供应商设置里「从本机复制供应商」（按 id 合并，本机覆盖同 id，含密钥）；「用本机程序打开 / 在资源管理器中显示」对 WSL 路径做翻译、SSH 如实拒绝；剪贴板文件 / 粘贴截图 / 拖入的本机文件经 `upload_local_files` 上传到 Host 暂存（`stage_dropped_file` 成为 core 命令）；Host 的 agent 用内嵌浏览器见 P1e | ✅ 2026-09-30 |
| P1d | 删除旧模型：`routes.rs`、车道（`lanes.rs` + `runtime::ports::{LaneRouter,LaneAdapter}`）、`lsp_bridge` / `lsp_pipe` + `lsp::remote`、`sessions.rs` 路由、扩展镜像 `mirror.rs`、终端远程钩子、「目录还在吗」注入钩子、UNC 路径互译；aide-host 的 `agent` / `lsp` 模式与 `transcript_*` / `lsp_detect` 命令（协议 v4：`invoke` 去掉 `root`）。真机 e2e 改为全部经 serve：工作区操作 + 上传暂存、一轮真实会话、Host 里的 rust-analyzer（文档符号 + 跳定义）。旧版登记的 UNC 工作区条目点开进它的 Host 窗口 | ✅ 2026-09-30 |
| P1e | 内嵌浏览器按窗口分属：`BrowserFacade::new(app, 窗口)` 作用域到调用窗口，注册表记每个视图的属主（别窗口的 id = 不存在，列表 / 读写 / 引擎 IO 都先认属主），`browser-nav/view/focus` 一律 `emit_to(属主窗口)`，前端 `useEmbeddedBrowser` 改窗口作用域监听，窗口销毁回收名下视图；Host 窗口里 agent 的 `browser_query` 在连着那台 Host 的窗口里执行（`browser_agent::answer`）、经 `agent_tool_result` 回到 Host；本机 Host 的 agent 用主窗口（`LOCAL_WINDOW`） | ✅ 2026-09-30 |
| P2a | SSH 真机验证：安装 / serve 握手 / fs · 上传 · 监听 · git / Host 里的 rust-analyzer 经真实 SSH 全部通过（e2e 用例按 `AIDE_E2E_SSH` / `AIDE_E2E_WSL` 选目标）。**已知缺口：SSH 不转发桌面回环代理**（服务器到不了桌面的 127.0.0.1），目标机无直连网络时 agent 一轮会话 403——见下方「SSH 代理」 | ✅ 2026-09-30 |
| P2b | 断线可见 + 手动重连：`HostConnection` 的 `on_closed` 回调 → 注册表把 Host 标成「已断开」（`dropped`），**不再静默懒重连**（重连 = 全新 serve，进行中的会话早已随旧 serve 收掉）；`remote-workspace-status` 事件 + 合成 `runtime_dead` 帧投给该 Host 的窗口；SDK 的 `runtime_dead` 处理收掉所有正忙会话（本机 runtime 死亡同样受益）；Host 窗口顶部状态条「重新连接」= 显式连接 + 重载窗口 | ✅ 2026-09-30 |
| P2c | Host 启动页：标题栏的 Host 标签（本机窗口也有）点开 `HostLauncherDialog`——列本机 / WSL 发行版 / SSH 主机（含手输与用过的）、连接状态实时更新、各 Host 的最近项目，点一下进它的窗口（项目直接打开）。**最近项目是桌面自己记的**（`host_recents.rs`，`~/.aide/gui/host-recents.json`，GUI 数据不属于 Host）：App 的活动工作区一变就记一笔，Host 由**调用窗口**定、前端不传；不连接任何 Host 就能列。`open_host_window("local")` = 聚焦主窗口 | ✅ 2026-09-30 |
| P2d / P3a | **Host 常驻守护进程**：`aide-host daemon`（一个用户一个，`flock` 单例，`~/.aide/host/daemon.sock` 0600）持有 Core；`serve` 退为桥（协议 v5）。事件中心 `hub.rs`：全局序号 + 环形缓冲（16MiB / 5 万条）+ 按会话订阅投递；断线重连带 `resume{daemon_id, seq}` 回放错过的事件（缓冲覆盖不到报 `gap`，守护进程换了报 `resumed:false`）。桌面 `RemoteWorkspaces`：桥断 → `reconnecting` 自动退避重连 → 无缝 / `resync`（会话在、界面需重载）/ 断开（Host 重启，会话已没）。空闲退出：无客户端且静默超 `AIDE_HOST_IDLE_SECS`（默认 30 分钟，chat 事件算动静）。真机 e2e：杀桥后接回同一守护进程、断线期间的事件回放、一轮真实会话经守护进程 | ✅ 2026-09-30 |
| P3b-1 | **Aide Link 协议**（手机 ↔ Host）：`crates/aide-link`——帧（`frame.rs`）、暴露目录（`catalog.rs`，整张表即远程暴露面，`link.describe` 在线可查）、安全通道（`secure.rs`：Noise `IKpsk2` 配对 / `IK` 重连，X25519 + ChaChaPoly，帧分块加密，中继只见密文）、**扫二维码配对**（`identity.rs`：Host 密钥 + 一次性 32 字节 psk + 单设备手机公钥，没有配对码、没有 token）、协议栈 `connection.rs`（握手 → 加密 → 会话）+ 传输无关的会话状态机（`session.rs`：hello → call / subscribe（按会话 + `since` 续传）/ ping / bye）、Host 端口（`Backend` 语义）、参考客户端 `client.rs`。成文规约 [aide-link-protocol.md](aide-link-protocol.md) + TypeScript 声明 `aide-link/frames.d.ts`（对账测试）+ 28 条语言无关对话向量 + 逐字节 Noise 向量（`tests/fixtures/`，手机端可自测）。中继改为只按 `device_id` 路由（P3b-2 改 relay 的 register）。**手机端代码不动**，只交付协议；旧 v2 网关继续服务现有手机端 | ✅ 2026-09-30 |
| P3b-2 | **Host 侧接入**：事件总线搬进 aide-core（`Core::bus`，`bus.rs`：编号 / 环形缓冲 / 按会话订阅 / 回放；`Core::new` 把前门的 `EventSink` 包一层，本机与远程 Host 共用，aide-host 的桥与 Link 都是总线消费者）；Link 网关在 aide-core（`link/`：`LinkService` 随 `host::start` 启动，身份 / 配对状态落 Host 密钥库，按内置中继地址（`link::DEFAULT_RELAY_URL`，2026-10-01 起固定、不是设置，仅 `AIDE_RELAY_URL` 环境变量可覆盖）出站注册，启用的 Host 不空闲退出；`CoreBackend` 接命令表——目录里每个方法都校验存在于命令表——与总线）；`link_status` / `link_set_enabled` / `link_create_offer`（含 SVG 二维码）/ `link_cancel_offer` / `link_revoke` 是 Host 命令（**不对手机开放**），Host 窗口设置面板的「手机连接」管**那台 Host**的网关；`get_active_workspace` 成为 core 命令；aide-link 传输适配器 `transport/{driver,direct,relay}`（中继适配器的 Connection 可重启——中继重新挂起 Host 连接而不通知）；中继 `register` 的配对码改为可选；本地测试 Host `aide-link/examples/test_host`；真守护进程 + 真中继 + 参考手机的端到端（扫码配对 → 调真实命令 → 撤销被踢） | ✅ 2026-10-01 |
| P3b-4 | **窗口可换绑、没有主窗口**（2026-10-01）：窗口 ↔ Host 的绑定本来就是 `HostWindows` 里一张按标签的表，这里把它做成可改——`switch_window_host`（「在此窗口中打开」）改绑 + 重载页面；`main` 不再等于本机：本机 Host 的窗口由 `local_window` 解析（没有就新开 `local-…` 窗口），托盘 / 二次启动 / 通知点击 / 关闭语义都按「当前窗口」（`current_window`，最近获得焦点）；远程窗口的「打开目录」里「本机」也是一台普通的别的 Host | ✅ |
| P3b-3 | **退役旧 v2 网关**（2026-10-01，用户拍板直接退役）：删除 `src-tauri/src/remote/`（auth / protocol / relay_client / rpc / handlers）、`commands/remote.rs` 与四条 `remote_*` Tauri 命令、v2 集成测试；设置里的 `remote.enabled` / `remote.deviceId` 删除（`relayUrl` / `permissionMode` 留给 Link）；`AgentRuntimeManager` 里只给旧网关用的 chat-event 广播通道删除（总线取代）；dev 构建不连中继的闸门挪到桌面前门、经 `LinkService::set_relay_allowed` 交给 Link（`LinkStatus.relaySuppressed` 让面板如实说明）；启动时清掉旧网关留在密钥库里的 `remote/token`；设置面板的旧「配对码 / 吊销设备」整段删除；中继（relay-server）删除配对码路由（`register.pairing_code` 忽略、`update_code` 不再识别、`connect{code}` 恒 `unknown_code`）。**手机端（remote-pwa / ohos / SDK `remote.ts`）未动**——它们说的是已退役的 v2，迁到 Aide Link 之前连不上 | ✅ 2026-10-01 |


## 4. 新增 / 迁移一条命令

1. 在 `crates/aide-core/src/commands/<模块>.rs` 写 `async fn(Arc<Core>, Args) -> Result<T, String>`，分表里 `command!("名字", 函数)` 登记（原始字节用 `command!(bytes …)`）。
2. 需要工作区根：参数收可选 `cwd`，用 `core.workspace.root_for(cwd)`（进程 cwd 类）或 `active_root()`（展示 / 索引类，绝不回退家目录）。
3. 删掉桌面对应的 `#[tauri::command]` 与 `generate_handler!` 条目。aide-host 自动获得该命令。
4. 需要 GUI 能力（弹窗、剪贴板、本机程序、内嵌浏览器）的不是 Host 命令：留在桌面，跨界处显式（见 `src/host_window.rs`）。

## 5. SSH 代理（已拍板：不由 Aide 转发）

WSL 窗口的 Host 能出网，是因为桌面把本机代理（loopback）改写成 WSL 默认网关地址注入 Host 环境；
SSH 目标上没有通往桌面回环的路，`install::host_env` 丢弃 loopback 代理（对有直连网络的服务器这才是
对的默认：留一个指向虚空的代理会把原本能直连的 Host 搞坏）。目标机需要代理时，由用户自己的 SSH 配置
解决（`RemoteForward` 等，Aide 不替用户开反向转发——转发端口对目标机上的其他用户可见，是安全面的
扩大，该由用户在自己的 `~/.ssh/config` 里明确选择）。

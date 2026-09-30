# Host 模型：后端整体跑在 Host 上，GUI 只是屏幕

> 状态：P0 进行中（2026-09-30 立）。取代「远程工作区 = 逐命令转发」的做法（docs/remote-workspaces.md），迁移完成后那套路由整体删除。

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

1. **只有一套模型**：Host 落地后旧的逐命令路由（`remote_workspace/routes.rs` 的转发与路径翻译）必须删除，不许两种「远程」并存。
2. **本机零退化**：本机 Host 在桌面进程内直调，不绕传输层；本机模式的速度与体验不得比迁移前差。

## 2. 架构：一张命令表，多个前门

```
                         ┌──────────────── aide-core ────────────────┐
前端 invoke ─ Tauri ──▶  │ registry: 命令名 → handler(Arc<Core>, JSON) │  本机 Host（进程内）
             host_door   │ Core: WorkspaceState · EventSink · …        │
                         └────────────────────────────────────────────┘
GUI ─ stdio(wsl/ssh) ─▶ aide-host serve ─▶ 同一个 aide-core            远程 Host（目标机）
```

- **`crates/aide-core`**：Tauri 无关。`Core` 持有 Host 自持状态（活动工作区等）与事件出口 `EventSink`；`registry` 是命令表 = Host 的全部能力面（可审计）。命令名 = 前端 invoke 名，参数 = invoke 原样 JSON。处理器一律 async，阻塞 IO 经 `blocking` 离开异步线程。
- **本机前门** `src-tauri/src/host_door.rs`：invoke 链 `routes::intercept → host_door::dispatch → Tauri 命令表`。已迁入 core 的命令不写 `#[tauri::command]`、不进 `generate_handler!`。事件出口 `TauriSink` = `app.emit`。
- **远程前门** `aide-host serve`：`invoke` 方法查同一张表；二进制结果包成 `{"$bytes": b64}`。aide-host 以 musl 静态链接嵌入 aide-core，故 **aide-core 与 aide-host 同守「不依赖系统 C 库、单静态二进制」**（crate 自带的 C/汇编如 ring 可静态编入，2026-09-30 定）。
- **agent 引擎**（Node sidecar）仍是 Host 的子进程，stdin/stdout 协议不变。

### 事件契约（待兑现）

多个窗口 / 手机可能连同一个 Host。事件必须**按会话订阅投递**（已删除的 headless 验收过这套语义：重复订阅先摘旧、断连自动摘除），不许沿用桌面现行的全量广播——那在多客户端下是泄露隐患。

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
| P0-4e | automation（11）迁入：调度器常驻 Host，运行 / 蒸馏直接写 `Core::runtime`；`AgentHooks::observe` 里的自动化观测随之回到 core 内部 | |
| P1 | 窗口连 WSL Host：GUI 泛化转发全部 invoke + 事件，Host 原生路径直出前端；删除 `routes.rs` 与路径翻译 | |
| P2 | SSH Host、断线重连与事件回放、Host 选择启动页（各 Host 最近项目） | |
| P3 | 手机直连 Host（单设备 token 落点随之迁到 Host）、Host 常驻守护 | |

迁移期规则：远程工作区在 P1 之前仍走 `routes.rs`。aide-host 里的 `transcript_*` / `lsp_detect` 等「桌面向 host 取原料」的内部命令**不迁入 core**——它们是逐命令转发模型的产物，P1 后会话命令与 LSP manager 本身跑在 Host 里，它们随 `routes.rs` 一起删除。aide-host 收到桌面解析好的 `root` 时注入为 core 命令的 `cwd` 参数。**表外命令遇远程路径一律大声拒绝**，绝不回落本机。

## 4. 新增 / 迁移一条命令

1. 在 `crates/aide-core/src/commands/<模块>.rs` 写 `async fn(Arc<Core>, Args) -> Result<T, String>`，分表里 `command!("名字", 函数)` 登记（原始字节用 `command!(bytes …)`）。
2. 需要工作区根：参数收可选 `cwd`，用 `core.workspace.root_for(cwd)`（进程 cwd 类）或 `active_root()`（展示 / 索引类，绝不回退家目录）。
3. 删掉桌面对应的 `#[tauri::command]` 与 `generate_handler!` 条目。aide-host 自动获得该命令。
4. 过渡期若它按路径操作工作区文件：`routes.rs` 登记路径参数（P1 删除）。

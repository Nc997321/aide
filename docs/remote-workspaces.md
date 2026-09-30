# 远程工作区（WSL / SSH）

> 2026-09-29 立。GUI 永远在用户的桌面（Windows / macOS / 鸿蒙 / Linux 桌面）；**工作区**可以住在
> 一台没有图形界面的目标机上——本机的 WSL 发行版，或一台 SSH 服务器。文件树、编辑器、git、
> 搜索、终端、agent 会话全部作用于目标机上的文件与进程。

## 用户视角

1. 「打开目录」对话框顶部选机器：`本机` / `WSL: <发行版>` / `SSH: <主机>` / `+ SSH 主机`。
2. 首次连接一台目标机：自动安装远程组件到目标机 `~/.aide/host/`（目标机**不需要联网**、
   不需要预装任何东西——下载都在桌面完成，经连接管道上传）。之后秒连。
3. 选目标机上的目录 → 打开。之后的一切操作都在目标机上执行。
4. SSH 需要免密登录（密钥 / ssh-agent）：Aide 没有终端可以替你输密码。首次连新主机需先在终端
   里 `ssh <主机>` 确认一次主机指纹。
5. 用「Claude 官方账号登录」的供应商时，目标机需要登录一次：在 Aide 的终端（远程工作区里它开
   在目标机上）运行 `~/.aide/host/aide-claude`，输入 `/login`。API Key 类供应商无需这步。
   **不**同步桌面的 OAuth 凭据：refresh token 会轮换，两台机器共用一份会互相顶掉；服务器也
   可能多人共用。

## 架构

```text
桌面（Tauri + Vue，GUI）                                   目标机（无 GUI）
┌────────────────────────────────────┐   wsl.exe -d D -- …   ┌──────────────────────────────┐
│ 前端：路径是 UNC 形态，零感知        │   ssh host …           │ aide-host serve              │
│ IPC 拦截层 remote_workspace/routes ─┼──── stdio JSON-RPC ───▶│  aide-workspace（同一份实现）│
│   fs / git / 搜索 / 监听 / 转录      │◀─── 通知（文件变动）───│  fs · git · search · watch   │
│ AgentRuntimeManager 车道（lane）    │                        │  transcripts                 │
│   会话按工作区归属绑定车道 ─────────┼──── sidecar 原生协议 ─▶│ aide-host agent → node       │
│ PTY：wsl.exe --exec sh / ssh -t ────┼──── 终端 ─────────────▶│   runtime.js → claude CLI    │
└────────────────────────────────────┘                        └──────────────────────────────┘
```

### 路径形态（唯一真相源 `src-tauri/src/remote_workspace/path.rs`）

| 目标 | 桌面形态 | 目标机 |
|---|---|---|
| WSL `Debian` | `\\wsl.localhost\Debian\home\u\p` | `/home/u/p` |
| SSH `devbox` | `\\aide-ssh.invalid\devbox\home\u\p` | `/home/u/p` |

- WSL 用的是 **Windows 原生 UNC**：资源管理器 / 默认程序打开 / 跨机复制（本机 ↔ WSL）天然可用。
- SSH 借同一形态；服务器名是保留顶级域 `.invalid`，未路由的命令碰到它 DNS 立即失败，不卡 SMB。
- 前端影子实现 `packages/aide-sdk/src/api/remoteWorkspace.ts` 只做显示 / 判定，以 Rust 为准。

### 一份实现，两处运行（crates/aide-workspace）

fs / 搜索 / git / 文件监听 / 会话转录读取原本焊死在 Tauri 命令里，无法在目标机上跑。现在它们
在 **Tauri 无关**的 `crates/aide-workspace`：桌面的 `#[tauri::command]` 是一行转调的薄壳，
`crates/aide-host` 在目标机上分派到**同一批函数**。**禁止**为远程再写第二份实现。

### IPC 拦截层（`remote_workspace/routes.rs`）

Tauri v2 的 `invoke_handler` 是闭包——在命令表外包一层，所有前端 invoke 先过这里：

1. **转发**：参数里的路径 / 工作区根属于远程主机 → 译成目标机路径交给 aide-host，结果里的绝对
   路径译回桌面形态（`read_file_binary` 的字节原样还原）。
2. **拒绝**：会在本机起进程操作工作区的命令（LSP / 代码索引 / 运行配置 / 记忆观测）遇到远程路径
   → 明确报错。回落本机 = 用本机工具链跑目标机的项目，跑错机器且不报错。
3. **放行**：把路径当数据存的（注册表 / 信任 / 会话元数据）本来就在桌面执行。

**新增一个「按路径操作工作区文件」的命令 = aide-workspace 实现 → aide-host 分派
（`crates/aide-host/src/commands.rs` 登记）→ `routes.rs` 登记路径参数。三处缺一，远程工作区里它
就会回落本机。** 单测 `every_fs_route_is_supported_by_host` 钉住 routes ⊆ aide-host。

### agent 车道（`runtime/pump.rs` + `runtime/remote_lane.rs`）

- `send_message` 解析出的 cwd 是远程路径 → 确保该主机车道在（`aide-host agent`，一条独立的
  wsl/ssh 管道，对面就是 sidecar 原生协议）→ 会话绑定车道 → 命令里的桌面路径译成目标机路径。
  同会话后续命令（权限应答 / 中断 / 切模型…）由 `send_to_runtime` 按绑定路由。
- 事件泵与本机是同一条（`pump.rs` 按车道参数化）：前端看到的 chat-event 形状完全一致；远程
  车道只在三处分叉——codegraph / LSP 桥查询就地回错（不让 agent 白等超时）、事件结构化字段里的
  路径译回桌面形态（**不改模型正文**）、进程死亡只给本车道的会话发 `session_dead`。
- 进程级 env（Claude CLI 路径等）经 `aide-host agent` 的**首行 stdin** 下发，不上命令行——
  命令行在目标机 `ps` 里对所有用户可见。provider 凭据与本机一样随每条 send 下发。
- `aide-host agent` 以**交互式登录 shell**（`-lic`，退 `-lc`）取用户环境：Debian/Ubuntu 的
  `.bashrc` 对非交互 shell 直接 return，nvm 之类只装在那里；agent 的 Bash 工具要看到与用户终端
  一致的工具链。rc 文件的 stdout 噪音被标记行隔离。

### 会话转录

转录住在 agent 运行的机器上（目标机 `~/.aide/claude/projects/`）。`load_messages` /
`session_last_event` / `session_jsonl_size` / `session_truncate_jsonl` / 会话列表先按会话档案
`wsPath`（再退车道绑定）判定会话所在主机，远程的向 aide-host 取转录原料，桌面叠加自己的元数据
（显示名、自动化标签）。**会话元数据 `~/.aide/sessions/<id>.json` 仍在桌面**——它是桌面的概念。

### 「存在性」判定（`path::present`）

远程路径无法在同步小函数里 stat（要先连目标机）。所有「目录不在就回落 / 判 missing」的地方
（会话 cwd 解析链、`project_root_for_commands`、`create_workspace`、工作区列表）一律用
`remote_workspace::path::present`：远程按存在处理，真实存在性由转发的操作如实报错。**若对远程
路径返回 false，会话 cwd 会静默回落到活动工作区——即 2026-09-18「跑错项目」事故的同一形态。**

### 远程套件（remote kit）

| 文件 | 来源 | 目标机位置 |
|---|---|---|
| `aide-host-linux-{x64,arm64}` | `pnpm build:remote-kit`（musl 静态链接，纯 Rust） | `~/.aide/host/<ver>/aide-host` |
| `runtime.js` | agent-sidecar bundle（平台无关） | `~/.aide/host/<ver>/runtime/runtime.js` |
| Claude CLI | 桌面按需从 npm registry（npmjs → npmmirror）下载缓存 | `~/.aide/host/deps/claude-<sdk>-<plat>/claude` |
| node | 目标机已有 ≥18 则用；否则桌面代下 | `~/.aide/host/deps/node-<ver>/` |

构建：`pnpm release` 与 `pnpm tauri dev` 都会自动构建套件（dev 下失败只警告，不挡桌面启动），无需手动执行。
`<ver>` = 应用版本 + host/runtime 内容哈希：开发期改了代码也会触发重装；旧版本目录自动清理。
下载走桌面的代理设置（`commands::proxy::detect_proxy`），缓存在 `~/.aide/cache/remote-kit/`。

## 已知边界（v1）

- **LSP / 代码索引 / 运行配置 / 记忆观测台**：远程工作区里明确拒绝（界面降级为空）。实现路径：
  LSP server 经 aide-host 在目标机上起、stdio 经 RPC 流式转发（`lsp/` 公共层已语言无关，差的是
  进程传输端口化）。
- **代理**（目标机要能访问模型 API）：优先级 ① Aide 设置里的代理（随 send 下发）→ ② 目标机
  登录环境里自己的代理 → ③ 桌面自动探测到的代理（设置 / 环境 / git / 常见本地端口）作兜底
  （`AgentInit.default_env`，不覆盖②）。桌面的**回环**代理（`127.0.0.1:7890`）在目标机上按网络
  改写：WSL 先试目标机回环（mirrored 模式与 Windows 共享回环）、不通则换成默认网关（NAT 模式即
  Windows 主机——代理需开「允许局域网连接」）；SSH 丢弃（服务器到不了桌面回环，后续可 `ssh -R`）。
- **SSH 需免密**；WSL 仅 Windows 桌面可用。
- 远程车道的 agent 不挂 codegraph / LSP 工具（`translate_send_command` 置空），浏览器工具照常可用
  （内嵌浏览器在桌面，远程 agent 用它天经地义）。

## 验收

- `cargo test -p aide-workspace -p aide-host`（Linux / Windows 均可跑）
- `cargo test --lib remote_workspace`（桌面侧单测）
- 真机端到端（Windows → WSL）：见 `src-tauri/src/remote_workspace/e2e_tests.rs` 头注释

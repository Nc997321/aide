# Aide 架构优化路线图：单进程异质负载治理

> 生成日期：2026-08-30  
> 状态：待实施（**注：优化项二的对象 CodeGraph 已于 2026-10-01 整体移除，tag `codegraph-final` 可找回；本文涉及 codegraph 的章节仅作历史记录**）  
> 依据：对代码库的实测分析（数据见各节），非主观印象

---

## 0. 现状基线（实测数据）

| 指标           | 数值                                                  |
| ------------ | --------------------------------------------------- |
| Rust 后端      | 40,869 行 / 123 文件 / 232 个 Tauri command / 654 个测试函数 |
| Vue 前端（src/） | ~45,000 行（不含测试）/ 93 个组件 / 73 个测试文件                  |
| Node Sidecar | 17,704 行 / 39 个测试文件                                 |
| remote-pwa   | ~1,080 行，4 组件 + 1 测试                                |
| 测试代码合计       | 前端 9,214 行 + sidecar 7,350 行 + Rust 654 个内联测试       |
| 远程 RPC 白名单   | 40 个方法（`src-tauri/src/remote/rpc.rs`）               |

**总体判断**：架构决策层面（SDK 传输层抽象、RPC 白名单即安全边界、远程/桌面复用同一实现体）是健康的；问题集中在**执行层**——单进程承载过多异质负载 + API 门面双轨制。

---

## 1. 核心问题：单进程承载了太多异质负载

### 1.1 九类负载，五种资源画像

aide.exe 一个进程内同时运行：

| 负载                | 位置                                             | 资源画像                 |
| ----------------- | ---------------------------------------------- | -------------------- |
| WebView 宿主 / 事件发射 | Tauri 主线程                                      | **单点**——任何 park 波及全链 |
| Agent 会话流         | `runtime/` + tokio task                        | 延迟敏感（毫秒级流式）          |
| PTY 终端            | `shell.rs` / portable-pty                      | 延迟敏感（持续数据泵）          |
| CodeGraph 索引      | `codegraph/`（ONNX + qdrant-edge + tree-sitter） | CPU/内存大户（GB 级）       |
| LSP 客户端           | `lsp/`                                         | 常驻 I/O               |
| 文件扫描/监视           | `ignore_dirs.rs` 等                             | I/O 突发               |
| 远程中继客户端           | `remote/relay_client.rs`                       | 网络常驻                 |
| 自动化调度             | `automation/`                                  | 周期型                  |
| 诊断黑匣子             | `diagnostics/` + `diagnostics.rs`              | 常驻采样                 |

### 1.2 四条致病机制（代码中有实证）

1. **内存无隔离**
   - 实证：Cargo.toml 注释记录 ONNX arena 内存 3G→6G 不归还 OS，被迫禁用 arena + memory_pattern。
   - 机制：线程隔离不了堆内存。CodeGraph 的内存碎片/膨胀直接压缩所有会话与 UI 路径的预算，最坏情况 OOM。
2. **延迟链路级联放大**
   - 实证：Cargo.toml 顶部注释记录的 wedge 链——主线程 park → 同步版 emit 卡住 → 读 sidecar stdout 的 tokio task 停摆 → 管道回压 → 后端整体 wedge。最终靠关闭 tauri 的 `tracing` feature 让 emit 退回 fire-and-forget 才止血。
   - 机制：故障源（主线程）与受害者（会话流）相隔三层，中间没有断路器。
3. **崩溃域不分**
   - 实证：依赖 ort（C++）、tree-sitter（C）、qdrant-edge 等原生 FFI 库。
   - 机制：任何一处 segfault，整个 aide.exe 连同进行中的会话一起死；原生崩溃无法被 Rust panic 边界捕获。线程救不了，只有进程边界能救。
4. **观测代价转嫁为产品功能**
   - 实证：`diagnostics/` 模块含 stuck-command 追踪（`trace_command` guard + `current_stuck_command`）、事件速率桶、冻结补充采样、Win32 `SuspendThread`/`StackWalk` 主线程栈回溯（Cargo.toml windows features 注释）。
   - 机制：所有负载共享一个堆，故障发生时没有进程边界可看，被迫内置"黑匣子"事后解剖。若负载分进程，任务管理器 + 各自 crash log 即可。

### 1.3 公道话：线程级隔离已做到位

`codegraph/commands.rs`、`codegraph/build.rs` 中 ONNX 前向、建索引、reindex 均已走 `spawn_blocking`，且注释明确写了"ONNX forward pass never blocks other readers"。**问题不是写得不好，而是撞到了线程模型的物理上限**——线程隔离 CPU 调度，不隔离内存与崩溃域。

---

## 2. 优化项一：API 门面统一（双轨制 → 单轨）

### 问题

实测（2026-08-30）：桌面前端 **44 个文件**走 `@aide/sdk`，**38 个文件**仍绕过 SDK 直接 `invoke`（如 `src/composables/useGit.ts` 第 2 行 `import { invoke } from "@tauri-apps/api/core"`）。

双轨制的代价：

- 远程可用能力无法机械审计——某能力是否远程可用，取决于它走哪条门面，而不是 RPC 白名单；
- `@aide/sdk` 门面（`packages/aide-sdk/src/api.ts`）与绕行调用并存，新增命令时存在两套入口要维护的隐性成本。

### 方案

1. 盘点 38 个绕行文件，把每个直接 `invoke(cmd, args)` 调用改为 SDK 门面方法（缺的方法在 `packages/aide-sdk/src/api.ts` 补齐，签名照抄 RPC DTO 的 camelCase 键）。
2. 加 ESLint 规则（或 CI grep 检查）：`src/` 内禁止 `@tauri-apps/api` 导入，只允许 `packages/aide-sdk` 导入。
3. 例外白名单：`src/` 之外的代码（如 `src/main.ts` 初始化路径若确需）逐条记录理由。

### 验收标准

- `grep -rl "@tauri-apps" src --include="*.ts" --include="*.vue"` 结果为 0（或仅剩登记过的例外）。
- 桌面端全功能回归（重点：git 面板、PTY 终端、文件树——绕行调用最集中的区域）。

### 成本/收益

成本低（纯机械迁移，SDK 门面已存在），收益大：此后"远程缺什么能力"退化为查 `rpc.rs` 注册表 + SDK 门面 diff 的机械操作。

### 完成记录（2026-08-30）

- **SDK 门面补齐**：`api.ts` 新增 git 方法组（branches/log/status/unpushed/stash/ahead_behind/tags/compare/show/checkout/branch CRUD/stage/commit/fetch/push/pull/stash 四件套/discard_all/fingerprint/remote_url/diff_pair/diff_pair_refs）+ `openDevtools`/`appVersion`/诊断四件套（diagHeartbeat/diagFreezeSupplement/diagScrollTrail/logFrontendError）；transport 层新增 `listen()`/`openExternal()` 助手（openExternal 为 transport 可选方法：桌面走 plugin-shell，远端 window.open，桩件自动回落）。
- **前端迁移**：~24 个文件的直接 `invoke`/`listen`/plugin-shell `open`/`getVersion` 全部改走 `@aide/sdk`（经 `src/api.ts` 兼容壳 re-export）。
- **Rust 侧**：新增 `commands::app::get_app_version`（package_info 纯内存读取，不进 RPC 白名单）。
- **守门**：`scripts/check-tauri-imports.mjs`（`pnpm check:tauri-imports`）扫描 src + remote-pwa，例外集中登记：`src/main.ts`（初始化路径）、`useWindowControls`/`useWindowFocus`/`useNotification`（窗口壳专属）、`*.test.ts`（vi.mock 边界）。
- **验收**：守门脚本 ✓（0 未登记绕行）；`vue-tsc --noEmit` ✓；vitest 142 文件 / 1579 测试全过 ✓；`cargo check` ✓（仅存量 warning）。桌面端全功能回归（git 面板/PTY/文件树）待人工验证。
- **测试适配**：`useProviderActions.test` 断言迁到 `openExternal`；两个 SettingsPanel 测试删除失效的 `@tauri-apps/api/app` mock（`../api` Proxy mock 已覆盖 `appVersion`）。

---

## 3. 优化项二：CodeGraph 进程隔离（本路线图核心）

### 问题

见 1.2。CodeGraph 是九类负载中唯一的"资源吞噬型"，且与延迟敏感的会话流共存于同一进程——这是唯一会互相伤害且双方都致命的组合。

### 方案：照抄 agent-sidecar 模式

agent-sidecar 已经是这个问题的第一次正确回答（Node 无法嵌入 Rust 被迫进程化，反而获得了独立重启、独立崩溃域、独立日志的副产品）。照抄：

1. **新建 `codegraph-runner` crate**（`src-tauri` 同 workspace）：
   - 迁移 `codegraph/` 的 ONNX 推理、向量库（qdrant-edge）、tree-sitter 解析；
   - 编译为独立 `aide-codegraph.exe`，随 tauri bundle 分发（参考 sidecar 的 `build:bin` 打包路径，产物进 `tauri.conf.json` 的 externalBin）。
2. **通信协议**：stdio JSON-RPC（一行一个 JSON 消息），复用 `runtime/` 模块已有的子进程 spawn / stdout 读取 / watchdog 机制。
   - 建议方法集：`build_index` / `progress` / `search` / `reindex_file` / `rescan` / `close` / `shutdown`。
   - 事件回传用独立消息类型（对齐现有 `codegraph_build_progress` 的推送语义）。
3. **主进程侧瘦身**：`src-tauri/Cargo.toml` 的 ort / tokenizers / ndarray / tree-sitter / qdrant-edge 依赖全部下沉到 runner crate——主进程二进制变小、编译面变窄（`spawn_blocking` 下的原生 DLL 也从主进程消失）。
4. **生命周期**：首个 codegraph 命令到达时惰性拉起；空闲 N 分钟或收到 `close` 后回收；崩溃后下次调用自动重启（watchdog 已有类似语义，参考 sidecar 的重启可恢复设计）。

### 验收标准

- 任务管理器中 aide.exe 常驻内存不再随索引重建显著增长（对照实验：重建索引前后各记录 RSS）。
- kill 掉 aide-codegraph.exe 进程，聊天会话不受影响，下次 codegraph 调用自动恢复。
- `tauri build` 产物含两个二进制（aide.exe + aide-codegraph.exe，已有 aide-agent.exe 之外再 +1）。

### 风险与代价

- 向量查询结果过 IPC 序列化，延迟增加毫秒级——对语义搜索场景无感；
- 打包复杂度 +1 个二进制（已有 sidecar 先例，机制成熟）；
- 迁移期间注意 `codegraph/` 现有 107 个测试随迁并改走进程协议。

### 成本/收益

成本中等（1–2 周单人），收益最大：arena 暴涨退化为"runner 重启一下"，原生库 segfault 退化为"索引降级，聊天继续"，诊断黑匣子的大部分采样场景消失。

---

## 4. 优化项三：commands 模块拆分（可维护性，非救命）

### 问题

`src-tauri/src/commands/` 单模块 16,763 行、232 个命令的平面结构。找命令实现、review diff、按域理解行为的心智成本随规模线性上升。

### 方案

按域拆子模块（目录骨架已存在雏形，如 `commands/chat.rs` 被 RPC handlers 引用的路径所示）：

```
commands/
├── chat.rs          # send_message / permission_response / interrupt / btw
├── sessions.rs      # list / create / delete / rename / load_messages
├── workspaces.rs    # list / trust / scan
├── files.rs         # read/write/list/编码兜底
├── pty.rs           # spawn/kill/resize/poll（对接 shell.rs）
├── git.rs
├── codegraph.rs     # 隔离改造后只剩转发到 runner 的 RPC 桩
├── settings.rs
├── diagnostics_cmd.rs
└── ...
```

- 纯移动 + `pub` 可见性调整，不改逻辑；
- `remote/rpc/handlers.rs` 的引用路径同步更新（编译器兜底）。

### 验收标准

- `cargo test` 全绿；无任何命令实现体改动（diff 应只含移动与 mod 声明）。

### 成本/收益

成本低（1–2 天机械操作），收益是长期可维护性。**优先级排最后**：舒服，但不救命。且建议在优化项二做完后再拆——codegraph 相关命令届时已变成薄桩，拆分面更干净。

### 完成记录（2026-08-31）

前置澄清：执行路线图时实测，本项的「16,763 行平面单模块」是**整个 `commands/` 目录的累计行数**而非单文件——目录早已按域拆为 25 个文件 + 5 个子目录（chat/session/git/workspace/filesystem/…），路线图所列骨架与现状基本一致。真正剩余的欠账是三个违反「源文件超 1000 行必须拆」规则的大文件，本次拆分即收尾这部分：

- **`commands/session.rs`（2382 行）→ `session/`**：`mod.rs`（会话元数据 CRUD/偏好记忆/自动命名守门 + 两处工作区会话扫描 + re-export 门面）、`history.rs`（load_messages + 字节游标反向分页 + 尾部探测）、`transcript.rs`（transcript 纯解析 functional core）、`changes.rs`（变更面板 JSONL 落盘）、`jsonl.rs`（末事件/尺寸截断/末条消息摘要）。
- **`commands/git/legacy.rs`（1924 行）→ `git/` 域文件**：`runtime.rs`（spawn 串行锁/超时 kill/blocking 桥）、`types.rs`（core.quotepath 还原）、`operations.rs`（暂存/取消/撤回/discard/commit）、`stash.rs`、`branches.rs`、`status.rs`（porcelain 解析 + git_diff_files）、`remote_op.rs`（fetch/pull/push/ahead_behind/unpushed）、`commits.rs`（log/show）、`diffpair.rs`（cat-file --batch + DiffPair 组装）、`fingerprint.rs`（refs mtime 指纹）。`compare.rs`/`tags.rs` 的 `use super::legacy` 改指新域模块。
- **`commands/customizations.rs`（1166 行）→ `customizations/`**：`mod.rs` 共享底座（CustomizationItem + 目录/settings 读写/frontmatter 助手）+ `agents.rs`、`skills.rs`、`instructions.rs`、`hooks.rs`、`mcp.rs`。
- **错位归位**：`git/legacy.rs` 里的 `log_frontend_error`（前端错误采集）迁到 `src/diagnostics.rs`，lib.rs 注册路径同步改 `diagnostics::log_frontend_error`，与 diag_* 同列。
- **门面机制（两式，勿混用）**：`session/` 用私有子模块 + 显式 `pub use`——tauri `__cmd__X` 宏跟随定义模块，须在 mod.rs 逐个 `pub(crate) use` 转发；`git/`、`customizations/` 保持 `pub mod` + glob `pub use X::*` — 宏本身是 pub item 随 glob 转发，无需逐个列。外部注册路径 `commands::session::X` / `commands::git::X` / `commands::customizations::X` 全部不变（lib.rs、remote/rpc/handlers.rs、automation 零改动，除 log_frontend_error 一条）。
- **纯移动保障**：函数体经行号切片逐字节搬移（非手抄）；测试随域分配且守恒对账 session 64/64、git 26/26、customizations 8/8；`cargo fmt --check` ✓；clippy 对触达模块逐条对照 HEAD 原文件——13 处警告全部逐字存在于搬移前代码，零新增（存量：automation `run_id` 等）；`cargo test --lib` 553/0 全绿（连跑三轮稳定）；rust-reviewer 子代理独立审查通过。
- **测试小事故一处**：customizations 拆分时一个 `#[test]` 行号边界少切一行（8→7），测试守恒对账当场暴露并补回——守恒对账应作为此类拆分的固定验收步骤。

---

## 5. 附带项：remote 模块测试补齐（建议随优化项一一起做）

### 问题

`src-tauri/src/remote/`（1,043 行，含 550 行 RPC handlers、40 个白名单方法、配对/token/权限模式兜底逻辑）**只有 1 个测试**——而它是安全敏感面 + 远程链路（含未来鸿蒙瘦客户端路线）的全部地基。

### 方案

- handlers 层：40 个方法各至少 1 个正/反用例，重点覆盖 `send_message` 的 permissionMode 兜底分支（消息带 vs 不带，不带时读 `remote.permission_mode` 设置）；
- 白名单层：未注册命令名必须被 `lookup` 拒绝；
- `set_providers` / `get_settings` 的凭据暴露面过一遍安全审计（远程可改配置的边界是否合理）。

### 验收标准

- remote 模块测试函数从 1 → 30+。

---

## 6. 实施顺序与依赖关系

```
第一步  优化项一（API 门面统一）     — 2~3 天，零风险，立刻降低后续所有改动的审计成本
第二步  remote 测试补齐             — 2~3 天，为第三步护航
第三步  优化项二（codegraph 进程隔离）— 1~2 周，本路线图核心
第四步  优化项三（commands 拆分）    — 1~2 天，收尾整理
```

理由：

- 一先行是因为三、四都会触碰命令调用路径，先统一门面能让改动点收敛到 SDK 一处；
- 二排在三之前：进程隔离改造会动 `codegraph_*` 的 RPC handler，先有测试网再动刀；
- 四押后是因为 codegraph 命令变薄桩后拆分更干净。

---

## 7. 与长期路线的关系

- **远程/鸿蒙瘦客户端路线**：优化项一完成后，"远程可用能力 = RPC 注册表 ∪ SDK 门面"变成可机械推导的事实，新端（remote-pwa 增强 / 未来 ArkWeb 壳）的能力盘点成本趋近于零。
- **单进程问题的一般化答案**：本路线图只隔离 CodeGraph（唯一互害组合）。若未来 LSP 或文件监视出现类似资源冲突，复制同一模式即可——sidecar 模式已经是项目的既定架构语言。


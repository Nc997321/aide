# 会话状态机加固设计 — 正交健康度轴 + 心跳 + 软超时

- 日期：2026-07-04
- 状态：已通过 brainstorming 评审，待写实施计划
- 关联架构红线：跨平台（`CREATE_NO_WINDOW`、`PathBuf`）、多 Provider 抽象（IPC 协议 provider-agnostic）

## 1. 背景与根因

Agent SDK 迁移后，会话不再有显式“启动”动作，取而代之的是**延迟创建 + 首条消息即拉起 sidecar 进程**。判断“会话是否启动/存活”完全依赖前端一个模块级 reactive map（`useSessionState.ts`）里的 `SessionStatus` 四态：`stopped / running / waiting / attention`。

该状态机是**乐观事件机**，不是自愈状态机——状态全由 sidecar/Rust 的事件推导，从不主动核对进程真实存活。由此产生三个真实缺陷：

1. **`error` 语义被合并导致状态说谎**：sidecar 的“可恢复单轮错误”（`index.ts:167`，进程仍存活、继续循环等下一条）与 Rust 的“进程致命退出”（`sidecar.rs:126`）都发同一个 `type:"error"`，前端一律置 `stopped`。结果：进程明明活着、下一条消息其实还能处理，状态点却显示“死了”。
2. **丢失 `message_stop` → 永久 running**：无超时兜底。SDK 卡住而进程未退出时，会话永远停在 `running`/`isBusy`，且 `running→waiting` 转换驱动的通知/任务栏进度/变更捕获一并静默失效。
3. **进程“假死”（hang）不可见**：`stopped` 检测依赖 Rust stdout reader 循环 EOF（进程真死）。进程死锁/悬在 await 但不退出时，无任何事件触发，前端永远 `running`。

根因是**把两件正交的事塞进了同一个枚举**：进程“在干嘛”（活跃度）与进程“健不健康”（健康度）。本设计将其拆为两条正交轴，并按“谁有能力产生该信号”分层落地存活监控。

## 2. 目标与非目标

**目标**
- 拆出正交的健康度轴，消除 `error` 语义混用导致的“活着却显示死了”。
- 心跳判死：覆盖进程真死 + 事件循环被卡死。
- 软超时判 `stalled`：覆盖“卡在 await”类假死（心跳抓不到的一类），以 UI 软提示呈现、不擅自杀进程。
- 状态点六色语义清晰：灰=停 / 蓝=空闲 / 绿=运行 / 黄=等权限 / 橙=疑似卡住 / 红=出错。

**非目标**
- 不做状态持久化（进程随 app 退出而死，重启后默认 dead 即正确）。
- 不做“长工具 pending 时暂停软超时”的特判（见 §6，接受偶发假橙，留作后续可选项）。
- 不改活跃度轴的既有事件推导逻辑与语义。

## 3. 两轴模型

会话持有 `{ activity, health }` 两个正交字段。

**活跃度轴 Activity**（仅在进程存活时有意义，语义维持现状）
- `running` — 生成中
- `waiting` — 存活空闲（`message_stop` 后）
- `attention` — 等权限确认

**健康度轴 Health**（新增）
- `ok` — 正常
- `warning` — 上一轮可恢复错误，进程仍存活
- `stalled` — running 后长时间无事件，疑似卡住，进程可能仍存活
- `dead` — 进程没了（正常退出 / 致命错误 / 心跳掉线）

**坍缩规则**
- `health === 'dead'` 为终态：一旦判死，活跃度轴作废。
- 会话在 store 中无条目时，默认视作 `dead`（等价今天的 `stopped`，灰点）。
- 首条消息发出：`activity = running, health = ok`。

> 迁移映射：今天的 `stopped` == 新模型 `health:dead`；`running/waiting/attention` 平移到活跃度轴。

## 4. 状态点色投影

状态点为单点，颜色由 `(activity, health)` 经一个**纯函数**投影得出，优先级从高到低：

| # | 判据 | 颜色（CSS 变量） | 脉冲 |
|---|------|------------------|------|
| 1 | `health = dead` | 灰 `--aide-text-muted` | 无 |
| 2 | `health = warning` | 🔴 红 `--aide-error`（新增 token） | 有 |
| 3 | `health = stalled` | 🟠 橙 `--aide-stalled`（新增 token） | 有 |
| 4 | `activity = attention` | 🟡 黄 `--aide-warning` | 有 |
| 5 | `activity = running` | 🟢 绿 `--aide-success` | 有 |
| 6 | `activity = waiting` | 🔵 蓝 `--aide-accent` | 无 |

实务上多数高优先级项互斥（`warning` 仅轮结束后可能、`stalled` 仅运行中可能、`stalled` 与 `attention` 因软超时在 attention 期间暂停而互斥），此表仅作兜底定序。

> 若 `--aide-error` 已存在则复用；`--aide-stalled` 若无现成语义色则新增（橙，区别于 `--aide-warning` 的黄）。实现时先核对主题变量表。

## 5. 三层职责与 IPC 协议

分层原则：**每个信号归给唯一有能力产生它的层**。

### 5.1 sidecar（`agent-sidecar/src/index.ts`）
- 存活期间每 **5s** 发一个 `heartbeat` 事件。
- `error` 事件加 `fatal: boolean`：可恢复错误（`index.ts:167` 的 catch 分支，进程继续循环）发 `fatal:false`；致命错误发 `fatal:true`。

### 5.2 Rust（`src-tauri/src/sidecar.rs`，唯一持 child 句柄）
- stdout 读循环拦截 `type:"heartbeat"` 行：**消费掉、不转发前端**（高频，避免事件刷屏），并重置该会话的看门狗计时。
- 判死有两条路径，须保证**只发一次** `session_dead`：
  - **reader EOF**（进程退出）：若 `!killed` 则发 `session_dead { reason: "exit" }`，取代现在退出时那条含糊的 `type:"error", "exited unexpectedly"`。
  - **看门狗超时**（**15s** 未收到心跳）：先发 `session_dead { reason: "heartbeat_timeout" }`，再 `start_kill` 僵尸进程——kill 会置 `killed=true`，随后 reader EOF 路径因 `killed` 被抑制，不会重复发。
- `killed: AtomicBool` 门控语义：**用户主动 kill（`stop_chat_session`）先置 `killed=true` 再杀，两条路径都被抑制，不发 `session_dead`**（会话是用户停的，非意外死亡）。因此“主动停”与“看门狗判死”的区别仅在于是否先发 `session_dead`。
- 看门狗实现：每会话一个可重置的 tokio 任务（心跳到达经 `Notify`/channel 重置，超时 fire 则判死）。跨平台：无平台特有逻辑；任何后续 spawn 仍须 `CREATE_NO_WINDOW`（本设计不新增 spawn）。

### 5.3 前端（`useSessionState.ts` / `useChatSession.ts` / `AStatusDot.vue`）
- 活跃度轴：维持现有事件推导（`session_init`/发送→running、`message_stop`→waiting、`attention` 等）。
- 健康度轴映射：
  - `error` 且 `fatal:false` → `health = warning`，且 `activity` 落 **`waiting`（进程仍活）而非 stopped**。**这是缺陷 1 的修复点。**
  - `error` 且 `fatal:true` / `session_dead` → `health = dead`。
  - 下一条消息成功发出 → `activity = running, health = ok`（清除红点）。
  - `message_stop` 正常结束不动 health（保持 `ok`）。
- 软超时定时器（判 `stalled`）：见 §6。
- `AStatusDot.vue`：props 由单一 `status` 改为 `{ activity, health }`（或一个上游算好的投影 `tone`）；新增红/橙样式类。

### 5.4 IPC 协议变更汇总（`agent-sidecar/src/types.ts` ↔ 前端 `types/chat.ts` 镜像）
全部 provider 无关，符合多 Provider 抽象红线：
1. `error` 事件新增可选字段 `fatal?: boolean`。
2. 新增事件 `heartbeat`：`{ type: "heartbeat", session_id }`（sidecar→Rust，不达前端）。
3. 新增事件 `session_dead`：`{ type: "session_dead", session_id, reason: "exit" | "heartbeat_timeout" }`（Rust→前端）。

## 6. 参数与边界

- **心跳间隔**：5s（sidecar）。
- **Rust 判死阈值**：15s（容 3 次丢失，躲开 GC 停顿误杀）。
- **软超时（stalled）阈值**：`activity=running` 且连续 **90s** 无**任何** chat-event → `health=stalled`。
  - **任何 chat-event 都重置**软超时计时。
  - **进入 `attention` 时暂停**软超时（权限弹窗允许用户长时间不答，不算卡）；退出 attention 恢复计时。
  - `stalled` 为纯 UI 软提示，**不杀进程**；一旦有事件到达（如 `tool_result`）自动回落。
- **长工具假橙**：跑 2 分钟的 Bash 中途可能真的 90s 无事件而误报橙点。因 `stalled` 软、且 `tool_result` 一到即自动回绿，接受此偶发假阳性；**本轮不加“pending 工具时不 arm 软超时”特判**，留作后续可选项。

## 7. 涉及文件

| 文件 | 改动 |
|------|------|
| `agent-sidecar/src/index.ts` | 定时发 `heartbeat`；`error` 打 `fatal` 标 |
| `agent-sidecar/src/types.ts` | 协议：`fatal` 字段、`heartbeat`、`session_dead` |
| `src-tauri/src/sidecar.rs` | 心跳看门狗（每会话可重置 tokio 任务）；拦截 heartbeat 不转发；退出/超时发 `session_dead`（替换旧 error-on-exit） |
| `src/composables/useSessionState.ts` | 由单枚举拆为 `{ activity, health }`；软超时定时器（arm/reset/pause）；投影函数 |
| `src/composables/useChatSession.ts` | 事件→双轴映射（尤其 `fatal:false`→warning+waiting、`session_dead`→dead、发送→health ok） |
| `src/ui/AStatusDot.vue` | props 改双轴；新增红/橙样式类 |
| `src/types/chat.ts` | 镜像协议变更 |
| 主题变量 | 视情况新增 `--aide-error`（若无）、`--aide-stalled` |

调用方（`SidebarLeft.vue` 等使用 `<AStatusDot :status=...>` 处）随 props 变更同步。

## 8. 测试策略

- **点色投影纯函数**：全 `(activity, health)` 组合 → 期望颜色/脉冲，穷举。
- **健康度轴转换**（前端单元）：可恢复错误→`warning` 且 activity 保持 `waiting`；下一条消息→`ok`+`running`；`session_dead`→`dead`；`message_stop` 不改 health。
- **软超时**（前端单元，假定时器）：running 90s 无事件→`stalled`；任意事件重置；attention 期间暂停不误报。
- **Rust 看门狗**：超时判死并发 `session_dead`；心跳按时到达则不判死；`killed` 置位时抑制 `session_dead`。
- **手动/集成**：杀 sidecar→灰；构造可恢复错误→红、下一条→绿；阻塞事件循环→心跳判死→灰；长静默→橙。

## 9. 风险与回滚

- 协议加字段为增量、向后兼容；旧事件缺 `fatal` 时按 `fatal:true`（致命）解释，保守不误显“活着”。
- 若心跳/看门狗行为异常，可将阈值调大或临时停发 `heartbeat`（Rust 收不到心跳会判死——因此回滚需同时移除 Rust 侧看门狗，作为单独提交点，实施计划中标注顺序）。

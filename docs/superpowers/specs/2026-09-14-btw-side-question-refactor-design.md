# btw 塌缩为官方 side_question 单路径

- 日期：2026-09-14
- 状态：设计定稿（用户已确认，待实施）
- 上游调研：《btw 机制调研：官方 side_question 机制与现有 fork 实现对照》（2026-09-14，存于用户桌面，含完整证据链与探针数据；**仓库内暂无副本**，本文档 §2 已提炼实施所需的全部结论）
- 证据源：`@anthropic-ai/claude-agent-sdk@0.3.252`（sdk.mjs + claude.exe 内嵌 JS）

## 1. 问题

现有 btw 有三分支（轻量问答 / 完整问答 / 任务支线），每次提问都新建独立 `SessionWorker` → 新起一个 `claude.exe` → resume fork 主会话。实测早出的延迟下界是 **spawn + boot ≈ 4.1s，首文本 ≈ 7.3s，总计 ≈ 7.7~8s**（空目录、无 MCP；真实应用还要更差）。

官方 SDK 有进程内的 `askSideQuestion()`（走控制通道 `subtype:"side_question"`），在主 CLI 进程内用热参数直接发请求，同样条件下 **≈ 1.1~1.6s**，快 5~7 倍。

## 2. 已确认的关键事实

| # | 事实 | 依据 |
|---|---|---|
| F1 | 主会话 worker **跨回合存活**，不等于零；只在用户显式停会话 / 删会话 / 关应用时 `stop()` | `session-worker.ts:839` 的 `finally` 仅在 for-await 循环真正退出时跑；回合结束的 `result` 帧既非 `"continue"` 也非 `"terminate"`（`turnMessages.ts:40,92`）。停止点：`session-manager.ts:165,214`、前端 `stopSessionById` |
| F2 | `askSideQuestion` 在查询句柄空闲态可调用 | 调研 §5.1 交替测量、§5.2 的 S1→S4 全在上一轮 result 之后 |
| F3 | 主轮进行中也可调用，不干扰主流 | 调研 §5.1 mid-turn：1873ms 返回，主轮随后 `subtype=success` |
| F4 | `askSideQuestion` 在 `sdk.d.ts` 里**零类型**（仅在 sdk.mjs 运行时存在） | `grep -c askSideQuestion sdk.d.ts` = 0；`:4200` 只有进度事件注释 |
| F5 | `history` 线上形状 = `{question, response}[]`（+ 可选 `fallbackNotice`），与现有 `BtwRound` 同形 | claude.exe：`history:x.map(pe=>({question:pe.question,response:pe.response,...pe.fallback_notice&&{fallbackNotice:pe.fallback_notice}}))` |
| F6 | 官方 fork 层 `canUseTool` 恒 deny（`"Side questions cannot use tools"`），天然纯问答 | 调研 §3.2 |
| F7 | `side_question` 超时 600s（其余控制请求 75s） | 调研 §3.2 |
| F8 | 鸿蒙端未实现 btw（仅注释解释"btw 支线事件要丢弃"） | `ohos/entry/src/main/ets/session/chat/ChatEvents.ets:25`、`.../session/ChatModel.ets:28` |
| F9 | `start_btw_session` 在远程 REGISTRY 白名单内，是远程客户端唯一的 btw 入口 | `src-tauri/src/remote/rpc.rs:58` |

## 3. 决策

| # | 决策 | 取舍 |
|---|---|---|
| D1 | **删除三分支**（轻量 / 完整 / 任务），只留一条执行路径 | 放弃"btw 能调工具"与"git-commit 一键提交"；官方机制硬编码禁工具，且任务支线是全新会话形态，官方不覆盖 |
| D2 | **删除 fork worker 兜底**（不保留"起临时 worker"的老路） | 主 worker 不存在时给出友好提示而非退化成慢路径。F1 表明该窗口很窄（新会话未发消息 / 用户停过 / 进程崩过），且这些场景下老路同样冷启动、同样不快 |
| D3 | **批注广播**（`btw_answer` 事件）；**发起端只认广播**，RPC 返回值降级为成功/失败信号 | 与仓库「UI 状态只认事件通道」红线及用户气泡同构（`user_message` 也是三端只认广播）。代价：发起端多等一个广播延迟（毫秒级） |
| D4 | 跨问历史**住前端内存**，仍按会话封顶 20 轮，改为**参数传递**而非 prompt 拼接 | 与"阅后即弃"一致，不新增 sidecar 状态。代价：刷新 / 重启后 btw 之间不再串联 |
| D5 | 命令面：`start_btw_session` → **`btw_ask`**，参数收窄为 `{session_id, question, history}` | 删掉 `fork_from` / `lightweight` / `tools` / `permission_policy` 四个参数 |

## 4. 架构

```
前端 useBtwSession
  └─ invoke "btw_ask" { sessionId, question, history }
        └─ Rust: Runtime 按 sessionId 路由到 worker（查，不建）
              └─ SessionWorker.askSideQuestion(question, history)
                    ├─ 运行时守卫：typeof q.askSideQuestion === "function"
                    ├─ q.askSideQuestion(question, { history })
                    ├─ emit { type:"btw_answer", session_id, question, response?, error?, synthetic? }
                    └─ return { ok:true } | { ok:false, reason:string }

所有客户端收到 btw_answer → 抽屉渲染正文 + 批注回插主会话
发起端 RPC 返回值只用于判别失败
```

### 4.1 命令面（Rust）

- 删除 `commands::chat::start_btw_session`（约 30 行 JSON 拼装）。
- 新增 `btw_ask`（async，符合仓库「同步命令禁重 IO」红线）。职责：校验会话存活 → 组 JSON（`{cmd:"btw_ask", session_id, question, history, cwd}`，cwd 走与 `send_message` 同源的 `trusted` / `codegraph_enabled` 注入）下发 Runtime → 回传 `{status, reason?}`。
- `remote/rpc.rs` REGISTRY：`start_btw_session` 那行换成 `btw_ask`（F9：远程入口必须重建，不是兼容保留）。

### 4.2 sidecar

- `SessionManager` 新增"查但不建"路由：`workers.get(sid)` 命中才转发，未命中直接 rejected——**不调用 `getOrCreate`**。
- `SessionWorker.askSideQuestion()`：守卫 → 调用 → 广播 → 返回。守卫失败与 `null` 应答都走 rejected。
- 新事件类型 `btw_answer`，随 `chat-event` 通道广播（relay 全量转发，无需改帧契约）。载荷：
  `{ type:"btw_answer", session_id, question, response?, error?, synthetic? }`——`session_id` 是**主会话 id**（不是 question id），前端据此把事件路由到对应会话的抽屉；`question` 用于在同一会话的多条 btw 之间消歧。

  为什么错误也走事件而不是 RPC 返回值：worker 存在的路径上，RPC 返回值本身可以带 reason；但**任何"改变 UI 状态"的结果都必须上事件通道**（仓库多端红线），所以失败也广播一条带 `error` 的 `btw_answer`，各端一致渲染。RPC 返回值只用于发起端 `await` 的成败判定，不含正文。该事件**不可丢弃**（不进 `DROPPABLE_TYPES`——丢一条就少一个答案，不是增量文本）。

### 4.3 前端

- `packages/aide-sdk/src/api.ts` 新增 `btwAsk(params)` 门面方法（共享代码禁止裸 invoke）。
- `startBtw` 改为 `await api.btwAsk(...)`；正文等广播。
- `handleBtwEvent` 的 `btw_answer` 分支取代原来的 `text_delta` / `message_stop` / `session_init` / `session_dead` 四分支。
- 删除 `isBtwSid` / `btwTempId` / `btwRealId` / `cleanup()` / `composePrompt`。
- `historyByOwner` 保留（D4），但只作参数来源，不再拼进 prompt。

### 4.4 历史策略

| 情形 | 行为 |
|---|---|
| 成功应答 | 追加 `{question, response}`，超 20 轮丢最老（截断在前端做，下发的是已截断的数组） |
| `synthetic: true` | **正常渲染**，但**不入历史**（对齐官方"只把真实回答喂给 history"） |
| `null` 应答 / rejected | 当前问题标失败，不入历史 |

删除 `BTW_ANSWER_CAP`（64KB 截头保尾）——它是为 prompt 拼接服务的，history 变成消息后不再需要逐条截断。

## 5. 删除清单

| 层 | 删除物 |
|---|---|
| sidecar | `src/desktop/btwOptions.ts` 整文件（32 行）+ 其测试 |
| sidecar | `session-worker.ts`：轻量 prompt 尾指令（589-598）、`taskTools` 字段与分支、`cmd.tools` 分支、`lightweightMode` 透传 |
| sidecar | `session-worker/queryOptions.ts`：`taskTools` 三元判断、`tools`/`allowedTools` 白名单覆盖 |
| sidecar | `policy/sessionHook.ts`：轻量全 deny 分支（116-129）、任务白名单分支（211-226）、`ask→deny` 分支（178-190） |
| sidecar | `permissions.ts`：`isBtw` 守卫及其注释叙事 |
| 协议 | `engine/types.ts`、`headless-schema.ts`：`btw` / `lightweight` / `fork_from` / `tools` 四字段 |
| 前端 | `send-btw-task` 全链路（`ChatInputBox.vue` 两处、`ChatPanel.vue`、`PaneGroup.vue`）、`useQuickActions.ts` 的 `git-commit` 项与 `kind:"task"` |
| 前端 | 抽屉的轻量/完整 seg、`props.lightweight` 全链路、store 的 `taskId` / `taskLabel` / `taskIcon` |
| Rust | `start_btw_session` 命令与参数 DTO、REGISTRY 换行 |

**保留**：`stopChatSession`（用户停会话仍是真实路径）、`selfTeardown` + 幽灵会话清理（automation 在用，另一条真路径）、`btwMode` 值本身（btw 会话标记，随分支删除后仅剩路由意义）。

## 6. 验证

**单测（sidecar）**：mock `queryFn` 返回带 `askSideQuestion` 的假句柄

1. 无 worker 时返回 rejected，且**不触发** `getOrCreate`
2. 句柄缺 `askSideQuestion` 时返回 rejected，不抛异常
3. 成功路径：发出 `btw_answer` 事件，且**返回值不含正文**（保证 D3）
4. `synthetic: true` 时不入历史；`null` 应答时标失败
5. 历史超 20 轮丢最老

**实测（构建后重启）**：

1. 主 worker 空闲 30s 后调 `btw_ask` → 应返回并广播（验证 F1+F2 在真实应用成立）
2. 主轮进行中调 → 主轮不受影响（复现 F3）
3. 会话 stop 后调 → 得到 rejected 且前端显示友好提示
4. 对照探针基线，实测发送→广播延迟
5. **600s 超时行为**（F7）——官方对 `side_question` 用 600s，其余 75s，主 worker 上的实际表现未实测过

## 7. 已知代价与风险

| 项 | 说明 |
|---|---|
| 会话停止后不能 btw | D2 的直接后果，产品取舍。该场景老路同样冷启动，不值得为它养一套 fork worker |
| 刷新 / 换客户端后历史断片 | D4 的直接后果。若将来需要多端一致，需把历史移到 sidecar（重启这条决策） |
| SDK 漂移 | `askSideQuestion` 无类型（F4），SDK 升级改名即失效。靠运行时守卫 + 实测步骤 1 发现 |
| 事件与主流并行 | side question 与主轮 `text_delta` 可能同时在飞，前端必须按 `session_id` 路由 |
| 会话关闭中的应答 | CLI 会回 `"Session is shutting down"`，实施时统一降级为 rejected |
| 新增对外事件 | `btw_answer` 进事件契约，远程客户端需同步处理（鸿蒙未实现 btw，F8，不阻塞） |

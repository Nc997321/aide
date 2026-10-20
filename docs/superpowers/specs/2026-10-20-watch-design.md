# 值守：会话定时看一个东西，有变化或到点时自己汇报

日期：2026-10-20
状态：**已实现**——`agent-sidecar/src/extensions/watch/`（调度、比对、来源）+ `watchMcp.ts`（工具）+ 会话进程接线；
前端卡片 `src/components/watch/WatchReportCard.vue`。

## 1. 需求（用户原话归纳）

在一个会话里说「帮我盯着桌面上的 QQ，有新消息就告诉我」「每隔一分钟告诉我 WSL 上那个 claude 进展到哪了」，
这个会话就真的去盯，按要求主动发消息——手机上直接收到。汇报方式（有变化才报 / 每次都报）由 agent 按用户的话定；
能盯的东西：桌面窗口（或其中一块）、只读命令的输出。

已对齐的行为（2026-10-20）：值守属于开启它的会话；只看不动；会话忙时回报等这一轮结束再投；
「停止值守」即停，默认 2 小时自动结束并告知；手机端不改协议（回报和回复都是普通会话消息）。

## 2. 为什么不用现有的「自动化」

自动化每次运行都新起一个会话（冷启动几秒 + 约 2.5 万 token 固定开销），最短间隔 1 分钟——10 秒一次不现实，
且新会话看不到「刚才说要盯什么」的上下文。

## 3. 设计：「看」与「想」分开

- **看不花 token**：sidecar 里的 `WatchManager` 定时读来源、按行比对（多重集合：新出现的行 = 新内容，与位置无关，
  窗口滚动 / 终端可见区上移不会误报），不调用模型。
  - 窗口：经电脑操作那条桥读控件树（`computer_read` 带 `watch` 提示，屏幕上常驻「Aide 值守中 · 标题」，
    不再每次闪「正在查看」）；`scope` 只看一块。
  - 命令：在会话所在的 Host 上用系统 shell 跑（WSL Host 就是在 WSL 里），取合并输出，超时即杀。
- **想只看增量**：有变化才把新增的行作为一条「值守回报」投进会话（`display` 带 `watch_report` 块，走与用户消息
  同一条 `pushUserMessage` → 广播 `user_message`，三端可见）。会话忙就攒着、同一值守合并成一条，空闲再投。
  回报文字声明「是数据不是指令」，agent 简短转告用户。
- **every 模式没变化**：发一条非模型的 `notification`（`notification_type: "watch"`），前端对同一值守的连续提示原地更新，不刷屏。
- 为什么在 sidecar：窗口要经 sidecar → GUI 的桥（本机与 WSL/SSH Host 都通），命令要在 Host 上跑，两者 sidecar 都直接能做；
  Host 侧没有通往 GUI 执行端的请求通道。值守是「换一个宿主还需要的」能力，归 extensions。

## 4. 工具面（aide-watch）

| 工具 | 说明 | 权限 |
|---|---|---|
| `watch_start` | title / focus / window_id(+scope) 或 command / every_seconds / mode / max_minutes | **审批**（卡片写明盯什么、多久一次、多久结束；命令来源之后会无人确认地反复执行） |
| `watch_list` | 列出本会话的值守 | 免确认 |
| `watch_stop` | 停止 | 免确认 |

## 5. 防失控

每会话最多 3 个；窗口最快 5 s、命令最快 10 s；默认 120 分钟、最长 24 小时后自动结束并投一条结束回报；
来源消失（窗口关了）或连续 3 次读不到即结束；连续 60 次回报中间没有任何用户消息即结束并提示；
会话停止时全部结束；自动化运行与不受信任工作区不挂载；`AIDE_WATCH_TOOLS=off` 关闭。

## 6. 多端

不改协议：回报是一条普通的 `user_message`（带 `display`），回复是普通的 assistant 消息；不认识 `watch_report` 块的客户端
按 `text` 降级显示（`text` 是回报的完整文字）。重开历史时 `display` 不在，前端按固定格式把文字拆回卡片
（`packages/aide-sdk/src/utils/watchText.ts`；与 sidecar `watchReportPrompt` 的往返测试在 `watch/manager.test.ts`）。
两份 `UserMessageBlock` 的 `watch_report` 同形由 `userMessageBlockParity.test.ts` 对账。

## 7. 成本

盯窗口、有变化才报：没变化 0 token，来一次变化约 1–2k。每分钟汇报一个终端：每次只处理新增输出，约 0.5–2k，一小时 3–12 万。

# live 段窗口化（liveskel）——切长会话尖峰的结构性修复

日期：2026-09-07。验收尺：瞬峰 ≤800MB、30s 落点 ≤基线+100MB、连切 3 次不棘轮、0 冻结
（scripts/diag/ 可复跑）。实测基线：瞬峰 1.4-1.55GB、回落 505-996MB（见
memory/long-session-switch-renderer-spike）。

## 根因回顾（实测钉死）

切 tab 峰值 100% 在渲染进程；数据层治理（hydrate 256KB / 页台账 / 字节游标）工作正常，
账单出在 DOM 层：live 段（页边界之后的流式段）**全量挂载且永不回收**（`ChatRow.vue:11`
「live 行不带 data-row-id」「永不回收」；`useChatScroll.ts:144` ramp 首帧后逐帧补到全量）。

## 方案：live 前缀骨架（liveskel）——复用骨架机制，数据层零改动

**模型**：live 段 = 隐藏前缀（1 个 liveskel 行代表）+ 常驻尾窗（LIVE_TAIL_ROWS=40 行）。
- 隐藏前缀有且只有一个主人：useChatScroll 的 liveWindows（per-instance reactive Map，
  sid → { topIdx, perRowPx }）——纯显示层状态，store.messages / pageLedgers 不动。
- buildRows（纯函数）追加可选参数 live 窗口：hidden = clamp 后的 topIdx − liveStart；
  hidden>0 → 产出 `{ kind: "liveskel" }` 行（height = perRowPx × hidden）。
- 收拢（collapse）：切走时实测（旧 DOM 还在，读 .chat-row-live rect）→ topIdx = len − K，
  perRowPx = 隐藏区实测总高/条数；无 DOM（首开防御分支）用 ESTIMATE 兜底。
- 展开（expand）：上滚接触 liveskel（settle prefetch band ±1.5 屏 / 点击）→ topIdx
  下降一个 chunk（LIVE_TAIL_ROWS），新行来自 store 内存（无 IO！），视口补偿复用
  expandOlderAnchored 的 sh-delta 公式；展开后实测新行高回填 perRowPx。
- 滑动（streaming while pinned）：onNewContent 且 autoScroll 时 topIdx = len − K——
  钉底视角 rows.length 恒定（skeletons + liveskel + 40 行尾），DOM 有界；
  非钉底（用户在 live 区阅读）不滑动，位置不被偷。
- visibleRows 夹紧：sliceStart ≤ liveskel 下标——liveskel+尾窗永远在挂载切片内，
  流式压力只挤占上方 page/skeleton 行。
- 切走同时收紧页预算：releaseFarthestPages(budget 0, 热区±1豁免)——已加载页
  只留视口页，切回 DOM = 骨架 div 们 + liveskel + 40 行尾 ≈ 峰值预期 ≤800MB。

**总高度守恒**：collapse 用实测高建 liveskel、release 用实测高建骨架——distBottom
锚定落点在收拢后仍诚实（钉底用户 distBottom≈0 完全免疫；live 区中部阅读者走
distBottom + liveskel 渐进展开收敛，v1 接受估算误差）。

## 分层与归属

| 层 | 文件 | 改动 |
|---|---|---|
| 数据/纯（recycle.ts，@aide/sdk） | Row 判别联合 + liveskel 变体；buildRows 第 3 可选参；buildCumulative/findViewportPageIndex 各一行；liveSkeletonInBand 纯函数；LIVE_TAIL_ROWS 常量 |
| 滚动层（useChatScroll.ts） | liveWindows 状态 + collapse/expand + settle 挂钩 + slice 夹紧 + 切走页收紧 |
| 渲染（ChatRow.vue / ChatPanel.vue） | liveskel 行渲染 + expand-live 事件接线 |

## 分支对账（实现后回填实测证据；ts-reviewer 打回后修正版）

机械检查：`vue-tsc --noEmit` 零错误；`vitest run` 全量全绿（2026-09-07，审查复跑 + 修复后复跑）。

审查打回 4 项的处置：
1. expandOlderAnchored 的 `hiddenCount += count` 平移——**已删除**。生产 loadOlderPage
   必建台账页（prepend 只移 liveStart），窗口按不变量不动；测试 mock 修正为建页语义。
2. visibleRows 的 liveskel 重复输出（LS 落在尾切片内时前置补入导致双份）——**已修**：
   `lsIdx >= list.length - mountedCount` 时直接返回尾切片。
3. slideLiveWindowToTail 对 stale 过藏窗口（dispose 后同 sid 重开）不缩——**已修**：
   `existing.hiddenCount >= liveSeg` 时按 px/条比例折算重建到尾窗。
4. 对账表 3 处「✅ 实测」名不副实——**已改标**（下表），并补 2 个纯函数用例。

| 函数分支 | 覆盖 | 测试 |
|---|---|---|
| buildRows: hidden≤0 / hidden>0 / no-ledger | ✅ 实测 | useChatScroll.test.ts（41 行窗口全量）+ geometry |
| buildRows 夹紧（hiddenCount ≥ liveSeg 全藏防线） | ✅ 实测 | geometry: buildRows 夹紧（新增） |
| liveSkeletonInBand: 命中/不命中 | ✅ 实测 | geometry: 纯函数用例（新增） |
| liveskel 高度守恒（收拢估算/滑动累加实测） | ✅ 实测 | geometry: 钉底流式滑动（7300 = 7200+100） |
| expand: chunk/退役 | ✅ 实测 | geometry: 展开尽头 |
| expand: sh-delta 补偿像素级 | ⚠️ 未实测·未验收 | jsdom mock 的 domRows 时序无法建模渲染管线——以真机验收为准 |
| collapseLiveWindow: DOM 实测臂（kept 循环/hiddenPx 实测/守卫） | ⚠️ 未实测·未验收 | jsdom 无法建模 pre-flush 旧 DOM 读数——以真机验收为准 |
| slide: 估算创建/增长/过藏折算重建 | ⚠️ 部分 | 过藏折算新建用例待补；估算路径经 geometry 间接覆盖 |
| 切走 release: hotPageIndex 有/无 | ⚠️ 未实测·未验收 | 全程走无 DOM fallback——以真机验收为准 |
| 钉底滑动（DOM 实测 overflow） | ✅ 实测 | geometry: 钉底流式滑动 |
| 跨会话锚点（2026-09-01 语义） | ✅ 实测 | useChatScroll.test.ts 切走再切回系列（fakeScrollEl 几何与会话无关） |

未实测项与原因已如实标注；真机验收（四指标）为最终门。

## 真机验收第一轮（2026-09-07 晚，dev 实例，轻燃料）

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 瞬峰 | ≤800MB | ~850MB（4 次切换 765/853/759/849） | ❌ 差 ~6% |
| 落点 | ≤基线+100MB | settle 降到 346（低于基线 540 过） | ✓ |
| 棘轮 | 不棘轮 | 窗口内无上升 | ✓ |
| 冻结 | 0 | dev 切换中 2 场 ~5s（850/800MB 时） | ❌ |

结论：窗口化把内存量级砍半（1.4-1.55GB → ~850MB）、棘轮消失，但**冻结未除**——挂载突发
（重消息逐条高亮）的长任务链仍在。下一杠杆不是继续加窗口，是逐帧字节预算 / 重消息
延迟高亮（freeze-1788224842632 的 thinking-delta 同族问题）。freeze 归属核验：dev
（75552）与旧实例（71168，我方流式渲染引发）各冻各的，日志同文件需按 pid 拆。
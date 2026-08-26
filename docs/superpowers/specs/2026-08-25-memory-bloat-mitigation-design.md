# 会话内存膨胀治理 设计

- 日期：2026-08-25
- 状态：方案已定案（2026-08-25 评审）；**P0 + P1 + P2 全部完成**——P0-1 生命周期收口、P0-2 回填解耦、P0-3 旧消息淘汰、P1 双向分页（后端 `load_messages` 字节游标 + 前端「尾部常驻 + 上方按需取回/远端释放」+ `last_jsonl_message` seek 优化；2026-08-26 实施，1485 passed + vue-tsc + 后端 llvm-cov 分支实测）。P2 收敛放大器 2026-08-26 同日落定：P2-1 子代理 entries 写入上限（SUBAGENT_ENTRY_CAP 256K 字符截保尾 + 摊还截断，types 加 entry.truncated/resultTruncated）、P2-2 renderCache 单条上限（256K 字符超限不入缓存 + 测试钩子）、P2-3 btw historyByOwner 双上限（20 轮丢最老 + answer 64K 截保尾）+ disposeSession 清理、P2-4 rounds 双实例合一（App.vue 唯一实例 props 透传）+ §10.1 顺手优化（save_session_changes 改 JSONL 追加式 append_session_change 单轮 O(1) 落盘，load 兼容旧 pretty 数组）。全量 1497 passed + vue-tsc + Rust 641 passed（1 个 Ollama 依赖已知非回归）。**P1 补缺 2026-08-26（预览实测「滚动条很小」）**：① 上翻收回——`loadOlderPage` 取回后立即把最老的旧 full 页降级为骨架（取回只发生在顶部，旧页必然已在视口外 ≥1 页）；顺带修 `sessionPagination.pages` 与 store 数组顺序错位的潜伏 bug（原 push + unshift 使 pageStartIndex 定位错页，翻页释放/恢复会降级到错的内容，单页测试掩盖）。② §10.1 两层窗口合并落地——useChatScroll 去掉 mountedCount 二次切片，数据窗口即挂载目标。③ **「条」计量改「估算字节预算」**：窗口 256KB 预算 + 后端 limit 字节语义（见 P1-1 补缺）。全量 1500 passed + vue-tsc 零错误；字节预算落地后 1502 passed。
- 作者：Heaven + Claude（诊断）

## 1. 背景与现象

用户反馈：**随对话继续，内存膨胀，整个应用都会变卡**（不挑操作，越用越普遍地慢）。

项目历史上 2026-07-08 做过一轮「主线程阻塞型卡死」治理——重 IO/CPU 命令全 `async + spawn_blocking`、`trace_command` 埋点、watchdog 黑匣子（pending 探针 + isHung + park 抓栈 + `freeze-*.json` 落盘）。**那类卡死已堵住**（见 `docs/superpowers/plans/2026-07-08-main-thread-blocking-hardening.md`）。

本次卡顿**性质不同**：不是某条同步命令堵死主线程（watchdog 报告里 `stuckCommand=None`、`pending` 不单调爬），而是 V8 堆随对话单调膨胀 → GC 停顿越来越长 → 全局卡顿。**旧的防护网没覆盖这一类。**

## 2. 诊断结论（根因）

**一句话：窗口化只省了 DOM 节点（尾部 15 条），没省内存里的数据。**

`store.messages` 全量持有所有打开过会话的全部 transcript——每条消息的 `tool_result` 全文（MB 级）、子代理 `entries`（10-50MB）、base64 图片、thinking 全文都**不截断、不淘汰**；关 tab、删会话都**不释放**。随对话线性膨胀到 GB 级 → V8 堆膨胀 → GC 停顿 → 整个应用卡。

### 2.1 全栈真泄漏排查：干净

泄漏假设已排除——所有重资源实例销毁链都正确：

| 资源 | 销毁情况 | 位置 |
|---|---|---|
| xterm Terminal | `onBeforeUnmount → dispose()`，每块 1 个、卸载即销 | `BashOutputBlock.vue:37-39`、`BgTaskDock.vue:109-117`、`useWorkbenchTerminal.ts:373-387` |
| CodeMirror EditorView/MergeView | 卸载 `destroy()`，prop 变化走 reconfigure 不重建，`createId` 竞态守卫 | `DiffViewer.vue:220-223`、`CodeEditor.vue:631-639` |
| ResizeObserver | 全部 `disconnect` | `ChatPanel.vue:107`、`useChatScroll.ts:314/401` 等 |
| addEventListener / setInterval | 全部成对 remove/clear | 全库核对 |
| Tauri `listen` | 基本都有 `unlisten`（例外见 §2.3） | `App.vue:957`、`useChatSession.ts:1103` 等 |
| sidecar SessionWorker | 停会话从 workers Map 摘除销毁 | `session-manager.ts:164-170` |
| Rust PTY | 子进程退出 waiter 线程自动 `map.remove` | `shell.rs:305-307` |
| DeltaCoalescer / stdoutFrames | 40ms flush 清空 / 背压丢弃不缓冲 | `deltaCoalescer.ts:77-86`、`stdoutFrames.ts:73-94` |

**结论：不是泄漏，是「合法全量持有 + 无淘汰 + 生命周期不收口」。**

### 2.2 内存膨胀源排行（按贡献）

| # | 源 | 位置 | 上限 | 量级 |
|---|---|---|---|---|
| 1 | `store.messages` 全量 transcript（关 tab/删会话不释放，含 tool_result/thinking/子代理/图片全文） | `useChatSession.ts:182,302` | 无 | 长会话几十~上百 MB |
| 2 | `stores` 字典：已关闭/已删除会话永久持有 | `:182` + `stopSessionById:399` 不 `delete` | 无 | 把 #1 ×会话数 |
| 3 | 单条大消息全文本块（tool_result / 子代理 entries / base64 图片） | `:685, 873-951, 526` | 无 | 1 条 10-100MB |
| 4 | claude.exe 进程（每活跃会话 1 个，含分屏/btw fork） | `session-worker.ts:1075` | 有界×会话数 | 数百 MB/个，SDK 性质不可控 |
| 5 | `renderCache` 300 条整块文本+HTML | `markdown.ts:65` | cap 300，单条无上限 | 最坏数十 MB |
| 6 | `btw historyByOwner` 问答全文 | `useBtwSession.ts:48` | 无 | 慢增长 |
| 7 | `rounds` 双实例 + 磁盘无限增长 | `useConversationChanges.ts:11` ×2（`App.vue:358` + `ChangeLogPanel.vue:11`） | 无 | 中等 |
| 8 | per-sid 小字典族（aliasMap/lastDispatchedPrompt/names/workspaces/providers/prevStates/nameCache） | 多处 | 无 | 轻微但无限 |

### 2.3 次要开销（非膨胀，顺带记）

- `useAutomation.ts:137` 注册了**第二个** `chat-event` 监听且从不 `unlisten`——单例不累积，但每条 chat 事件被处理两遍，常驻开销。
- `useNotification.ts:88` 对持续增长的 reactive Record 做 deep watch，每新增会话 key 触发遍历——性能开销非内存。

### 2.4 量级估算

JS 字符串 UTF-16 ≈ 2 字节/字符：

| 内容 | store 持有 | 备注 |
|---|---|---|
| 1MB 文本的 tool_result | ~2MB | Bash 大输出 / Read 大文件 |
| 500KB 代码块定稿文本 | ~1MB + renderCache HTML ~1.5MB | |
| 1MB base64 图片 | ~1MB | 用户截图粘贴 |
| 1 个典型子代理块 | 10-50MB | prompt + 全部增量 + tool input/result 全文 |

**一轮普通对话 ≈ 0.5~5MB；一轮重对话（大 grep/日志）≈ 10-100MB；30 轮重对话 ≈ 300MB~3GB**——与「随对话继续整个应用变卡」完全吻合。

## 3. 已有机制盘点（为什么没挡住）

### 3.1 有效但只挡了一半

| 机制 | 挡住了 | 没挡住 |
|---|---|---|
| 尾部窗口化（`useMessageWindow.ts:47` 尾部 15 条）+ ramp 分帧（`useChatScroll.ts:321`） | DOM 节点爆炸 | store 数据全量在内存 |
| `bgTasks` 50×256KB cap（`useChatSession.ts:211`）、`renderCache` LRU-300、trace ring 512、scrollTrail 3000 | 各自局部 | messages / rounds / stores 字典无 cap |
| `async + spawn_blocking` + watchdog 黑匣子 | 主线程阻塞型卡死 | 内存膨胀型卡顿 |
| 流式不跑 hljs + 定稿缓存 | 高亮 O(n²) | 流式尾块每 delta 全量 `marked.parse`（`markdown.ts:85`，另一条独立卡点） |

### 3.2 缺口（完全无机制）

- `messages` / `rounds` / `stores` 字典：无 cap、无淘汰、关 tab/删会话不清理
- 单条消息内 block 全文：无截断（tool_result / 子代理 / 图片）
- `tool_result` 回填：每事件 O(N) `store.messages.flatMap(m => m.blocks).find(...)`（`useChatSession.ts:678`），长会话每次工具事件都分配新数组 + 全量扫描，本身也是变卡贡献者

## 4. 关键前提验证（方案可行性的基石）

`useMessageWindow.ts:4-6` 注释声称「数据层照旧全量在 store（事件回填 tool_result 需要全量在场）」。**经全代码库核查，此理由不成立。**

### 4.1 tool_result 回填只访问目标 block 本身

回填代码（`useChatSession.ts:677-690`）按 `tool_use_id` 找 pending 的 `ToolCallBlock` 回填 `result`。全库同款 `flatMap.find` 共 6 处（`tool_result` + 5 处子代理事件 `:890-950`），**全部按 id 找 pending 块**；已收到 result 的 block 后续没有任何事件或功能再访问。

### 4.2 各功能对旧消息全文本的依赖

| 功能 | 依赖全量？ | 说明 |
|---|---|---|
| `tool_result` 回填 | 否 | 只需 pending 块在场 |
| 变更面板撤回 `revertRound` | 否 | 只做磁盘截断 + git 恢复 + 清 rounds，不读 store.messages（`useConversationChanges.ts:164`） |
| 会话全文搜索 | 不存在 | SearchPanel 是文件 grep；无消息文本搜索 |
| 上滚加载 `expandOlder` | **是** | `hiddenCount = source().length - windowSize`，数据源必须含全部历史 |
| 导出/复制消息 | 不存在 | 无导出会话功能 |
| diff 变更卡重放 | 否 | 从该 block 自身 input + 磁盘当前文件构建，块淘汰只影响可见性 |

**真实依赖全量的只有上滚 `expandOlder` 一个功能。** 普通工具的 in-flight 窗口只有一回合、必在消息尾部，天然不受「淘汰最早消息」触及；唯一跨回合的是 async 子代理（极小集合，淘汰时跳过含 `isPending` 块的消息即可）。

### 4.3 后端 `load_messages` 分页能力

当前 `load_messages_blocking`（`session.rs:452`）整读 `.jsonl` + 两遍扫描，无 offset/limit。**改造难度低-中**：加 `offset_bytes`/`limit` 从文件尾部按字节游标往前读（比行号游标好——`.jsonl` 可被 `revertRound` 按字节截断，行号会漂移）；以「完整 user 行」为切片边界避免半截回合。既有消费者仅 `api.ts:233`（hydrate 一处）+ remote 桥透传。

## 5. 治理方案（分级，从结构上解决）

### 5.0 目标态：微信式「只加载不回收」分页

最终形态（2026-08-26 终稿，用户拍板「要简单、代码结构清晰」）：打开预览只取**尾部一页**（256KB 字节预算），往上滚到顶按需取回更早页 `unshift`，**不释放、不回收、不窗口化**——翻多少渲染多少，DOM/内存由 store 的 `maybeEvict`（P0-3，估算字节 > 64MB 时大 block 降级保留消息结构）兜底。

**聊天 vs 微博的关键差异**：微博最新在顶部、滚走即释放、微博式回收语义匹配；聊天最新在底部且**内容会一直持续输出**（活跃会话流式钉底），上滚回收在活跃态语义崩坏（输出中内容被回收）。曾实现微博式整页回收（⑦⑨），用户实测「一直加载同一个页面」暴露方向敏感复杂度后拍板废弃：**分页只解决「打开不全量加载」，内存上限交给 store 层降级，两层职责分离**——滚动层（微信式：取回 + 锚定 + 置底）不做内存管理，store 层（maybeEvict）不管滚动。

**页级分页绕开测量难题**：不需要像素测量，滚到顶部触发带取回一页，滚动锚定复用 `prevTop + (scrollHeight - prevHeight)`。

**三个 aide 特有约束**：
1. **流式钉底**——尾部 N 条常驻不释放，流式期窗口始终包住尾部
2. **pending 块**——tool_result 未回填的 block 必须保留（P0-2 Map 解耦后淘汰与回填无关）
3. **折叠态丢失**——窗口外卸载再取回，折叠/展开状态不持久化（当前就不持久化，会重置）；若需保留要单独存折叠态字典

P0 是无后端时的止血态（单向淘汰最早），P1 字节游标直接按双向分页设计，合起来达成目标态。

### P0 — 纯前端，解决 ~90% 膨胀

**P0-1 生命周期收口**（最大收益：多会话场景把膨胀 ×会话数）

- 关 tab / 删会话时 `delete stores[sid]`（当前 `closeTab` `usePaneLayout.ts:228`、`stopSessionById` `useChatSession.ts:399` 都不 delete）
- 注意区分：**stop 会话**（会话停了 tab 还开着，store 要留——用户还能看历史）vs **关 tab / 删会话**（store 该清）
- 同步清 per-sid 字典：`removeSessionState`、`aliasMap`、`lastDispatchedPrompt`、btw `historyByOwner`、`names`、`workspaces`、`providers`、`prevStates`、`nameCache`
- 收益：一次 app 运行中不再累积所有打开过会话的全量 transcript

**P0-2 回填解耦**（消掉每事件 O(N) flatMap，并为 P0-3 淘汰扫清依赖）

- 模块级 `pendingToolCalls: Map<tool_use_id, ToolCallBlock>`、`pendingSubagents: Map<subagent_id, SubagentBlock>`
- `tool_use_start` / `subagent_start` 创建 block 时登记入 Map；`tool_result` / `subagent_end` 回填后 `delete` 条目
- 6 处 `flatMap.find` 改 Map 查（O(1)），不再每事件分配新数组
- 收益：长会话每次工具事件从 O(总 block 数) 降到 O(1)；淘汰旧消息后回填不依赖全量消息在场

**P0-3 旧消息淘汰**（止血态：无后端时单向淘汰最早；P1 落地后升级为双向分页的远端释放）

- 在 messages 增长后检查阈值，淘汰最早的、不含 `isPending` 块的消息（pending 块的消息必在窗口尾部，淘汰触及不到，双重保险）
- 淘汰后 `hiddenCount` 相应减小，上滚「到此为止」（P1 再恢复按需取回）
- 淘汰粒度/策略见 §6 决策点

### P1 — 需后端，达成双向分页目标态（低-中难度）

**P1-1 `load_messages` 字节游标**：加 `offset_bytes`/`limit` 参数，支持从任意字节位置往前取一页。前端从「尾部固定 + 单向扩窗只增不减」升级为「尾部常驻 + 上方按页取回」：上滚到页边界时取回更早页 `unshift`（~~远端页滚出视窗后释放~~——终稿取消释放，见 ⑩）。双向游标翻页，上滚不再「到此为止」。✅ 2026-08-26 补缺：上翻取回即收回（`loadOlderPage` 取回后释放最老的旧 full 页）——此前释放只在下滚出 3 屏外触发，向上翻历史时取回页只增不减，DOM 条数 = 15 + 30×翻页次数，滚动条越来越小（预览实测暴露）。✅ 2026-08-26 同日再改：**「条」计量全面改「估算字节预算」**——窗口/hydrate/取回页从「尾部 N 条消息」改「尾部累计字节 ≤ 预算」（默认 256KB；最新 1 条无条件保底）；后端 `load_messages` 的 `limit` 语义同步从「目标条数」改「页行字节累计」，前后端对齐。单条超大 tool_result 占预算多 → 窗口条数自适应收缩，打开预览的滚动条不再虚小。✅ 2026-08-26 实测修复「字节化放大上翻卡死」四个坑：① 取回后预算按**新页实际估算字节**扩（固定 +pageBytes 是「行字节」，前端估算 UTF-16×2 放大 → 新页永远差一截不可见）；② 本地扩窗步进 = max(stepBytes, 隐藏首条字节)（单条 10MB 消息不用扩几十步）；③ 恢复加「内存全可见且无可取页」门槛（顶部翻页时恢复会挡取回）；④ **空页根因（核心）**——`trim_to_bytes` 的「页首裁到 user 行」在「预算窗口内没有真实 user 提问行」时（长会话尾部工具轮密集，256KB 预算内全是 assistant/tool_result/系统行；实测 170+ 大会话文件里 20+ 个 hydrate 返回空页 + nextOffset=0）→ 空页把 `tailOffset` 掐成 0 → `hasMore=false` → 预览打开「无按钮、无法继续往上翻」——旧条数页（30 条必含多回合、必有 user）几乎不触发，字节页（可能只含 1-2 个大工具轮）放大触发（正是「之前就有、本次放大」）。修复：预算内无 user 时**回退保留预算内全部**（页首可非 user），游标继续向前；补 Rust 测试 `budget_without_user_line_keeps_page_and_cursor` + 真实文件复刻验证 6 个空页文件全部恢复游标。（前端 1508 passed + vue-tsc 零错误 + Rust 643 passed，1 个 Ollama 依赖已知非回归）✅ 2026-08-26 体验改进（微博式连翻）：⑤ **camelCase 序列化根因**——`LoadMessagesResult` 缺 `#[serde(rename_all = "camelCase")]`，前端读 `nextOffsetBytes` 恒 undefined → tailOffset=undefined → hasMore 恒 false → 上滚取回永不触发（诊断环实测 `pager hydrate tail=undefined` + `tryExpand blocked hm=false`；测试全用 camelCase mock 从未暴露；修 + 回归测试）。⑥ 翻页体验三改：触发带 80px → `max(80, 一屏×0.6)`（距顶一屏内预加载，不必精确滚到顶）；取回在途时顶部滚动记 `topPending`，完成后自动续取下一页（不再「往下滑再往上滑」重新触发）；切会话清 pending。⑦ **释放机制重构（用户实测「滚动条还是越来越小」）**——骨架降级（保留消息结构）随翻页累积 DOM 高度，改为**微博式整页回收**：`releaseOldestPage` = 整页 splice 移除 + 页记录标 `loaded=false`（保留 offset/count/bytes，不回退游标）；滚回时 `restoreNearestPage` 按页记录（offset + 精确行字节 limit）取回插回原逻辑位（Σ 更老 loaded 页 count）——无 marker/骨架占位，DOM 高度与翻页数解耦。⑧ **useChatSession 拆文件（2026 行 → 宿主 703 行）**：`useChatSession/` 子目录四模块——`state.ts`（per-sid store + 生命周期）、`evict.ts`（P0-3 阈值降级）、`pagination.ts`（双向分页 + 微博式释放）、`events.ts`（handleChatEvent 路由）；宿主只留门面 + 发送链路 + re-export。⑨ **恢复方向敏感（用户实测「一直加载同一个页面」）**——「取回即释放 + 到顶优先恢复」循环：取 P2 释放 P1 → 滚回再翻到顶 → hasUnloadedPage 优先恢复 P1（旧页）而非取更早 P3 → 内容不前进。修复：**恢复只在向下滚回方向触发**（onScroll 方向判定），向上翻永远取更早页；恢复完成仍停顶部时续取更早页。⑩ **终版定案：删整套回收机制，回到微信式「只加载不回收」（2026-08-26）**——⑦⑨ 的页记录 + releaseOldestPage/restoreNearestPage 复杂度堆叠触顶，用户拍板「做简单、代码结构清晰」；且回收的内存收益已被 P0-3 `maybeEvict`（store 估算字节 > 64MB 降级大 block）覆盖，两层职责本应分离（滚动层不管内存、store 层不管滚动）。**废弃**：页记录数组、`releaseOldestPage`/`restoreNearestPage`/hasUnloadedPage、`useMessageWindow.ts`（整文件删除）。**保留的唯一形态**：游标 = `tailOffset` 一个数字；`loadOlderPage` = 取一页 `unshift` + 游标前进 + `maybeEvict` 兜底；`useChatScroll` = 顶部触发带（`max(80, 一屏×0.6)`）+ 在途 `topPending` 自动续取 + 视口补偿（`prevTop + Δ`，加载期间用户滚动则放弃补偿）+ 取回后 `mountedCount` 到顶（新页立即全挂载，不做 ramp 渐进）；首帧渲染预算（mountedCount 6→全量，每帧 +40）保留，只防切会话首帧 jam。内存模型：**store 估算字节有界（maybeEvict）+ DOM 条数 = 用户实际翻页量**——打开只 hydrate 尾部一页滚动条不小，翻多少渲染多少，超长会话由 maybeEvict 在数据层降级大 block。使用 ChatPanel 绑定只剩 `hasMore`/`loadOlder` 两个函数。（前端 1484 passed + vue-tsc 零错误；Rust 侧 `load_messages` 字节游标 + 空页回退 + camelCase 序列化不变）

**P1-2 滚动锚定** ✅：上滚取回时 `prevTop + (scrollHeight - prevHeight)` 保持视觉位置（`useChatScroll.expandOlderAnchored`）；**加载期间用户滚动则放弃补偿**（`el.scrollTop !== prevTop` 检测），不把用户正在看的位置拉走。终版无释放，原「远端页释放时延迟释放」条款随回收机制一并废弃。

**P1-3 折叠态持久化（可选）**：若用户在意折叠/展开状态跨卸载保留，新增 `foldState: Map<blockId, boolean>` 字典，远端页释放时存当前折叠态，取回时恢复。不做则保持现状（重置为默认折叠）。

### P2 — 收敛放大器（2026-08-26 全部完成）

- **P2-1 子代理 entries 文本上限** ✅：`SUBAGENT_ENTRY_CAP = 256K` 字符（类比 `BG_TASK_OUTPUT_CAP`），text/thinking delta 累积超 2×cap 截保尾（摊还 O(1)/delta，避免流式热路径 O(n²) slice），tool result / subagent_end 产出超限即截；类型加 `entry.truncated` / `block.resultTruncated`（独立于 P0-3 整块降级标记，不干扰 degradeBlock 幂等），UI 复用 `truncatedLabel` 小标（text/thinking 随行、tool 经 asToolBlock 透传 ToolCallBlock 的 `.ti-truncated`）
- **P2-2 `renderCache` 单条体积上限** ✅：`RENDER_CACHE_MAX_TEXT_CHARS = 256K` 字符，超阈直接 parse 不入缓存；测试钩子 `__renderCacheSizeForTest`（不能靠「重复渲染引用不同」断言——marked.parse 本身对相同输入返回同引用，实测 SAME: true）
- **P2-3 `btw historyByOwner` 上限 / 关 tab 清理** ✅：每 owner 轮数上限 20（丢最老，digest 重新编号）+ 单轮 answer 64K 截保尾；`disposeSession` 调 `clearBtwHistory(sid)`（后台仍跑的 btw 完成时重建单轮条目，owner 已关无人消费，无害）
- **P2-4 `rounds` 双实例去冗** ✅：App.vue 唯一 `useConversationChanges` 实例（badge + 面板共用），ChangeLogPanel 改 props 透传（`rounds`/`revertRound`/`revertSingleFile`）——面板恒挂活动会话，sessionId 与实例恒同，安全合一

### 不可控

- **claude.exe 进程**（#4）：每活跃会话一个，数百 MB，SDK 性质。停会话时 sidecar 已销毁 worker，但主会话常驻是设计。aide 层无法回收，不在本方案范围。

## 6. 决策点（2026-08-25 评审定案）

以下决策已拍板，作为实施的输入约束：

| 决策点 | 候选 | 已定 | 理由 |
|---|---|---|---|
| **淘汰粒度** | A 整条最早消息删除 / B 窗口外单 block 降级（tool_result→摘要，保留消息结构） | B | A 丢消息结构，上滚看到的是「断崖」；B 保留气泡骨架只省大 result 内存，上滚体验连贯，且 P1 取回时只补 result 全文 |
| **淘汰触发度量** | 消息条数 / block 数 / 估算字节数 | 估算字节数 | 条数/block 数对「1 条 50MB 子代理」无感；字节阈值直接对应内存目标。可在 push 时累计 `store.bytes` 估算 |
| **窗口语义** | 单向尾部+淘汰最早（保守）/ 双向分页（微博式） | 双向分页（终稿：微信式只加载不回收） | 分页只解决「打开不全量加载」；「释放有界」由 store 层 `maybeEvict` 兜底（两层职责分离）。微博式整页回收（⑦⑨）实测方向敏感复杂，终稿废弃 |
| **回填 Map 作用域** | 模块级单例（跨会话共享）/ per-session（随 store 生命周期） | per-session | 模块级单例会跨会话残留 pending 条目；per-session 随 `delete stores[sid]` 自然清空，与 P0-1 收口一致 |
| **`renderCache` 与淘汰协同** | 窗口外消息卸载时清其缓存条目 / 保持全局 LRU-300 | 保持现状 | LRU-300 已有界，窗口外缓存命中回滚时反而省重解析；单条体积上限（P2-2）已够 |

## 7. 测试与验证护栏

- **内存测量**：Windows 任务管理器看 `msedgewebview2.exe`（前端堆）vs `aide.exe`（Rust）vs `claude.exe`（SDK）；或 DevTools Memory 面板拍堆快照对比治理前后
- **回归场景（不能退化）**：
  - 上滚加载历史（P0 退化态：到淘汰点为止；P1：触底取回正常）
  - 变更面板撤回 `revertRound`（不读 store.messages，应不受影响）
  - diff 变更卡展开重放（从 block input + 磁盘构建，不受影响）
  - 流式输出中 tool_result 回填（pending 块消息在窗口尾部，不被淘汰）
  - async 子代理跨回合回填（pending 块消息跳过淘汰）
- **黑匣子护栏**：`freeze-*.json` 的 `event_rates` / `ring.trace` 确认无新卡死；watchdog `pending` 不单调爬
- **阈值回归基线**：同体量长会话（30+ 轮含大 tool_result），治理前后 `msedgewebview2.exe` 堆对比，目标从 GB 级回落到百 MB 级

## 8. 不做的事（YAGNI）

- **虚拟滚动**：尾部窗口化 + ramp 分帧已挡住 DOM 爆炸，引入虚拟滚动要在「高度不定 + 流式增高 + 折叠卡片」下做测量，复杂度不划算；本次内存问题在数据层不在 DOM 层
- **claude.exe 进程回收**：SDK 性质，主会话常驻是设计
- **流式尾块每 delta 全量 `marked.parse`**：这是另一条独立卡点（流式期 O(n²)），与本方案（内存膨胀）正交，另案处理（如未来给 ThinkingBlock/text 尾块加前端帧节流，见 `2026-08-07-thinking-streaming-design.md` §8「缓冲」未来项）
- **会话全文搜索**：当前不存在该功能，不为假想需求保留全量消息

## 9. 实施顺序建议

1. **P0-1 生命周期收口**（独立、零风险、最大收益）→ 验证多会话堆不累积
2. **P0-2 回填解耦**（为 P0-3 扫清依赖，本身消 O(N) flatMap）→ 验证工具事件不退化
3. **P0-3 旧消息淘汰**（依赖 P0-2）→ 验证长会话堆回落、上滚到淘汰点为止
4. **P1 字节游标** → 恢复上滚触底取回
5. **P2-1~P2-4** → 收敛子代理/renderCache/btw/rounds 放大器

每步独立可验证、可回滚，不合并成一个大补丁。

## 10. 新机制带来的简化与新能力

引入双向分页 + 生命周期收口 + 回填解耦后，既做加法也做减法——部分旧机制被取代可删，部分以前做不到的成为可能。评审时请同时看「加什么、减什么、打开什么」，而非只看加法。

### 10.1 可淘汰/简化的旧机制

| 旧机制 | 现状 | 新机制落地后 | 性质 |
|---|---|---|---|
| `store.messages` 全量保留 + `useMessageWindow`「扩窗只增不减」 | 内存膨胀直接根源；`useMessageWindow.ts:4-6` 注释明说「数据层照旧全量在 store」 | 打开只 hydrate 尾部一页；store 估算字节有界（`maybeEvict` 64MB 阈值降级大 block）；`useMessageWindow` 整模块删除，滚动层只管取回/锚定/置底、不管内存 | 新机制直接取代 |
| `tool_result` 回填的 `flatMap.find` O(N) 全表扫描（6 处，`useChatSession.ts:678`+890-950） | 每个工具事件全量扫描 + 分配新数组，随会话变长线性退化 | P0-2 `Map<id,block>` 解耦，6 处全删改 O(1) 查 | 新机制直接取代 |
| `useChatScroll`「上滚扩窗一次性同步挂 30 条」（`expandOlderAnchored`） | 注释自认「上滚的卡是后续议题」 | 上滚取回一页后 `mountedCount` 到顶一次挂载（一页条数，几十条可接受）；不再同步挂全部已加载数据 | 新机制直接取代 |
| 两层窗口叠加（`useMessageWindow` 尾部 15 + `useChatScroll` mountedCount 6→15） | 数据窗口/渲染预算两层切片，对冲全量在内存的 jam | ✅ 2026-08-26 落地（终稿 ⑩）：窗口层删除，`useMessageWindow` 整文件删除；`visibleMessages` = messages 尾部 `mountedCount`，mountedCount 仅作首帧渲染预算（6→全量每帧 +40，防切会话首帧 jam），取回后到顶 | 简化 |
| `save_session_changes` 每轮全量 `to_string_pretty` 落盘（`session.rs:710`） | 每轮 O(总轮数) 增长（虽 async 不堵主线程） | ✅ P2-4 已改：文件格式改 JSONL（每行一轮 compact），新增 `append_session_change` O(1) append 单轮，前端 `diskTailIndex` 锚点判断纯追加走 append、revert 场景全量覆盖；`load_session_changes` 兼容旧 pretty 数组（首字符 `[` 判定）。compact 也省了 to_string_pretty 的序列化 CPU | 顺手优化 |
| `last_jsonl_message` 逐行读完整文件取末行（`session.rs:878`） | 会话列表逐会话整读 jsonl | P1 改后端字节游标时顺手改 seek 到文件尾读末段找最后换行 | 顺手优化（P1 已含） |

**不淘汰的（正交，继续保留）**：`DeltaCoalescer` / `stdoutFrames` 背压熔断（流式事件洪峰）、`plainCode` 流式不 hljs + `renderCache`（流式 O(n²) 是另一条独立卡点，与本方案正交，另案）、`scrollToBottom` rAF 节流、watchdog 黑匣子、`bgTasks` cap、切会话的 ramp 分帧（首帧防 jam 仍需要）。

### 10.2 以前做不到、现在做到的

1. **任意长会话内存有界浏览（质变）**：以前会话越长越卡（全量进内存，30 轮 GB 级）；现在打开只 hydrate 尾部一页、store 估算字节有界（`maybeEvict` 64MB 阈值降级大 block）、DOM 条数 = 用户实际翻页量——内存不跟会话总长成正比，可浏览远超内存容量的历史。从「长会话必然卡」到「长会话不卡」。
2. **关 tab 真正释放内存**：以前所有打开过的会话全量常驻到 app 重启；现在关 tab 即释放，可放心多会话/频繁切换。
3. **工具事件延迟恒定 O(1)**：以前 `flatMap.find` 随会话变长线性退化（越往后每个工具事件越慢）；现在 Map 查恒定，不随会话变长。
4. **收回「刻意不做虚拟列表」的妥协**：`useMessageWindow.ts:18-21` 注释明说刻意回避虚拟列表（高度不定 + 流式增高 + 折叠卡片测量难题）；页级分页绕开像素测量，做到了以前刻意回避的事。
5. **应用内存可预测**：以前前端堆无界 + claude.exe 数百 MB，总量不可测；现在前端堆有界，总量 = `claude.exe × 会话数 + 有界前端堆`。
6. **GC 停顿 / watchdog 误报减少**：堆有界 → GC 停顿短 → watchdog（2s 判冻结）因 GC 长停顿误报的概率降低。

### 10.3 trade-off（以前能做到、现在要改走后端的）

分页后，**任何依赖「全量消息在内存」的功能都要改走后端**。当前唯一真实依赖是上滚（P1 已覆盖），不损失。但约束了未来：**若以后要做「会话内全文搜索」，不能像全量在内存时那样前端遍历，必须走后端索引**。当前没该功能，所以不损失，但这是分页的边界条件，设计新功能时须牢记。
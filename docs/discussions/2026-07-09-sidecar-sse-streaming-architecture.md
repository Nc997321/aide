# 决策记录:流式 chat-event 搬离主线程 emit 路径

**日期**:2026-07-09
**状态**:**⚠️ 根因结论已作废（2026-09-13），方案 C/B 均不需要实施。见下方更正块。**原文保留作推理历史。
**关联**:`docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md`(卡死黑匣子)、记忆条 `aide-session-init-freeze-rootcause.md`。
**当前 git**:master 已推 `53418ef`(诊断三件套:native 栈捕获 + 去 tauri/tracing 止血 + emit 轨迹环);`v1` 分支已从 master 建出、干净,用于实施 C。过渡 build(含 stackwalk+tracing 止血)在 `src-tauri/target/release/bundle/nsis/Aide_0.2.6_x64-setup.exe`。

---

## ⚠️ 2026-09-13 更正：本文的根因结论已被证伪

**第 2 节「卡死根因定位到 emit 投递路径」是推断，从未被栈帧证实**（native 栈捕获 stackwalk 是这份结论之后才加的），且被后续证据全面推翻。

**证伪实验**（代码 `src-tauri/src/diagnostics/experiment.rs`；复跑 `AIDE_EMIT_EXPERIMENT=6000 pnpm tauri dev` → `~/.aide/diagnostics/emit-experiment-*.json`）：以 ~600 事件/秒（真实流式的 ~50 倍）从后台线程 `app.emit("chat-event")`，同时每 100ms 测一次主线程 no-op 探针延迟——

| 场景 | 投递次数 | 探针 p50 | max | 投出未兑现 | Windows 判未响应 |
|---|---|---|---|---|---|
| idle（基线） | 0 | 0.15ms | 0.85ms | 0 | 0/60 |
| eval（直投递路径，不依赖监听器） | 3887 | 0.20ms | 1.93ms | 0 | 0/60 |
| **emit（本文指控的那条）** | 3325 | 0.51ms | **3.80ms** | 0 | 0/60 |
| block（渲染进程钉死 6 秒，零事件） | 0 | 0.19ms | 7.50ms | 0 | 0/60 |
| block_emit（钉死 + 事件流） | 3698 | 0.70ms | **21.31ms** | 0 | 0/60 |

主线程最坏响应 21 毫秒。本文所述「主线程 park、pending 单调爬、22 分钟不恢复」复现不出来——差三个数量级。

**机制层**（读 tauri 2.11.2 / wry 0.55.1 源码，本机 `~/.cargo/registry/`）：`app.emit` → worker 线程 `send_user_message`（fire-and-forget）→ 主线程 `webview.evaluate_script` → wry `ICoreWebView2::ExecuteScript`（**异步 API + 完成回调**，`webview2/mod.rs:1330`）。唯一让 emit 变成阻塞 RPC 的是 tauri 的 `tracing` feature（`getter!` = `rx.recv()`），而且它阻塞的是 **worker 而非主线程**——§8 把它当"止血"处理是对的，但它从来不是主线程卡死的原因。

**2026-08/09 的 20 份冻结报告**（`~/.aide/diagnostics/`）签名与本文假设互斥：`pending` 全 0（探针每 500ms 一枚，31 秒那份 45 帧里一枚没漏）、探针延迟 0.08–0.60ms、`isHungAppWindow` 20 份全部 false。其中 16/20 是**渲染进程**烧 CPU（`msedgewebview2.exe` 106–240% + 前端 `longTaskCount` 22–113）。

**真根因两类**：
1. **渲染进程饱和**——已找到并修复 4 个独立 O(n²)（hljs 流式高亮、消息列表无窗口化、渲染进程堆 1.08GB GC 螺旋、thinking delta 全文重排版）。
2. **同步 fs 命令占主线程**——2026-09-05 报告实锤 `remove_recent_session` 的 `cmd_enter`→`cmd_exit` 跨 **7.87 秒**（`pending` 爬升 + `isHungAppWindow` 真 + 无人烧 CPU，与 §2 描述的主线程签名完全一致）。

**注意：本文最初的那个判断才是对的。** 调查早期曾定「一批同步 `fs::IO` 命令漏过了 async 清扫，在 `session_init` 后连发」（即 `create_session` / `record_recent_session` / `recent.rs` 整组），它在第二份报告（流式中、全程无 create_session）之后被当作错误结论丢弃了——**丢弃得不对**：那批命令今天仍在制造主线程冻结，只是肇事者换成了同一簇里的另一条。

**处置**：方案 C 从未实施，也不需要实施——它要解决的问题不存在。2026-09-13 已把 `recent.rs` 5 条 + `session/mod.rs` 4 条同步 fs 命令改 `async` + `spawn_blocking`，并给 4 条盲区命令补了 trace 埋点。

**下文全部内容保留作推理历史，读时以本节为准。**

---

## 1. 这份文档要回答什么

记录 2026-07-09 一轮对话的结论:**为什么把流式 chat-event 从「Tauri emit(主线程 ExecuteScript)」搬走**,以及最终选定**方案 C(内存缓冲 + 同步轮询)**、把 **方案 B(sidecar SSE)**降为兜底。**不含具体实施步骤**(那是 plan 的事),只记录**来龙去脉、权衡、决策框架**。

## 2. 起因:卡死根因定位到「emit 投递路径」

两份 freeze 报告(`freeze-1783519417325` session_init 触发、`freeze-1783519176537` 流式中触发)主线程签名**完全一致**:`pending` 单调爬、`stuck_command=None`、`isHungWindow` 翻 true、低 CPU(等待非计算)、强杀才结束。但**触发事件不同**(前者 worker emit `session_init`,后者 worker emit `text_delta`/`tool_use_start`,payload 都很小、1 事件/秒也卡)。

唯一共同点:**worker 发 emit → 主线程在投递这条 emit 时 park**。投递路径 = tauri-runtime-wry `WebviewMessage::EvaluateScript` → wry `ICoreWebView2::ExecuteScript`,**整段是框架代码,aide 一行都不在上面**,源码看不到卡在哪一帧。

> 历史插曲:过程中一度把 `create_session`(同步 fs::IO 命令)误判为根因。第二份报告(mid-stream,全程无 create_session)证伪——主线程在投递 session_init 的 ExecuteScript 时就卡了,JS 没收到 session_init,create_session 根本没执行。create_session 是碰巧挨着撞墙点的「嫌疑人」,已作废(同步 IO 整改仍值得做,但不是卡死修复,见 §6)。

**结论**:卡死不是某个 aide 命令,是**架构级脆弱**——所有 sidecar→前端的 chat-event 都挤在主线程这一个 `ExecuteScript` 调用上,主线程就是单点故障。偶发的 WebView2 内部/COM/reentrancy 卡一下,整个 UI 就死。一天卡 10 次的产品不可接受,需要**根除**而非对症。

## 3. 关键调查:所有原生 Tauri「Rust→JS」路径都走 ExecuteScript

为回答「有没有更简单、不开端口、又避开主线程的方案」,查了 tauri 2.11.2 源码里所有 Rust→JS 投递路径:

| 路径 | 投递实现 | 主线程? |
|---|---|---|
| `app.emit` / 事件监听 | `event::emit_js_script` → `Webview::eval` | 是(ExecuteScript) |
| `tauri::ipc::Channel`(官方流式 API) | `Channel.send` → `on_message` → `webview.eval`(channel.rs:158/254) | 是(ExecuteScript) |
| invoke 回执 | `responder_eval` → `webview.eval`(protocol.rs:334) | 是(ExecuteScript) |

**全部最终调 `webview.eval`(= `ICoreWebView2::ExecuteScript`,主线程 COM 调用)。** Tauri 架构上把所有 Rust→JS 都漏斗到主线程这一个 eval。

> 推论:这解释了为什么 invoke 一直可靠(心跳每 500ms 到)、emit 偶发卡死——都走 ExecuteScript,但 emit 在聊天流式期间**调用频率远高于 invoke**,所以触发观察里 emit 占绝大多数;并非 invoke 免疫,只是它稀疏。

**所以:Tauri 里没有「原生、简单、不开端口、又避开主线程」的免费午餐。** 「Channel 是不是更优」这条希望落空——它只是 emit 的类型化包装,底层同一个 eval,同一个 hang 点。

自定义协议长轮询也查过:`UriSchemeResponder.respond` 是**一次性返回一个完整 blob**(`http::Response<T: Into<Cow<[u8]>>`),**不支持流式**;退化成长轮询后,每次请求仍经主线程的 `WebResourceRequested`,**没真正解耦**,主线程一 park 长轮询也停。不算干净中间路线。

## 4. 真正能「把流式搬出主线程」的,只有本地 socket

浏览器(WebView2)能直连的本地传输只有 TCP(http/WS);named pipe / unix socket 浏览器够不到。所以要避开 ExecuteScript,只能开一个 loopback socket 让前端用 `fetch`/`EventSource` 拉。

## 5. 方案 B:sidecar 自起 loopback SSE,前端 EventSource 直连

**核心思路**:sidecar(Node 进程)本就是事件源,让它**顺带起一个 loopback SSE 服务**;前端 `new EventSource("http://127.0.0.1:PORT/events")` 直连 sidecar;**Rust 只管进程生命周期 + stdin 发命令,彻底退出数据路径**。

```
现在:  sidecar stdout → Rust worker → app.emit → [主线程 ExecuteScript] → 前端   ← 卡死点
方案B:  sidecar ──SSE(loopback)──→ 前端 EventSource
        Rust 只: spawn/kill sidecar + stdin 发命令(send_message 等)
        主线程完全不在流式数据路径上
```

**为什么是这个设计,而不是「Rust 起 HTTP 服务」**:sidecar 已经在产事件,让它多起一个 SSE 端点(Node 几行 http/Express)比在 Rust 里加一套 hyper + 事件广播通道更简单;且 Rust 主线程彻底脱离数据路径(连搬运都不做),解耦最干净。命令仍走现有 stdin→sidecar 路径(低频、请求/响应式,不触发问题);事件走 SSE(高频流式,搬离主线程)。两种传输各司其职。

## 6. 优缺点(摘开 bug 看架构,再叠加 bug 看)

### 优点

- **根治**:主线程不在流式路径上,触发条件物理消失,不赌帧、不赌版本、不赌 WebView2 内部行为。
- **吞吐/稳健性提升**:不止治 bug——主线程不再是流式瓶颈,重突发也不再因主线程串行产生 jank;后端「UI 抖一下也能跑完」是结构自带,不靠 feature flag。
- **比「Rust HTTP 服务」简单**:复用 sidecar(已是事件源),Rust 侧零新增数据搬运代码。
- **跨平台**:Node + HTTP,Win/mac/Linux 一致。
- **标准桌面 IPC 模式**:Electron / VSCode 等都用 loopback 做 IPC,不算野路子。

### 缺点 / 风险点 + 高层缓解(非实施细节)

- **开本地端口**:引入监听 socket——这是桌面 app 尽量该避免的。具体代价与缓解:
  - *攻击面*:别的本地进程/用户可连 SSE 读聊天内容 → **绑 127.0.0.1 only + URL 带 per-session 随机 token**,无 token 连不上/读不到。
  - *Windows 防火墙弹窗*:loopback 绑定**不触发** Windows Defender 弹窗(防火墙只管非 loopback 接口)。
  - *杀软启发式*:桌面 app 开监听 socket 可能被标记——但 loopback 比绑 0.0.0.0 温和得多(本项目杀软已是痛点,这点要留意但非阻断)。
- **混合内容 / CSP**:若 webview 是 https scheme,`http://127.0.0.1` 是 mixed-content 被拦 → CSP 放行 `connect-src http://127.0.0.1:*`,或必要时上 wss(自签证书,更麻烦)。需确认 aide webview 的 scheme。
- **端口管理**:分配/冲突/跨重启残留监听;端口要能传给前端(一次性的低频 invoke 即可,不触发问题)。
- **重连丢消息**:EventSource 自动重连,但要 Last-Event-ID + 服务端环形缓冲回放,否则有缺口。
- **双传输通道**:invoke 管命令、SSE 管事件,架构割裂,可维护性略降;更多代码 = 更多测试面。

### 摘开 bug,谁更干净?

把 bug 拿掉,**现在的 Tauri emit 对桌面 app 更干净**:不开端口、无攻击面、无 CSP/防火墙/杀软摩擦、跨平台一致、有序、生命周期跟 App。方案 B 几乎所有代价都是为「绕开主线程」这一个目的买单。**B 的正当性主要就是 bug**——这也是为什么不该盲目先上 B,而要先看有没有更便宜的解(见 §7)。

## 7. 决策框架:别预判,按「从最便宜到最重」走

最简单的解可能根本不用开端口——藏在那一帧里:

1. **先用含 stackwalk 探头的 build**(已构建),等下次卡死抓 `mainThread.park` 那一帧。
2. 帧出来后分叉:
   - 帧落在 **wry/tao 已知 bug + 上游某版本已修** → **升一行版本,最简单解,收工**(方案 A,B 根本不用做);
   - 帧落在 **WebView2 运行时内部 / 结构性** → 这时再上 **方案 B**(sidecar SSE),那时心服口服「非开端口不可」。
3. tracing 止血已交付:无论走 A 还是 B,卡死都不再丢回复(后端能跑完、重启 resume 即在),边修边不遭罪。

**赌注**:那一帧有相当概率给出「便宜的 A」(wry 这类 0.x 库 changelog 里 emit/eval 相关 bug 不少);但万一不是,B 是兜底的根治。先抓帧 = 把「最简单解」的机会拿到手,再决定要不要背 B 的复杂度。

## 8. 已采取的中间措施(与本决策并行)

- **去掉 `tauri` 的 `tracing` feature**(已做,已构建):emit 退回 fire-and-forget,worker 不再因主线程 park 而阻塞 `rx.recv` → sidecar 不回压 → 后端能跑完 → 重启可看到完整回复。**不修 UI 卡死本身**,把「彻底 wedge、丢回复」降级为「UI 卡但后端完成、重启恢复」。
- **native 栈捕获**(已做,已构建):watchdog 冻结期跨线程抓主线程顶帧,报告 `mainThread.park`。从「诊断工具」转为「验收工具」——若上 B,改完后用它确认 park 不再出现。
- **同步 IO 卫生整改**(待定,非卡死修复):`create_session`/`rename_session`/`delete_session`/`find_sessions_since` + `recent.rs` 整组 + filesystem/workspace/run_configs 一批同步 fs::IO 命令,违反 CLAUDE.md「同步 command 禁止重 IO」,该转 async + spawn_blocking。是 CLAUDE.md 卫生整改 + 去混淆,不指望止卡。

## 9. 本文档边界

- **记录**:讨论结论、三方案来龙去脉、优缺点、决策框架、选定 C。
- **不记录**:C/B 的具体实施步骤——那是 plan 的事。
- **当前状态**:已选定 C,在 `v1` 分支实施;B 为兜底。

---

## 10. 方案 C(选定):内存缓冲 + 同步轮询

讨论后期发现一个**不开端口、纯原生、且能根治观测到的两类卡死**的方案,定为首选。

### 10.1 关键洞察:inline 同步命令路径是可靠的

§3 说"所有原生 Rust→JS 都走 ExecuteScript",但**主线程 inline 的 ExecuteScript(同步命令的响应)从卡死统计上从不触发**——证据:`diag_heartbeat` 是同步命令、每 500ms 一次、整场几千次,两份报告里它**一直稳到撞墙前一瞬**。而卡的全是 worker 跨线程 `app.emit`。所以真正触发的是**跨线程编组(proxy.send_event → 主线程被唤醒处理)**,不是 ExecuteScript 本身。

→ 启示:**让 chat-event 不再跨线程 emit,改由前端用同步命令 inline 拉内存缓冲**(走心跳那条稳的路),就把触发路径整体搬走,且不开端口。

### 10.2 设计

```
现在:  sidecar stdout → worker → app.emit → [主线程跨线程 ExecuteScript] → 前端   ← 卡死点
方案C: sidecar stdout → worker → push 进 Arc<Mutex<VecDeque<ChatEvent>>>(纯内存,无 emit、无编组)
       前端每 200~500ms invoke("poll_chat_events")[同步命令] → 主线程 inline 排空缓冲 → 返回 → 前端喂给同一个 handleChatEvent
       SDK 照常把完整回复写进 session 文件(resume 靠它,不变)
```

要点:
- worker 不再调 `app.emit`(sidecar.rs:163),改 `buffer.push(event)`(加锁纳秒级,无 IO、无序列化、不过主线程)。
- 新增同步命令 `poll_chat_events`:主线程 inline 排空缓冲返回 `Vec<ChatEvent>`(走心跳同款可靠 inline 路径)。**限批**(每次最多 ~50 条,没取完前端立刻再 poll)避免大 batch 在主线程序列化卡顿。
- 缓冲**有上限**(如 1000)+ 溢出**丢最旧 + 落一条 warn 事件**让前端知道有缺口(异常时才触发,正常 500ms 间隔只存 ~12 条)。
- 把 **heartbeat 并进 poll**(poll 时顺带上报 lagMax/longtask),省一次 invoke,空闲频率不增。
- 前端:`listen("chat-event")` 换成定时轮询,结果喂给**同一个 `handleChatEvent`**(业务逻辑、多会话 session_id 路由全不动)。
- resume 不受影响(历史会话走 load_messages,不经实时缓冲)。

### 10.3 为什么 C 比 B 适合本项目

| | C(内存缓冲+同步轮询) | B(sidecar SSE) |
|---|---|---|
| 开端口 | **否** | 是(攻击面/杀软/防火墙/CSP) |
| 安装/打包 | **零新增** | 有端口相关负担 |
| 修 session_init 那类(非 delta init 事件) | **修**(init 也进缓冲,不走 emit) | 修(走 SSE) |
| 修 mid-stream 文本类 | **修** | 修 |
| 主线程负载 | **更少**(唤醒 25/秒→2-5/秒,去编组) | 主线程不在路径(更彻底) |
| 实时性 | 无(200~500ms 轮询延迟) | 有(流式) |
| 复杂度 | 中(缓冲+poll+限批+溢出兜底) | 中高(SSE+token+CSP+重连回放) |

C 的关键优势:**安装零负担(不开端口)**,且**同样修两类卡死**(session_init + mid-stream)。B 唯一比 C 强的是"保留实时 + 主线程更彻底退出",但代价是端口那堆事。本项目选 C。

### 10.4 C 的边界(诚实)

- **修的是 chat-event 触发的那类卡死**(=现在 10/天全部来源),根除。
- **主线程仍是单点**:非 chat 的罕见触发(单实例回调、open-file-preview 等 emit)+ 同步 IO 命令(create_session 写文件被杀软拖等)**仍可能卡**。这不是"现在的卡死",是潜伏的、罕见的另一类,靠**§8 的同步 IO 整改(task#3)配 C 一起清**。
- **高置信但推断式**:C 根治建立在"触发=跨线程编组"推断上(强证据:心跳 inline 从不卡)。即便推断错(触发其实是 ExecuteScript 本身),C 的轮询响应走的是 inline ExecuteScript(心跳同款,经验上稳)→ 仍不卡。所以两种解读下 C 都修。上线后观察 + stackwalk 报告确认。
- **UX 代价**:200~500ms 显示延迟(含 session_init 延后建会话、permission_request 延后弹窗半秒)。可调轮询间隔平衡。

### 10.5 下一步

在 `v1` 分支写 C 的实施 plan 并执行:缓冲 + 同步 poll + 限批 + 溢出兜底 + heartbeat 并进 poll + 去掉 worker emit + 配 task#3 同步 IO async 化。改完 build 试,观察卡死是否归零;stackwalk 报告若 `mainThread.park` 不再出现 chat-emit 相关帧即确认根除。
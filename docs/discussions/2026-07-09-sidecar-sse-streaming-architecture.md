# 决策记录:流式 chat-event 改走 sidecar SSE(方案 B)

**日期**:2026-07-09
**状态**:决策记录(讨论结论 + 备选根治方案);**尚未实施**,待「主线程 park 帧抓取」结果决定是否落地。
**关联**:`docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md`(卡死黑匣子)、记忆条 `aide-session-init-freeze-rootcause.md`。

---

## 1. 这份文档要回答什么

记录 2026-07-09 一轮对话的结论:**为什么要考虑把流式 chat-event 从「Tauri emit(主线程 ExecuteScript)」改走「sidecar 自起 loopback SSE、前端 EventSource 直连」(下称方案 B)**,以及 B 的优缺点。**不含具体实施步骤**(那是另一份 plan 的事),只记录**来龙去脉、权衡、决策框架**。

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

- **记录**:讨论结论、B 的来龙去脉、优缺点、决策框架。
- **不记录**:B 的具体实施(port 怎么选、SSE 端点怎么写、CSP 怎么配、token 怎么传、回放缓冲多大、sidecar 改哪些文件)——那是确认走 B 后另起的实施 plan 的事。
- **当前状态**:未实施;等 stackwalk 那一帧的结果决定走 A(便宜)还是 B(根治)。
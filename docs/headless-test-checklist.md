# Headless 引擎测试清单

> 2026-09-11 建。**同日第一轮正式验收 + 修复轮 + 补测轮（B9/B10）已执行**（结果回填各表
> 「结果」列，发现清单见 §7-F1~F11；F3/F4 两个 P0 已核实修复，C4/C6/C7 闭环，B9/B10 补测
> 闭环；脚本沉淀 `agent-sidecar/smoke-headless-*.{ts}`，复跑即回归）。建稿背景：headless 宿主
> （`agent-sidecar/src/headless-server.ts`，`node dist/runtime.js headless`）
> 此前只有单测（725 用例内覆盖）+ 一条 MCP 头注入 smoke。本清单是正式测试
> 的执行底稿，结合 agri-ai-agent 项目（`C:\document\project\zhongke\agri-ai-agent`，MCP 方案
> 2026-09-10 定稿：Aide 引擎当编排大脑、业务做 Spring AI MCP server、token 走 HTTP header 透传）
> 把「网关形态」作为验收主轴。
>
> **对接文档已收口**：清单里所有「对接文档写明」项（B1 re-key / C4 三句 / A11 / A20 / D5 /
> F1/F2/F5~F10 文档级处置）统一落在对接文档（网关实现方唯一必读；本清单继续当验收底稿用）。
>
> 勾选约定：`[ ]` 待测 / `[x]` 通过 / `[!]` 失败（记缺陷号）。优先级 P0=对接前必过、P1=正式验收、P2=可延后。
> 自动化标记：✅已有自动化（列明位置）/ 🔧可脚本化（建议沉淀进 smoke 家族）/ 👤手动。

## 0. 已有自动化资产（不要重测，改动时复跑即可）

| 资产 | 覆盖 | 位置 |
|---|---|---|
| headless 单测 38 例 | schema 10 命令、SSE 会话隔离、鉴权 401、安全基线拒启、body 上限、500 上下文、hello 帧、protocol 响应 | `agent-sidecar/src/headless-server.test.ts` |
| 机制①单测 | mcp_headers 注入/通配/刷新/N5、metadata hook 活值读取 | `engine/sessionMetadata*.test.ts`、`engine/sessionMetadataWiring.test.ts` |
| 端到端 smoke | dist 产物 headless 起服 → POST /invoke 带 mcp_headers → mock MCP server 实收注入头 | `agent-sidecar/smoke-headless-mcp-headers.ts`（`npx tsx` 直接复跑，2026-09-11 复跑 PASS） |
| **A 组宿主级验收**（本轮新增沉淀） | A 组协议面 dist 黑盒全臂 | `agent-sidecar/smoke-headless-host.ts`（2026-09-11 实测 22/22） |
| **D 组网关彩排 + C/B 死端点臂**（本轮新增沉淀） | 鉴权/多租户/mock MCP/re-key/停止/并发/崩溃恢复/背压 | `agent-sidecar/smoke-headless-gateway.ts`（2026-09-11 第一轮 19/20，唯一 FAIL=C4 死端点臂→发现 F3；**修复轮 20/20**——C4「error 终态后续发→重启→新头命中」端到端闭环） |
| **真模型批次**（本轮新增沉淀） | B2/B4/B5/B7/B8/B11/B14 + C6/C7 + D1/D2/D3 | `agent-sidecar/smoke-headless-realmodel.ts` + `smoke-headless-provider-env.ts`（复用当前 aide provider：settings.json activeProvider + Windows 凭据管理器；真 token 只进内存与 send.env，C8 扫描含真 token 哨兵）。修复前基线 10/12；a3284fc 统一基线 11/13（两 FAIL=C6/C7 取证缺口→发现 F4）；**修复轮 C6/C7 双闭环**（C7 探针改自检脚本+bypassPermissions，见 F9） |
| **B 组补测批次**（B9/B10 遗留项收口） | B10 策略活推裁决面（deny→allow→旧 rev 忽略→零重启）+ B9 stop_bg_task + C8-lite | `agent-sidecar/smoke-headless-policy.ts`（真模型；B10 用 manual 模式做对照基线——零弹窗即策略 hook 在裁决；2026-09-11 实测 **6/6**） |
| 死端点 error 时序探针 | B1 error 帧到达时刻专项观测 | `agent-sidecar/smoke-headless-deaderror-probe.ts`（诊断工具，不进台账） |
| session_init 重发判别探针 | 同 sid 续发 init 重发的根因判别（PID 跨轮不变 + id 唯一 + 零 error 帧 = 存活 query 每轮重发 init，良性 CLI 行为） | `agent-sidecar/probe-reinit.ts`（诊断工具，不进台账；B10-4 判据与对接文档幂等 re-key 条目的证据源） |
| 会话进程身份/生命周期探针 | runtime 子进程归属判别（PS CIM 父进程面）：manual+策略臂会话 claude.exe(36992, 父=runtime) 跨轮存活实锤；同刻 tasklist 全表漏检——F11 证据源 | `agent-sidecar/probe-session-proc.ts`（诊断工具，不进台账） |
| Bash 结局全轨迹探针 | C7 残层诊断：tool_use 输入/分类器拒信/终态帧/进程悬挂盘点 | `agent-sidecar/smoke-headless-bashprobe.ts`（诊断工具，不进台账；F9 证据源，可复跑） |
| 共享库 | 进程编排/SSE 客户端/PID 与 RSS 观测（**PS CIM 观测层**，tasklist 仅兜底——F11）/mock MCP/哨兵扫描/台账 | `agent-sidecar/smoke-headless-lib.ts` |

## 1. 环境准备（每次验收前置）

```bash
cd agent-sidecar && npm run build          # 必须测 dist 产物，不测 tsx 源码
# 最小起服（回环 + 无鉴权）：
node dist/runtime.js headless               # AIDE_HEADLESS_PORT 默认 18090
# 网关形态起服（鉴权 + 隔离配置根）：
AIDE_HEADLESS_TOKEN=<secret> CLAUDE_CONFIG_DIR=<临时配置根> node dist/runtime.js headless
```

- 临时配置根的 `settings.json` 放被测 MCP server 配置（`type:"http"` + url）。
- 模型端点：集成级测试用真 provider（send.env 带 ANTHROPIC_BASE_URL/API_KEY）；
  只测协议面时用死端点 `http://127.0.0.1:9`（MCP 连接发生在会话启动阶段，不依赖 LLM 可达——smoke 已验证的方式）。
- 每轮验收后检查无孤儿进程（runtime 的 SIGTERM 收尾应带走 claude 子进程；smoke 脚本尾部有清理先例）。

## 2. A 组：宿主级（协议面，无真模型即可测）

| # | 场景 | 操作 | 预期 | 级别 | 自动化 | 结果 |
|---|---|---|---|---|---|---|
| A1 | 启动与版本握手 | 起服读 stdout | `{"type":"headless-listening","port":…,"protocol":1}` | P0 | 🔧→✅ | [x] dist 实测（host-smoke） |
| A2 | SSE hello 首帧 | GET /events?sessionId=s1 | 首帧 `{"type":"hello","protocol":1,"sessionId":"s1"}` | P0 | ✅ | [x] dist 实测帧形精确匹配 |
| A3 | invoke 成功响应形状 | POST /invoke 合法 send | 200 `{"ok":true,"protocol":1}`；真实结果只走 SSE，不在响应里 | P0 | ✅ | [x] dist 实测，键集恰为 {ok,protocol} |
| A4 | 无 token + 非回环 = 拒启 | `host:"0.0.0.0"` 无 token | 启动即抛错拒绝监听 | P0 | ✅ | [x] 单测为准；**发现 F6：dist 入口无 host env（只读 PORT/TOKEN），e2e 面不可达** |
| A5 | Bearer 鉴权三态 | 无 token/错 token/对 token | 401/401/200 | P0 | ✅ | [x] gateway 实测 invoke 401/401/200 + events 401/200 |
| A6 | 10 命令白名单面 | 逐命令最小合法体 | 全部 200 入队；`codegraph_result` 与未知命令 400 | P0 | ✅ | [x] dist 实测 10/10 全 200，codegraph/未知均 400 |
| A7 | schema 深校验拒绝臂 | send 带非法 images/automation/permission_policy/mcp_headers | 400，错误含 path+code、**不回显值** | P0 | ✅ | [x] dist 实测四臂全 400、path:code 形状、哨兵零回显 |
| A8 | 前向兼容透传 | send 带未知顶层字段/未知 display 块 | 200，字段原样到命令层（loose 不剥） | P1 | ✅ | [x] dist 实测未知 display 块经 user_message 原样回灌；顶层未知保留以单测为准 |
| A9 | SSE 多会话隔离 | s1/s2 各订阅，交叉 dispatch | 各收各的，互不可见 | P0 | ✅ | [x] dist 实测双 sid 零交叉 |
| A10 | 同连接跨会话重订阅 | 一条连接先订 s1 再订 s2 | s1 事件不再投递（旧键摘净） | P1 | ✅ | [x] 单测为准（HTTP/1.1 单连接并发双 SSE 客户端不可达，如实记录） |
| A11 | SSE 断线重连语义 | 订阅后断开、期间发事件、再订阅 | **无回放**（订阅制，断开期间事件丢失）——网关侧必须容忍或自行补偿；重连后 hello 帧重发 | P1 | 👤→✅ | [x] dist 实测：重连仅 hello、黑屏期事件零回放（A18 同证） |
| A12 | 心跳保活 | 订阅后静置 >30s | 收到 `: ping` 注释行；中间代理不掐链 | P2 | 👤→✅ | [x] dist 实测 35s 窗 1 个 ping（30s 周期） |
| A13 | body 上限 | POST >1MB | 400，进程无恙 | P1 | ✅ | [!] 400 与进程无恙均实锤；**但服务端回 400 后 RST 连接（请求体未读尽），fetch 客户端拿不到状态码——见发现 F5** |
| A14 | 非 JSON body | POST `not-json{{{` | 400 | P1 | ✅ | [x] dist 实测 400 |
| A15 | 命令路由同步异常 | manager.handleCommand 抛错 | 500 带上下文，进程不崩 | P1 | ✅ | [x] 单测为准（真 manager 对缺席会话静默丢弃、无同步抛射面） |
| A16 | 优雅关停 | SIGTERM/SIGINT | SSE 连接被主动断开（客户端 reader 收到 done）、worker 停止、进程退出码 0；**无孤儿 claude.exe** | P0 | 🔧 | [!] **Windows 语义限制（发现 F1）**：kill=强制终止（70ms 退出、exit code≠0、SSE 收 error 非 done，close() 收尾未执行）；死端点场景实测孤儿=0，活轮场景实测残留 1（realmodel 收口回收）。优雅关停仅 POSIX 成立 |
| A17 | 二次 close 幂等 | 重复触发关停 | 不抛错不挂死 | P2 | ✅ | [x] 单测为准 + e2e 对已死进程二次 kill()=false 无恙 |
| A18 | 未订阅会话的事件 | dispatch 无人订阅的 sid | 静默丢弃不积压（订阅制语义） | P1 | ✅ | [x] dist 实测（与 A11 同证：黑屏期事件零回放） |
| A19 | `_runtime` 健康帧 | 起服静置 30s | health 事件无订阅者 → 静默；**确认不会**投给任意业务订阅者 | P2 | 👤→✅ | [x] dist 实测：35s 窗业务订阅 0 数据帧，health 恰 1 帧且只到显式 `_runtime` 订阅 |
| A20 | SSE 写背压（已知风险） | 订阅端故意不读（暂停 socket），服务端持续产事件 | 观察内存增长与行为——`dispatch` 只在写抛错时摘连接，`res.write` 返回 false（内核缓冲满）无降级路径；**桌面 stdio 路径有熔断，SSE 路径没有**，此项探边界并记录实测行为 | P1 | 👤→✅ | [x] 实测记录：10×500KB 灌入暂停连接 → RSS Δ5.2MB、恢复读后 10/10 帧全到不丢、期间 invoke 照常服务。**风险坐实：纯缓冲无熔断，慢消费=内存线性累积**，网关必须勤读 |

## 3. B 组：引擎集成级（真 claude.exe，死端点或真 provider）

| # | 场景 | 操作 | 预期 | 级别 | 自动化 | 结果 |
|---|---|---|---|---|---|---|
| B1 | 会话全生命周期 | send（死端点）→ SSE 收事件 | session_init（客户端 sid 与 SDK 真 id 的 re-key 语义：后续命令用哪个 id 要实测钉死）→ …→ 端点不通时 error 帧 fatal:false，进程存活 | P0 | 🔧→✅ | [x] **re-key 钉死**：session_init 后事件只走真 id 通道（client sid 通道转静默）；续发命令**必须用真 id**——拿旧 client sid 续发=全新会话（上下文静默丢，对接文档红字）。error 帧 fatal:false 实测到达但**延迟 ≤189s**（90s 窗口必空，见发现 F2） |
| B2 | 真模型问答轮 | send.env 带真 provider，prompt "回复 ok" | text_delta 流式 → message_stop（usage/effort 字段）→ 状态可再发第二轮（同 sid 上下文保持） | P0 | 👤→✅ | [x] realmodel 实测（qwen3.8-max）：两轮问答、usage/effort=high 齐、二轮复述首轮内容=上下文保持 |
| B3 | user_message 回灌 | send 带 display 块 | SSE 收到 user_message 事件、display 原样回灌（三端单一渲染来源契约在 headless 同样成立） | P1 | 🔧→✅ | [x] dist 实测：mention 块+未知块原样回灌，text 取原文 |
| B4 | 权限确认流（agri 写确认的引擎侧原型） | 配 permission_mode=manual + prompt 诱导写文件 | permission_request 事件到 SSE → POST permission_response(approved) → 工具执行；(approved=false) → deny 结果 | P0 | 👤→✅ | [x] realmodel 双臂实测：批准臂 permission_request→Write→文件落盘含预期内容；拒绝臂 deny 不落盘且模型自然收尾 |
| B5 | interrupt | 长任务中 POST interrupt | 当前轮终止、message_stop(interrupted) 或等价终态；后续 send 可用 | P1 | 👤→✅ | [x] realmodel 实测 stop_reason=interrupted，后续轮正常 |
| B6 | session_stop | POST session_stop | worker 停止、claude.exe 释放（进程表核实）；再 send 同 sid = 新会话（resume 语义另测） | P0 | 🔧→✅ | [x] dist 实测：PID 全退场；停止后同 sid 再 send=新 SDK 会话（带 resume_session_id 才接续，见 B11） |
| B7 | set_model / set_effort / set_permission_mode | 存活会话逐个下发 | models_available / effort_changed / permission_modes_available 回执事件；非法值拒绝且不脏账面 | P1 | 👤→✅ | [~] effort_changed(low)✓ permission_modes_available✓ 非法 effort("banana")不脏账面✓；**models_available 第三方 provider 不发（发现 F7，观察项）** |
| B8 | model_switch_confirm_decision | 缓存热+大上下文时切模型 | model_switch_confirm 事件 → POST decision(approve/deny)；不应答 10s 自动 deny | P2 | 👤→✅ | [x] a3284fc 基线 realmodel 实测全臂：大上下文轮（ctx=156773, warm=true）set_model→confirm→decision(approve)→`model_switch_result ok:true model:"qwen3.8-flash"`（**真名命名空间，落盘轴换轴修复在 wire 事件面可见**）；不应答臂→10s 后 `ok:false error:"Model switch blocked…缓存重铺成本确认"` 自动 deny ✓ |
| B9 | stop_bg_task | prompt 诱导后台任务（run_in_background）→ POST stop_bg_task | bg_task_ended(status:stopped) | P2 | 👤→✅ | [x] policy-smoke 实测（2026-09-11，两度 PASS）：bypassPermissions 会话诱导 Bash sleep 60 后台任务 → bg_task_started(id) → POST stop_bg_task → bg_task_ended(status:stopped) 在 session_stop **之前**到达（worker 关闭的 stopAllRunning 会合成同款终态，判序防作弊） |
| B10 | update_permission_policy | 会话中推策略快照（revision 递增） | 后续工具调用按新策略裁决；旧 revision 被忽略 | P1 | 🔧→✅ | [x] policy-smoke 实测（manual 模式对照基线：无规则匹配必弹窗=B4 已钉，故零弹窗即策略 hook 在裁决）：rev1 deny 首带→hook 直拒（零弹窗/零落盘/规则 id 进 tool_result）；存活会话推 rev2 allow→下一轮零弹窗落盘；重放 rev1（旧）→入队 200 但裁决面忽略、allow 仍生效；零重启三判据（init id 唯一×3 轮+零 error 帧+runtime 子 claude.exe 42492 三采样点不变，F10/F11 判据）全过 |
| B11 | resume 语义 | send 带 resume_session_id（此前会话的真 id） | 上下文接续（问它上一轮说了什么） | P1 | 👤→✅ | [x] realmodel 实测：session_stop 后凭真 id resume，答出上一轮约定词 |
| B12 | 并发多会话 | 3 个 sid 并行 send | 事件按 sid 各归各；无交叉污染；内存/进程数随会话数线性、停止后回收 | P1 | 🔧→✅ | [x] dist 实测：3/3 成流零串扰、claude.exe 1:1 净增、回收干净（10 会话面见 D6） |
| B13 | 同会话并发 send | 同 sid 快速两连发 | 第二条排队/插队语义与桌面一致（sendQueue 串行化），不崩不乱序 | P1 | 🔧→✅ | [x] dist 实测三连发排队不丢不乱序 |
| B14 | 网关误发桌面字段 | send 带 btw/automation | 行为如实记录（schema 放行、引擎按桌面语义执行——btw 自毁/automation 白名单）；**对接文档应写明网关不该发**，或决定后续从 headless schema 剥除 | P2 | 👤→✅ | [x] realmodel 实测记录：btw 轮正常执行；回合结束后再 send 观测 session_init×2——**证据强度降级见 F10**（init 每轮重发同 id 即可解释计数，自毁重建需 init id 变化判别，该轮未记录 id，留下轮复核）。automation 面未测。对接文档写明网关不该发（发现 F8） |

## 4. C 组：机制①（会话元数据 + MCP 头注入）——agri 多租户的引擎侧底座

| # | 场景 | 操作 | 预期 | 级别 | 自动化 | 结果 |
|---|---|---|---|---|---|---|
| C1 | 精确名注入 | send.mcp_headers={"agri-platform":{…}} | 仅该 server 收到头 | P0 | ✅smoke | [x] 2026-09-11 复跑 PASS（dist 产物） |
| C2 | `"*"` 通配注入 | mcp_headers={"*":{"X-User-Token":…}} | 所有 http/sse server 收到；stdio/sdk 型不受影响 | P0 | ✅单测/🔧→✅端到端 | [x] gateway 实测 GW-STAR 同达 biz1+biz2；stdio 无 HTTP 头面不适用（单测绿为准） |
| C3 | 注入头覆盖配置头 | settings.json 静态头 + send 同名头 | 会话级值生效（授权身份优先） | P1 | ✅单测 | [x] 单测为准（本轮 59 例绿） |
| C4 | token 轮换 | 第二条 send 带新头 | 下一次 query() 重连用新头（**当前存活 query 仍用旧头**——已声明边界，实测钉死行为与文档一致） | P1 | ✅单测/👤端到端 | [x] **修复轮闭环（F3 已修）**：语义钉死=「存活 query 续轮永不换头；轮换=会话重启+resume（D3）；**error 终态后下一条 send 自动以 resume 重启重连带新头**（修复轮 gateway 20/20，C4 臂端到端 TOK_ROT 命中）」。对接文档按这三句写 |
| C5 | 非法注入表 fail-closed | mcp_headers 值非 string | 400（schema 层）；绕过 schema 直灌 stdin 时整表忽略 + console.error **不含值** | P0 | ✅单测 | [x] schema 臂 dist 实测（A7）；stdin 直灌面单测为准（headless 无 stdin 面，如实记录） |
| C6 | metadata hook 可读 | send.metadata={"tenant":"acme"} + 配置根放一个自定义 hook（读不到 metadata 就退而验证内建口）| 进程内 hook 经 HookBuildContext.session.metadata() 读到活值；**用户 shell hook 读不到**（设计代价，验证无 env 泄漏） | P1 | ✅单测(进程内)/👤shell侧 | [x] **修复轮闭环（F4 已修）**：进程内臂单测绿；shell 臂端到端 PASS——PreToolUse command hook（settings.json）经编译包装真实执行，env 落盘 11150B、哨兵零命中（设计代价实证：shell 侧读不到 metadata） |
| C7 | 安全红线：cliEnv 无泄漏 | 任意 metadata/mcp_headers 会话中让模型经 Bash 跑自检脚本（原「裸跑 env」探针被 auto 分类器按凭据物化正当拦截，见 F9——改为脚本只输出判定 JSON，红线语义不变） | 子进程环境变量**不含** metadata 内容与注入头值（Bash 工具不可外带） | P0 | 🔧→✅ | [x] **红线闭环（修复轮）**：Bash 子进程实跑自检脚本 verdict={clean:true,hits:[],envKeys:141,pathLen:4090}——env 真实填充（141 键/PATH 4090B）且逐值扫描零哨兵命中；探针会话用 bypassPermissions 绕开 qwen 下 flaky 的 auto 分类器（F9），权限流本身由 B4/D2 独立钉死 |
| C8 | 安全红线：日志无泄漏 | 全程收集 runtime stdout/stderr | 无任何头值/凭据出现（N5） | P0 | 🔧→✅ | [x] 三脚本全量扫描零命中（含 realmodel 的**真 token** 哨兵 × runtime 日志）——本臂红线闭环 |
| C9 | 会话间头隔离 | s1 带头 A、s2 带头 B，同一 MCP server | server 侧按会话收到各自的头（per-query options 天然隔离，端到端钉死） | P0 | 🔧→✅ | [x] gateway 实测：mock server 按源端口分组，S1 连接全带 TOK_S1、S2 全带 TOK_S2，交叉=无 |

## 5. D 组：网关形态模拟（agri 对接彩排，无需 agri 代码）

用一个 ~200 行 node/Spring 脚本扮演 agri 网关：持有 AIDE_HEADLESS_TOKEN，为每个"租户请求"生成 sid，
send 时塞 `metadata`（租户上下文）+ `mcp_headers`（`X-User-Token`），订阅 SSE 转发给"业务前端"（控制台即可）。

> 执行载体：`smoke-headless-gateway.ts`（死端点全链彩排）+ `smoke-headless-realmodel.ts`（真模型问答/确认臂）。

| # | 场景 | 预期 | 级别 | 结果 |
|---|---|---|---|---|
| D1 | 双租户并行会话 | 租户 A/B 各一个 sid 同时问答，SSE 流互不可见；mock MCP server 日志显示各会话带各自 X-User-Token | P0 | [x] realmodel 实测：并行轮各自成流（回复只含自家标记词），hits 各带 TOK_D1A/TOK_D1B |
| D2 | 写操作确认流全链 | manual 模式诱导写 → 网关收到 permission_request → 模拟业务前端确认 → permission_response → 执行完成 → message_stop | P0 | [x] realmodel 实测（=B4 双臂），确认流全链走 HTTP 命令/SSE 事件闭环 |
| D3 | 租户 token 失效轮换 | 会话中途换 X-User-Token 重发 → 下一轮 MCP 调用带新 token（mock server 验证） | P1 | [x] realmodel 实测：语义钉为「下一 query（会话重启+resume）带新头」；存活 query 内不换头（修正 C4/D3 预期——对接文档按此写） |
| D4 | 网关重启韧性 | 杀网关脚本再起：runtime 不受影响；旧 sid 的 SSE 重订阅后继续收事件（无回放，见 A11） | P1 | [x] dist 实测：掐全部订阅→宿主无恙→重订阅续收新事件 |
| D5 | runtime 崩溃恢复 | 杀 runtime → 网关侧 SSE 断开可感知 → 重启 runtime 后新会话可用；**旧会话不恢复**（内存态，如实记录对接约束） | P1 | [x] dist 实测：断开可感（reader error）、重启新会话可用、旧键重发=全新 SDK 会话（上下文丢=内存态设计实锤，对接文档必须写明）；崩溃孤儿子进程死端点场景=0 |
| D6 | 单实例多用户容量摸底 | 10 个并行会话（死端点即可，只压宿主面）：内存/句柄线性、SSE 帧不串、无泄漏 | P2 | [x] 实测：10/10 成流、claude.exe 净增 10（1:1）、runtime 本体 RSS Δ6MB≈0.6MB/会话（亚线性，大头在各自 cli 进程 ≈280MB/个）、零串扰、session_stop 后残留 0 |

## 6. E 组：agri 真项目联调（MCP 方案 §8 步骤 3-4，需业务侧先完成 starter 接入）

前置：agri 加 `spring-ai-starter-mcp-server-webmvc`（**注意 Boot 基线**：Spring AI 2.0.1 可能要求 Boot 3.5.x，现 3.3.5——先对 compatibility 表，不通则退 1.1.8 线）；
`/mcp` 端点挂 Spring Security；扫描注册少量真实接口（1 读 + 1 写）。

| # | 场景 | 预期 | 级别 | 结果 |
|---|---|---|---|---|
| E1 | tools/list 连通 | headless 会话启动即连上 agri MCP server（STATELESS Streamable HTTP），模型可见工具清单 | P0 | [ ] |
| E2 | 读直达 | "查询最近的设备台账" → 模型调 READ 工具 → 数据回流成自然语言 | P0 | [ ] |
| E3 | token 权限继承 | mcp_headers 的 X-User-Token 经 TransportContextExtractor 进工具上下文 → 业务接口以该用户权限执行；换无权限 token → 业务侧 403 如实回流 | P0 | [ ] |
| E4 | 写操作确认 | WRITE 工具触发 permission_request → 网关确认 → 执行；拒绝 → 模型收到 deny 并自然语言收尾（**token 绝不进工具参数**——模型上下文里不得出现，抽查 SSE 流验证） | P0 | [ ] |
| E5 | 审计闭环 | agri 审计落库：谁（token）、何工具、参数、结果、是否经确认——与 SSE 流事件逐条对得上 | P1 | [ ] |
| E6 | 工具热更 | agri 发布/下架工具（addTool/removeTool + change notification）→ 存活会话与新会话的可见性变化如实记录 | P2 | [ ] |
| E7 | 结果裁剪 | 列表类工具返回大结果 → 截断生效，单轮上下文不爆 | P2 | [ ] |

## 7. 执行记录与发现（2026-09-11 第一轮 + 部分第二轮）

**已执行**：第一轮（P0）除 C7 实测臂（F4 阻塞）外全部完成；第二轮（P1）死端点/真模型可达项完成；
**修复轮：F3/F4 修复后三脚本复跑，C4/C6/C7 全部闭环**；
🔧 项已全部脚本化沉淀进 `smoke-headless-{lib,host,gateway,realmodel}.ts` 家族（`npx tsx` 直接复跑，
台账 `ledger n/n passed` + exit code 可进 CI）。

**统一基线重跑（同日，HEAD=1fc1d9a，sidecar 代码含 a3284fc 模型切换修复）**：
host 22/22 ✓、gateway 19/20（**F3 原样复现=与修复无关的稳定疑点**）、realmodel **11/13**
（B8 全臂新过；**F7 修复后仍成立**=独立发现；C6/C7 两 FAIL 行为不稳：上一轮 tool_use_start Bash×2
无 tool_result，本轮连 Bash 调用都没有——F4 待核实优先级上调）。

**修复轮（同日，基线 0204d69 + F3/F4 修复）**：F3/F4 根因均坐实并修复（详见发现清单状态列），
最终台账（最终版脚本+最终 dist）：**host 22/22 ✓、gateway 20/20 ✓（C4 端到端闭环）、
realmodel 13/13 ✓（C6/C7 双闭环：hook env 落盘 11150B 零哨兵；Bash 子进程自检
verdict={clean:true,hits:[],envKeys:141,pathLen:4090}）**。
单测 725→787 全绿；新模块 `engine/commandHooks.ts` 131/131 stmts 全臂覆盖、
`turnMessages.ts` 25/25 全臂覆盖；ts-reviewer 窄审通过（无必修项）。
附带修复：headless 入口漏挂 `ensureWindowsBashEnv`（Windows Bash UTF-8 是引擎级行为，
上移 index.ts 共同路径）。新增诊断沉淀 `smoke-headless-bashprobe.ts`（F9 证据源）。
realmodel 收敛过程实录（模型面/环境面抖动，均已在脚本内加固）：① b2 会话「只回复收到」
强指令压掉 C7 → C7 独立会话；② 裸 `env` 被 auto 分类器正当拦（F9）→ 自检脚本只输出判定 JSON；
③ auto 分类器 stage-2 error fail-closed + 48~154s 延迟（F9）→ C7 会话 bypassPermissions；
④ 模型先 Read 再动 Bash 的漂移 → verdict 正则提取（源码 `envKeys:` 未带引号不会误中）+
prompt 禁先读；⑤ 多挂活 CLI 放大 qwen 慢尾致 D1 message_stop 偶发超 150s 轮次窗 →
C7 会话用完即 session_stop 释放负载。

**补测轮（同日第三批，B9/B10 收口）**：沉淀 `smoke-headless-policy.ts`（真模型，实测 **6/6**：
B10 四判 + B9 + C8-lite），B9/B10 双闭环。两个新发现：**F10**（session_init 每轮重发同 id，
re-key 须幂等、init 计数不是重启判据——B14 证据强度连带降级）与 **F11**（tasklist 进程枚举
本机间歇漏检活进程，/FI 与全表形态都中招——`smoke-headless-lib.ts` 观测层整体切 PS CIM，
归属判据 claudeChildrenOf(runtimePid)；历史台账的 PID 类结论强度降级为「tasklist 观测面未见异常」）。
诊断沉淀 `probe-reinit.ts` / `probe-session-proc.ts`（均可复跑）。
**观测层切换后全家族回归复跑（同日，HEAD=05c024a，src 零改动）：host 22/22 ✓、
gateway 20/20 ✓、realmodel 13/13 ✓（317s，残留 0）、policy 6/6 ✓——四批全绿**。
（本轮 B14 仍记 session_init=2，与 F10 的「计数不可判别」一致，复核留下轮。）

**未执行（留下轮）**：E 组全部（依赖 agri starter 接入，见 §6 前置）；
B14 btw 自毁复核（按 F10 新判据钉 init id 变化）。

### 已知风险回填（预登记四项 → 实测结论）

| 预登记 | 实测结论 |
|---|---|
| A20 SSE 写背压无降级 | **坐实**：纯缓冲（10×500KB→RSS Δ5.2MB、零丢帧、宿主照常服务）；慢消费=内存线性累积，治理面在网关（勤读）+ 引擎侧是否补熔断待定 |
| B1 re-key 语义未钉死 | **钉死**：session_init 后命令与订阅一律用 SDK 真 id；旧 client sid 续发=静默新建全新会话（对接文档红字 + 网关侧「收到 session_init 即切订阅键/命令键」规程） |
| B14 btw/automation 放行面 | btw 实测按桌面语义执行（自毁重建）；automation 面未动。**建议后续从 headless schema 剥除 btw/lightweight 或文档明令网关不发** |
| D5 无会话持久化 | **实锤**：崩溃全丢、旧键重发得全新会话；resume_session_id 是唯一续接通道（B11 实测可用） |

### 发现清单（F1-F11；文档级处置统一收口对接文档，见 §7 头注）

| # | 级别 | 现象（实测证据） | 影响 | 定位线索 |
|---|---|---|---|---|
| **F1** | P1·平台语义 | Windows 上 `kill("SIGTERM")`/TerminateProcess **不执行** `process.on("SIGTERM")` 收尾：实测 70ms 退出、exit code≠0、SSE 收 RST(error) 非 done；close() 里 router.closeAll()/manager.shutdown() 全部旁路。活轮场景实测孤儿 claude.exe=1（realmodel 收口定点回收） | 「优雅关停」只在 macOS/Linux 成立；Windows 部署=崩溃等价，网关侧必须自带孤儿清理（按父 PID 差集） | `src/index.ts` headless 分支 signal 面；Windows 信号语义 Node 已知限制 |
| **F2** | P1·时序 | 死端点 error 帧延迟到达：90s 双通道空，实测 ≤189s（CLI 内部重试梯度），message 带 ConnectionRefused | 网关不能假设端点故障快速可见；须自备超时 + interrupt 驱动终态 | session-worker catch→emit error 前全程挂 SDK 重试 |
| **F3** | P0·✅已核实已修复 | gateway C4 臂：error 帧到达（≈189s）后对同 worker 真 id 续发带新 mcp_headers 的 send，**90s 内 mock MCP server 无新连接命中**；而 stop+resume 新 worker 路径（realmodel D3）新头正常。**a3284fc 统一基线原样复现=与模型切换修复无关的稳定行为**。**【核实】根因=死端点 error 以 in-band result（error_during_execution+api_error_status）到达而非 throw：mapper 只发 error 帧（无 message_stop），for-await 继续等待、currentQuery 存活 → 续发走「普通续发」分支喂进 env/头已随 spawn 固化的僵尸 CLI，永不重启重连。原清单注释「error→loop break」是 thrown 型错误才有的心智模型。【修复】mapper.isErrorResult（单一谓词，良性打断豁免=B5 契约）→ turnMessages 返回 "terminate" → startLoop 循环体内同步置空 currentQuery（封「错误帧已发、await gen.return() 未完」的竞态窗）→ break 后 q.close()（N4）→ finally 代际守卫防误清新 query。下一条 send 以 resume 重启、env/头重新定装。复跑 gateway 20/20（C4 臂 TOK_ROT 端到端命中）+ 单测（terminate/良性豁免/插队优先/重启/竞态窗）全绿** | ~~若「error→break→续发」不触发 query 重启重连，则存活网关会话的 token 轮换在异常恢复路径上不生效~~ **已闭环**：error 终态后同 worker 续发=自动 resume 重启重连（对接文档三句语义见 C4 行） | `engine/mapper.ts` isErrorResult / `turnMessages.ts` terminate / `session-worker.ts` startLoop 终止块+finally 代际守卫 |
| **F4** | P0·✅已核实已修复（产品级 bug，桌面同受影响） | 同一 env 探针：跑A=`tool_use_start Bash×2` 但 SSE 无 tool_result、无 permission_request、hook 未落盘；跑B（a3284fc 统一基线）=**连 Bash 调用都没有**（tools=[]）。**【核实】原嫌疑「默认权限静默拒」不成立。真根因（跑A 形态）=settings.json 的 command 型用户 hook（Rust hooks.rs 写入、桌面 HookEditor 可建）被 loadUserHooks 原样透传进 SDK options.hooks——该通道只认 HookCallback 函数，SDK initialize 零校验注册、hook 触发时按函数调用：非函数 → TypeError → hook_callback 控制请求 error 收场 → CLI 工具管线断流（tool_use_start 后零 tool_result、零 permission_request、hook 自身也从未执行）。smoke 配置根恰好带 matcher:"Bash" 的 command hook → 只有 Bash 中招（Write 臂 B4 全程正常）。跑B/复跑1 tools=[] 是另一层：b2 会话首轮「无论我说什么都只回复收到、不要使用任何工具」强指令压掉 C7 的 Bash 要求（测试面污染，C7 改独立会话后消除）。修复后残层=auto 分类器拦 env dump → 见 F9。【修复】新模块 `engine/commandHooks.ts`：compileCommandHook 把 command 条目编译成真 HookCallback（spawn + stdin 喂 HookInput JSON + stdout JSON 透传 + exit code 协议 0/2/其它 + timeout 必杀 N4 + 平台 shell 解析 Git Bash/PowerShell/$SHELL、排除 System32 WSL bash + N5 命令原文不落日志）；loadUserHooks 编译；assembleHooks 末道守卫滤非函数。复跑 C6 PASS（hook env 落盘 11150B 零哨兵）、C7 PASS（自检脚本 verdict clean）** | ~~C6/C7 两条安全红线端到端臂未闭环~~ **已闭环**（修复轮双 PASS）。桌面侧影响：HookEditor 建的用户 hook 此前从未真正执行过且会断掉匹配工具的管线——本轮修复后开始生效（行为变化需在桌面回归中留意） | `engine/commandHooks.ts`（新）+ `engine/userExtensions.ts` + `session-worker/queryContext.ts`；证据链=sdk.mjs initialize/handleHookCallbacks + Rust hooks.rs:73-75 |
| **F5** | P2·协议客户端陷阱 | >1MB body：服务端先回 400 再因请求体未读尽 RST；fetch 客户端抛 ECONNRESET 拿不到状态码（裸 http.request 可） | 网关 SDK 实现方会踩；文档写明「超限响应以首响应状态码为准」或引擎读尽/Connection:close | `headless-server.ts` readBody throw 路径 respondJson |
| **F6** | P2·部署面 | dist 入口只读 `AIDE_HEADLESS_PORT`/`AIDE_HEADLESS_TOKEN`，无 host env——`assertLoopbackUnlessAuthenticated` 的非回环臂在产物形态不可达 | 对外暴露必须走网关反代（正确形态），或未来加 `AIDE_HEADLESS_HOST`（加了就依赖 token 强制） | `src/index.ts` headless 分支 opts 组装 |
| **F7** | P2·观察 | 第三方 provider（qwen）下 set_model 无 models_available 回执（effort/modes 回执正常）；非法 effort 正确不脏账面。**a3284fc 统一基线复验仍在=独立于模型切换修复的发现**（set_model 的 result 面正常，仅 roster 清单事件缺席） | 网关 UI 若依赖 models_available 渲染选择器，第三方 provider 下拿不到清单——headless 协议文档需注明缺席语义 | modelRoster/switch guard 对非 anthropic catalog 的行为 |
| **F8** | P2·契约 | btw 字段在 headless schema 放行且按桌面语义执行（回合后自毁重建）；automation 面未测 | 误用面：网关发 btw 会造出「一轮一会话」的静默重建；对接文档明令禁发或 schema 剥除 | `headless-schema.ts` sendCommand btw/lightweight 字段 |
| **F9** | P1·环境（修复轮新发现，非引擎缺陷） | **auto 模式权限分类器在 qwen provider 下 flaky**：① 裸 `env` 被按「Credential Materialization」**正当拦截**（deny 文本进 tool_result，48s 分类延迟）；② 良性命令（`node <自检脚本>`，一字未改）也吃到 `Stage 2 classifier error - blocking based on stage 1 assessment (usually transient — retrying often succeeds)` 的 fail-closed 拒绝（154s），模型重试一次后超轮次预算（bashprobe 全轨迹实锤）。旁证：realmodel D1 臂偶发 message_stop 超 150s 轮次窗（文本/hits 全对，仅收口慢——同源慢尾） | 网关长驻会话若用 auto 模式 + 第三方 provider，工具面稳定性受分类器质量支配；对接侧须显式规划：permission_policy 规则前置（规则命中不依赖分类器）/ 明确 permission_mode 选型 / 轮次预算放宽 | CLI 内部 auto-mode classifier（sidecar 不可控）；证据=`smoke-headless-bashprobe.ts` 可复跑；C7 探针已按此改 bypassPermissions+自检脚本（红线语义不变） |
| **F10** | P2·契约观察（B10 补测轮新发现，良性） | 同 sid 续发时 `session_init` **每轮重发（同一 id）**：probe-reinit 实锤——两轮 send 得 init×2、id 唯一、claude.exe PID 跨轮不变（76952）、零 error 帧、stop_reason=end_turn×2。流式输入 CLI 每轮重发 system/init，query 存活未重启 | 两个含义：① 网关 re-key 必须**幂等**（init id 变化才是会话重启判据，计数不是）——已写入对接文档 §0 条1/§3；② **B14 证据强度降级**：btw 轮的 session_init×2 可被每轮重发完全解释，不构成自毁重建的实证（btw 自毁代码路径本身存在，smoke 判据留下轮按 id 复核） | `engine/mapper.ts` system/init 分支；证据=`probe-reinit.ts`（bypass+纯文本形态）+ `probe-session-proc.ts`（manual+策略形态：会话 claude.exe 36992 父=runtime、跨轮存活，归属实锤）可复跑；B10-4 已按新判据（init id 唯一+零 error+runtime 子进程 claude.exe 集合三采样点不变）钉死零重启 |
| **F11** | P2·验收工具观测面（B10 补测轮新发现） | **tasklist 进程枚举在本机间歇性漏掉活进程，/FI 过滤与全表形态都中招**：probe-session-proc 同刻双观测实锤——PS CIM 可见 runtime(77696) 子进程 claude.exe(36992) 轮中/轮后均存活，同一时刻 tasklist 全表差分恒空（此前 /FI 形态 22 次采样亦全空）；疑与杀软挂钩进程枚举有关 | smoke 家族的 PID 判据全部踩在这个观测面上（B12/D6 的 1:1 净增、A16 残留回收、B10-4 零重启判据）——漏检=静默失真（残留误报 0 / 活进程误判消失）。**已修**：`smoke-headless-lib.ts` 观测层整体切 PS CIM（Win32_Process）：procTable/claudePids/claudeChildrenOf（父进程归属判据，tasklist 无此面）/rssKBOf（WorkingSetSize），tasklist 仅兜底；历史台账里「残留 0 / claude.exe 净增」结论强度降级为「tasklist 观测面未见异常」 | `smoke-headless-lib.ts` 进程面观测层；证据=`probe-session-proc.ts` 可复跑 |

**出口判定（修复轮更新）**：第一轮出口「双租户彩排通过 + 两条安全红线有实测证据」——
双租户彩排 ✅（D1/D2/D3 + gateway 全套，修复轮 20/20）；C8 日志红线 ✅（含真 token 哨兵）；
**C7 cliEnv 红线 ✅ 已闭环（修复轮：Bash 子进程自检脚本 verdict clean、envKeys=141 实证真实 env）**；
C6 shell hook 红线 ✅ 已闭环（hook env 落盘零哨兵）。**agri 对接前的 P0 阻塞项清零**；
遗留处置（补测轮更新）：B9/B10 ✅ 已补测闭环（policy-smoke 6/6）；F9 与 F1/F2/F5~F8 的
文档级处置 ✅ 已收口对接文档（网关实现方唯一必读）；F10/F11 新增
（均 P2，观测面/判据已修）；剩余=E 组（待 agri starter）+ B14 复核（P2）。

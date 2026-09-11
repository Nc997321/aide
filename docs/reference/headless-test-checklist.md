# Headless 引擎测试清单

> 2026-09-11 建。headless 宿主（`agent-sidecar/src/headless-server.ts`，`node dist/runtime.js headless`）
> 至今只有单测（725 用例内覆盖）+ 一条 MCP 头注入 smoke，**未做过正式验收**。本清单是正式测试
> 的执行底稿，结合 agri-ai-agent 项目（`C:\document\project\zhongke\agri-ai-agent`，MCP 方案
> 2026-09-10 定稿：Aide 引擎当编排大脑、业务做 Spring AI MCP server、token 走 HTTP header 透传）
> 把「网关形态」作为验收主轴。
>
> 勾选约定：`[ ]` 待测 / `[x]` 通过 / `[!]` 失败（记缺陷号）。优先级 P0=对接前必过、P1=正式验收、P2=可延后。
> 自动化标记：✅已有自动化（列明位置）/ 🔧可脚本化（建议沉淀进 smoke 家族）/ 👤手动。

## 0. 已有自动化资产（不要重测，改动时复跑即可）

| 资产 | 覆盖 | 位置 |
|---|---|---|
| headless 单测 38 例 | schema 10 命令、SSE 会话隔离、鉴权 401、安全基线拒启、body 上限、500 上下文、hello 帧、protocol 响应 | `agent-sidecar/src/headless-server.test.ts` |
| 机制①单测 | mcp_headers 注入/通配/刷新/N5、metadata hook 活值读取 | `engine/sessionMetadata*.test.ts`、`engine/sessionMetadataWiring.test.ts` |
| 端到端 smoke | dist 产物 headless 起服 → POST /invoke 带 mcp_headers → mock MCP server 实收注入头 | `agent-sidecar/smoke-headless-mcp-headers.ts`（`npx tsx` 直接复跑） |

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
| A1 | 启动与版本握手 | 起服读 stdout | `{"type":"headless-listening","port":…,"protocol":1}` | P0 | ✅单测(部分)/🔧 | [ ] |
| A2 | SSE hello 首帧 | GET /events?sessionId=s1 | 首帧 `{"type":"hello","protocol":1,"sessionId":"s1"}` | P0 | ✅ | [ ] |
| A3 | invoke 成功响应形状 | POST /invoke 合法 send | 200 `{"ok":true,"protocol":1}`；真实结果只走 SSE，不在响应里 | P0 | ✅ | [ ] |
| A4 | 无 token + 非回环 = 拒启 | `host:"0.0.0.0"` 无 token | 启动即抛错拒绝监听 | P0 | ✅ | [ ] |
| A5 | Bearer 鉴权三态 | 无 token/错 token/对 token | 401/401/200 | P0 | ✅ | [ ] |
| A6 | 10 命令白名单面 | 逐命令最小合法体 | 全部 200 入队；`codegraph_result` 与未知命令 400 | P0 | ✅ | [ ] |
| A7 | schema 深校验拒绝臂 | send 带非法 images/automation/permission_policy/mcp_headers | 400，错误含 path+code、**不回显值** | P0 | ✅ | [ ] |
| A8 | 前向兼容透传 | send 带未知顶层字段/未知 display 块 | 200，字段原样到命令层（loose 不剥） | P1 | ✅ | [ ] |
| A9 | SSE 多会话隔离 | s1/s2 各订阅，交叉 dispatch | 各收各的，互不可见 | P0 | ✅ | [ ] |
| A10 | 同连接跨会话重订阅 | 一条连接先订 s1 再订 s2 | s1 事件不再投递（旧键摘净） | P1 | ✅ | [ ] |
| A11 | SSE 断线重连语义 | 订阅后断开、期间发事件、再订阅 | **无回放**（订阅制，断开期间事件丢失）——网关侧必须容忍或自行补偿；重连后 hello 帧重发 | P1 | 👤 | [ ] |
| A12 | 心跳保活 | 订阅后静置 >30s | 收到 `: ping` 注释行；中间代理不掐链 | P2 | 👤 | [ ] |
| A13 | body 上限 | POST >1MB | 400，进程无恙 | P1 | ✅ | [ ] |
| A14 | 非 JSON body | POST `not-json{{{` | 400 | P1 | ✅ | [ ] |
| A15 | 命令路由同步异常 | manager.handleCommand 抛错 | 500 带上下文，进程不崩 | P1 | ✅ | [ ] |
| A16 | 优雅关停 | SIGTERM/SIGINT | SSE 连接被主动断开（客户端 reader 收到 done）、worker 停止、进程退出码 0；**无孤儿 claude.exe** | P0 | 🔧 | [ ] |
| A17 | 二次 close 幂等 | 重复触发关停 | 不抛错不挂死 | P2 | ✅ | [ ] |
| A18 | 未订阅会话的事件 | dispatch 无人订阅的 sid | 静默丢弃不积压（订阅制语义） | P1 | ✅ | [ ] |
| A19 | `_runtime` 健康帧 | 起服静置 30s | health 事件无订阅者 → 静默；**确认不会**投给任意业务订阅者 | P2 | 👤 | [ ] |
| A20 | SSE 写背压（已知风险） | 订阅端故意不读（暂停 socket），服务端持续产事件 | 观察内存增长与行为——`dispatch` 只在写抛错时摘连接，`res.write` 返回 false（内核缓冲满）无降级路径；**桌面 stdio 路径有熔断，SSE 路径没有**，此项探边界并记录实测行为 | P1 | 👤 | [ ] |

## 3. B 组：引擎集成级（真 claude.exe，死端点或真 provider）

| # | 场景 | 操作 | 预期 | 级别 | 自动化 | 结果 |
|---|---|---|---|---|---|---|
| B1 | 会话全生命周期 | send（死端点）→ SSE 收事件 | session_init（客户端 sid 与 SDK 真 id 的 re-key 语义：后续命令用哪个 id 要实测钉死）→ …→ 端点不通时 error 帧 fatal:false，进程存活 | P0 | 🔧 | [ ] |
| B2 | 真模型问答轮 | send.env 带真 provider，prompt "回复 ok" | text_delta 流式 → message_stop（usage/effort 字段）→ 状态可再发第二轮（同 sid 上下文保持） | P0 | 👤 | [ ] |
| B3 | user_message 回灌 | send 带 display 块 | SSE 收到 user_message 事件、display 原样回灌（三端单一渲染来源契约在 headless 同样成立） | P1 | 🔧 | [ ] |
| B4 | 权限确认流（agri 写确认的引擎侧原型） | 配 permission_mode=manual + prompt 诱导写文件 | permission_request 事件到 SSE → POST permission_response(approved) → 工具执行；(approved=false) → deny 结果 | P0 | 👤 | [ ] |
| B5 | interrupt | 长任务中 POST interrupt | 当前轮终止、message_stop(interrupted) 或等价终态；后续 send 可用 | P1 | 👤 | [ ] |
| B6 | session_stop | POST session_stop | worker 停止、claude.exe 释放（进程表核实）；再 send 同 sid = 新会话（resume 语义另测） | P0 | 🔧 | [ ] |
| B7 | set_model / set_effort / set_permission_mode | 存活会话逐个下发 | models_available / effort_changed / permission_modes_available 回执事件；非法值拒绝且不脏账面 | P1 | 👤 | [ ] |
| B8 | model_switch_confirm_decision | 缓存热+大上下文时切模型 | model_switch_confirm 事件 → POST decision(approve/deny)；不应答 10s 自动 deny | P2 | 👤 | [ ] |
| B9 | stop_bg_task | prompt 诱导后台任务（run_in_background）→ POST stop_bg_task | bg_task_ended(status:stopped) | P2 | 👤 | [ ] |
| B10 | update_permission_policy | 会话中推策略快照（revision 递增） | 后续工具调用按新策略裁决；旧 revision 被忽略 | P1 | 🔧 | [ ] |
| B11 | resume 语义 | send 带 resume_session_id（此前会话的真 id） | 上下文接续（问它上一轮说了什么） | P1 | 👤 | [ ] |
| B12 | 并发多会话 | 3 个 sid 并行 send | 事件按 sid 各归各；无交叉污染；内存/进程数随会话数线性、停止后回收 | P1 | 🔧 | [ ] |
| B13 | 同会话并发 send | 同 sid 快速两连发 | 第二条排队/插队语义与桌面一致（sendQueue 串行化），不崩不乱序 | P1 | 🔧 | [ ] |
| B14 | 网关误发桌面字段 | send 带 btw/automation | 行为如实记录（schema 放行、引擎按桌面语义执行——btw 自毁/automation 白名单）；**对接文档应写明网关不该发**，或决定后续从 headless schema 剥除 | P2 | 👤 | [ ] |

## 4. C 组：机制①（会话元数据 + MCP 头注入）——agri 多租户的引擎侧底座

| # | 场景 | 操作 | 预期 | 级别 | 自动化 | 结果 |
|---|---|---|---|---|---|---|
| C1 | 精确名注入 | send.mcp_headers={"agri-platform":{…}} | 仅该 server 收到头 | P0 | ✅smoke | [x] 2026-09-11 |
| C2 | `"*"` 通配注入 | mcp_headers={"*":{"X-User-Token":…}} | 所有 http/sse server 收到；stdio/sdk 型不受影响 | P0 | ✅单测/🔧端到端 | [ ] |
| C3 | 注入头覆盖配置头 | settings.json 静态头 + send 同名头 | 会话级值生效（授权身份优先） | P1 | ✅单测 | [ ] |
| C4 | token 轮换 | 第二条 send 带新头 | 下一次 query() 重连用新头（**当前存活 query 仍用旧头**——已声明边界，实测钉死行为与文档一致） | P1 | ✅单测/👤端到端 | [ ] |
| C5 | 非法注入表 fail-closed | mcp_headers 值非 string | 400（schema 层）；绕过 schema 直灌 stdin 时整表忽略 + console.error **不含值** | P0 | ✅单测 | [ ] |
| C6 | metadata hook 可读 | send.metadata={"tenant":"acme"} + 配置根放一个自定义 hook（读不到 metadata 就退而验证内建口）| 进程内 hook 经 HookBuildContext.session.metadata() 读到活值；**用户 shell hook 读不到**（设计代价，验证无 env 泄漏） | P1 | ✅单测(进程内)/👤shell侧 | [ ] |
| C7 | 安全红线：cliEnv 无泄漏 | 任意 metadata/mcp_headers 会话中让模型跑 `env` | 子进程环境变量**不含** metadata 内容与注入头值（Bash 工具不可外带） | P0 | 🔧 | [ ] |
| C8 | 安全红线：日志无泄漏 | 全程收集 runtime stdout/stderr | 无任何头值/凭据出现（N5） | P0 | 🔧 | [ ] |
| C9 | 会话间头隔离 | s1 带头 A、s2 带头 B，同一 MCP server | server 侧按会话收到各自的头（per-query options 天然隔离，端到端钉死） | P0 | 🔧 | [ ] |

## 5. D 组：网关形态模拟（agri 对接彩排，无需 agri 代码）

用一个 ~200 行 node/Spring 脚本扮演 agri 网关：持有 AIDE_HEADLESS_TOKEN，为每个"租户请求"生成 sid，
send 时塞 `metadata`（租户上下文）+ `mcp_headers`（`X-User-Token`），订阅 SSE 转发给"业务前端"（控制台即可）。

| # | 场景 | 预期 | 级别 | 结果 |
|---|---|---|---|---|
| D1 | 双租户并行会话 | 租户 A/B 各一个 sid 同时问答，SSE 流互不可见；mock MCP server 日志显示各会话带各自 X-User-Token | P0 | [ ] |
| D2 | 写操作确认流全链 | manual 模式诱导写 → 网关收到 permission_request → 模拟业务前端确认 → permission_response → 执行完成 → message_stop | P0 | [ ] |
| D3 | 租户 token 失效轮换 | 会话中途换 X-User-Token 重发 → 下一轮 MCP 调用带新 token（mock server 验证） | P1 | [ ] |
| D4 | 网关重启韧性 | 杀网关脚本再起：runtime 不受影响；旧 sid 的 SSE 重订阅后继续收事件（无回放，见 A11） | P1 | [ ] |
| D5 | runtime 崩溃恢复 | 杀 runtime → 网关侧 SSE 断开可感知 → 重启 runtime 后新会话可用；**旧会话不恢复**（内存态，如实记录对接约束） | P1 | [ ] |
| D6 | 单实例多用户容量摸底 | 10 个并行会话（死端点即可，只压宿主面）：内存/句柄线性、SSE 帧不串、无泄漏 | P2 | [ ] |

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

## 7. 执行顺序建议与出口准则

1. **第一轮（P0，半天）**：A 组复跑 ✅ 项 + A16/A20 + B1/B2/B4/B6 + C7/C8/C9 + D1/D2。
   出口：网关形态本机双租户彩排通过，两条安全红线有实测证据。
2. **第二轮（P1，一天）**：B/C/D 剩余 + E1-E4（依赖 agri starter 接入完成度）。
   出口：agri 读直达/写确认/权限继承三件事端到端成立。
3. **第三轮（P2）**：容量、热更、裁剪类。
4. 全部 🔧 项脚本化沉淀（建议 `agent-sidecar/smoke-headless-*.ts` 家族：gateway 彩排脚本
   命名 `smoke-headless-gateway.ts`），进 CI 前至少进「可复跑验收工具」清单。

**已知风险预登记**（测前明示，测后回填结论）：
- A20 SSE 写背压无降级路径（桌面 stdio 有熔断，SSE 没有）——慢消费网关可能顶爆 runtime 内存；
- B1 的 re-key 语义：客户端 sid vs SDK 真 id，headless 客户端该用哪个续发命令，文档未钉死；
- B14 桌面专属字段（btw/automation）在 headless schema 放行——是灵活面也是误用面；
- D5 runtime 无会话持久化，崩溃=全丢（内存态设计，对接文档必须写明）。

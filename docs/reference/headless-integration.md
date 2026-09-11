# Headless 引擎对接文档（网关侧）

> 2026-09-11 建。读者：把 Aide headless 引擎（`node dist/runtime.js headless`）当编排大脑的
> 宿主网关实现方（首个对接方 = agri-ai-agent，MCP 方案 2026-09-10 定稿）。
> 本文是 `docs/headless-test-checklist.md` 里所有「对接文档写明」项的收口（F1/F2/F5~F10 文档级
> 处置 + B1 re-key / C4 三句 / A11 / A20 / D5 契约）；每条都有实测证据，出处以（A1）（F3）
> 等标注回清单。协议版本 **PROTOCOL_VERSION = 1**。

## 0. 对接规程（红字汇总，先读这十条）

1. **re-key**：收到 `session_init` 事件后，命令键与订阅键**立即**换成事件里的 SDK 真 id；
   拿旧 client sid 续发 = 静默新建全新会话（上下文丢失、无任何报错）（B1）。
   注意 `session_init` **每轮都会重发（同一 id，CLI 流式输入的良性行为**，probe-reinit
   实锤：PID 不变、零 error 帧）——网关的 re-key 处理必须**幂等**：id 没变就不动键；
   **id 变了才是会话重启**（error 终态自动 resume / btw 自毁等），按新 id 重新 re-key。
2. **SSE 无回放**：断开期间的事件永久丢失，重连只补 hello 帧——网关必须容忍或自行补偿（A11/A18）。
3. **SSE 勤读**：写路径无熔断，慢消费 = 引擎侧内存线性累积；不要长时间暂停读（A20）。
4. **token 轮换三句**（C4/D3/F3）：① 存活 query 续轮**永不换头**（头在 query 启动时刻定装）；
   ② 轮换 = `session_stop` → 带 `resume_session_id` + 新 `mcp_headers` 重发；
   ③ error 终态后下一条 send **自动** resume 重启重连（带最新头）。
5. **无持久化**：引擎会话是内存态——runtime 崩溃/重启全丢，`resume_session_id` 是唯一续接
   通道（CLI 侧转录还在就能接上）（D5/B11）。
6. **故障可见性慢**：模型端点不可达时 error 帧最长 ~189s 才到（CLI 内部重试梯度）——
   网关必须自备轮次超时，超时后 `interrupt` 驱动终态（F2）。
7. **Windows 无优雅关停**：kill = 强制终止（SIGTERM 收尾不执行、exit code≠0、SSE 收 RST
   而非干净 done）；Windows 部署网关须自带孤儿 `claude.exe` 清理（按父 PID 差集；进程枚举
   用 WMI/CIM——`tasklist` 在部分机器间歇漏检活进程，验收工具已因此踩坑，F11）（F1）。
8. **权限模式选型**：第三方 provider 下别裸依赖 auto 模式（内置分类器 flaky：48~154s 延迟 +
   fail-closed 误拒）；规则前置 / manual / bypassPermissions 三选一，见 §6（F9）。
9. **body ≤1MB**：超限响应形态对 fetch 类客户端不友好（400 后 RST），网关侧先自我限界（F5）。
10. **桌面字段禁发**：`btw` / `lightweight` / `automation` 是桌面语义，网关发 btw 会造出
    「一轮一会话」的静默自毁重建（F8/B14）。

## 1. 启动与部署形态

```bash
node dist/runtime.js headless
# env：AIDE_HEADLESS_PORT（默认 18090）、AIDE_HEADLESS_TOKEN（Bearer 鉴权）
# 隔离配置根（推荐网关形态）：CLAUDE_CONFIG_DIR=<临时/专属目录>，其 settings.json 放 MCP server 表
```

- 启动成功 stdout 一行：`{"type":"headless-listening","port":…,"protocol":1}`。
- **只监听 127.0.0.1**：dist 入口无 host 配置面（只读 PORT/TOKEN 两个 env）；无 token 时
  非回环监听启动即拒（安全基线）。对外暴露的唯一正确形态 = 网关反代（F6）。
- 设了 `AIDE_HEADLESS_TOKEN` 后，`/invoke` 与 `/events` 全部要求
  `Authorization: Bearer <token>`；缺失/错误一律 401（A5）。

## 2. 协议面

### POST /invoke

- JSON body ≤ **1MB**（`MAX_INVOKE_BODY_BYTES`）。
- `200 {"ok":true,"protocol":1}` **只表示已入队**——真实结果一律走 SSE，不在响应里（A3）。
- `400`：schema 校验失败，错误含 `path`+`code`、**不回显提交值**（A7）；非 JSON body 同 400（A14）。
  **陷阱**：超 1MB 时服务端先回 400 再因请求体未读尽 RST 连接，fetch 类客户端会抛
  ECONNRESET 拿不到状态码（裸 http.request 可）——以首响应为准，或网关侧自我限界（F5）。
- `500`：命令路由同步异常，带上下文，进程不崩（A15）。
- 白名单恰 10 命令（§7）；`codegraph_result` 永关（桌面专用回包通道），未知命令 400（A6）。

### GET /events?sessionId=\<sid\>（SSE）

- 首帧：`{"type":"hello","protocol":1,"sessionId":"…"}`——客户端连上即知版本，不匹配应拒连（A2）。
- 业务帧：`{"sessionId":"…","event":{…}}`——event 即引擎 ChatEvent（text_delta / message_stop /
  permission_request / bg_task_* / …）。
- 心跳：每 30s 一行 `: ping` 注释（A12）。
- **订阅制语义**：按 sessionId 隔离投递（A9）；一条连接重订阅新 sid 后旧 sid 停投（A10）；
  无人订阅的事件静默丢弃不积压（A18）；断线重连**无回放**（A11）。
- 特殊 sid `_runtime`：收引擎 health 帧；业务订阅者**不会**收到 health（A19）。
- 背压：`res.write` 纯缓冲无熔断——实测 10×500KB 灌暂停连接 RSS +5.2MB、恢复读后零丢帧；
  慢消费 = 引擎内存线性累积，治理责任在网关（勤读）（A20）。

## 3. 会话生命周期

```
网关                            引擎
 │ POST /invoke send(client_sid) │
 │ ─────────────────────────────▶│ 起 claude.exe（query spawn）
 │ SSE: session_init{session_id} │ ◀── 真 id 诞生
 │ 【re-key：命令/订阅键换真 id】 │
 │ send(真id) … permission_response(真id) … │
 │ session_stop(真id)            │ worker 停止、claude.exe 释放（B6）
 │ send(新sid, resume_session_id=真id) │ ◀── 唯一续接通道（B11）
```

- `session_init` 每轮重发（同 id，见 §0 第 1 条）。**会话重启的判据 = init id 变化**
  （伴随 error 帧 / claude.exe PID 更换），不是 init 计数。
- 同 sid 快速连发：串行排队不丢不乱序（sendQueue，B13）；并发多会话按 sid 各归各（B12）。
- 崩溃恢复：杀 runtime → 网关 SSE 断开可感知（reader error）→ 重启后**旧会话不恢复**，
  旧键重发 = 全新 SDK 会话；续上下文必须 `resume_session_id`（D5）。
- 进程收尾：POSIX 下 SIGTERM 优雅关停（SSE 干净 done、worker 停止、exit 0）；
  **Windows 下 kill 即崩溃等价**——见 §0 第 7 条（F1/A16）。

## 4. MCP 头注入与会话元数据（多租户底座）

send 两个类型化字段（机制①）：

- `mcp_headers: Record<serverName | "*", Record<string,string>>`——会话级注入 HTTP 头：
  只注 `http`/`sse` 型 MCP server（stdio 无头面）；`"*"` 打底、精确名优先；注入头**覆盖**
  settings.json 静态同名头；**每次 send 刷新、缺席 = 清空**（轮换语义）。
  非法表 fail-closed：schema 层 400；绕过 schema 直灌时整表忽略且日志不含值（C5）。
- `metadata: Record<string, unknown>`——不透明租户上下文：进程内 hook 经
  `HookBuildContext.session.metadata()` 读活值；**用户 shell hook 读不到**（刻意代价）（C6）。

**安全红线（实测钉死）**：metadata / mcp_headers 的值**绝不进** Bash 工具子进程 env
（C7：子进程 141 个 env 键逐值扫描零命中），也绝不落 runtime 日志（C8：含真 token 哨兵）。
模型无法经工具面外带网关注入的凭据。

**轮换边界**：头在 `query()` spawn 时刻定装——存活 query 内不换头；生效时机见 §0 第 4 条三句。
会话间天然隔离：同一 MCP server 按连接收到各会话自己的头（C9）。

## 5. 事件与命令对照（网关视角）

| 命令（POST /invoke） | 触发的事件（SSE） | 备注 |
|---|---|---|
| `send` | session_init（首条）→ text_delta… → message_stop | 23 字段，见 §7 |
| `permission_response` | （permission_request 的应答）→ 工具继续/deny | 可携 `sessionRules`（会话级 allow 规则入库）|
| `interrupt` | message_stop(stop_reason=interrupted) | 当前轮终止，会话可续（B5）|
| `update_permission_policy` | 无回执事件 | 活体生效，见 §6 |
| `stop_bg_task` | bg_task_ended(status:stopped) | 后台任务终态走既有通道 |
| `set_model` | model_switch_confirm（缓存热+大上下文）或 model_switch_result | confirm 需 `model_switch_confirm_decision` 应答，10s 不应答自动 deny（B8）|
| `set_effort` | effort_changed | 非法值拒绝且不脏账面（B7）|
| `set_permission_mode` | permission_modes_available | 存活期模式切换唯一通道 |
| `session_stop` | —（worker 停止，claude.exe 释放）| |
| `model_switch_confirm_decision` | model_switch_result | approve/deny |

- user_message 回灌：send 带 `display` 块时 SSE 收到 user_message、display **原样回灌**
  （浅校验不透明透传，未知块也保留）——三端单一渲染来源契约在 headless 同样成立（B3/A8）。
- **观察项**：第三方 provider（无 SDK roster）下 `set_model` **不发** models_available 回执
  （result 面正常）——网关 UI 的模型选择器不得依赖该事件（F7）。

## 6. 权限面（重点：模式选型）

三层裁决，优先级从高到低：

1. **策略快照**（Aide policy）：`send.permission_policy` 首带 + `update_permission_policy`
   活体推送。语义（B10 实测）：
   - revision **单调不回退**：旧 revision 快照被静默忽略（入队仍 200）；
   - 推送**不重启会话**：存活 worker 的下一次工具调用即按新策略裁决；
   - allow/deny 由 PreToolUse hook **直接裁决**（不产生 permission_request）；
     ask 转入 permission_request 确认流；无匹配规则 → 回退 permission_mode 默认流。
   - 规则形状：`{id, scope, order, effect, tool, matcher}`，matcher 四型
     （tool / bash prefix-contains / path file-folder / field equals）——与桌面
     `src-tauri/src/policy/model.rs` 同形。
2. **permission_mode**：首条 send 携带（续发**不回放**——存活期切换走 `set_permission_mode`）。
   manual = 每个工具都走 permission_request 确认流（B4/D2 实测：批准→执行落盘、
   拒绝→deny 不落盘且模型自然收尾）；bypassPermissions = 工具直接放行（策略 hook 仍生效）。
3. **CLI 内置 auto 分类器**：auto/default 模式下由 CLI 自行分类命令安全性。
   **选型红字（F9）**：第三方 provider（实测 qwen）下分类器 flaky——单步分类延迟 48~154s、
   stage-2 error fail-closed 误拒良性命令、模型重试放大轮次预算。网关长驻会话三选一：
   - **规则前置**：用 permission_policy 把业务工具面写成 allow/deny 规则——规则命中不经过
     分类器，裁决确定性恢复；
   - **模式选型**：写确认场景 manual（业务前端转发 permission_request 给用户）、
     受信批处理 bypassPermissions；
   - **预算放宽**：坚持 auto 则轮次超时/重试预算按 ≥3min/轮放宽，并容忍偶发误拒。
   证据可复跑：`agent-sidecar/smoke-headless-bashprobe.ts`。

permission_request 应答：`permission_response {session_id, id, approved, message?, sessionRules?}`；
不应答会一直挂起（interrupt 可整轮撤销，挂起请求一并作废）。

## 7. send 命令字段参考（网关常用子集）

```jsonc
{
  "cmd": "send",
  "session_id": "<client sid，首条；之后一律真 id>",
  "prompt": "…",
  "cwd": "<会话工作目录>",
  "env": { "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_AUTH_TOKEN": "…", "ANTHROPIC_MODEL": "…" },
  "permission_mode": "manual | auto | bypassPermissions | plan（首条生效）",
  "permission_policy": { "revision": 1, "rules": [ … ] },
  "resume_session_id": "<此前会话的真 id，唯一续接通道>",
  "metadata": { "tenant": "…" },
  "mcp_headers": { "*": { "X-User-Token": "…" }, "agri-platform": { "X-User-Token": "…" } },
  "display": [ … ]        // 不透明渲染描述，原样回灌 user_message
  // btw / lightweight / automation：桌面字段，网关禁发（§0 第 10 条）
}
```

- `env` 是 provider 凭据通道：只进 claude.exe 子进程 env，不落日志（C8 实测含真 token）。
- 前向兼容：未知顶层字段 / 未知 display 块**不剥除**（loose schema，A8）——引擎升级不破坏
  旧网关，但网关也别指望未知字段有任何语义。

## 8. 容量与运维实测基线

- 单实例 10 并行会话：宿主 RSS Δ6MB（≈0.6MB/会话，亚线性）；大头在各自 claude.exe
  ≈280MB/个；claude.exe 与会话 1:1；session_stop 后残留 0（D6；PID 计数当时用 tasklist
  观测面，强度按 F11 理解）。
- 复跑入口：`cd agent-sidecar && npm run build && npx tsx smoke-headless-{host,gateway,realmodel,policy}.ts`
  （协议面/网关彩排/真模型/策略与后台任务四批，期望台账 22/20/13/6 + exit code 可进 CI）。

# Aide Link 协议（v1）

> 状态：**v1 草案**（2026-09-30）——协议核心（帧 / 目录 / 配对 / 会话状态机 / 一致性向量）已在
> `src-tauri/crates/aide-link` 落地并通过测试；Host 侧接入（守护进程里的中继适配器）是下一步（P3b-2）。
> 手机端按本文实现；在手机端迁移完成之前，旧协议 v2（`src-tauri/src/remote/`）原样继续服务现有的 PWA / 鸿蒙端，
> 两者互不影响。
>
> **谁是真相源**：`crates/aide-link/src/frame.rs`（帧）+ `src/catalog.rs`（暴露目录）+ `tests/fixtures/`（一致性向量）。
> 本文是它们的叙述版；冲突时以代码和向量为准，并请把本文改对。TypeScript 类型见
> [`docs/aide-link/frames.d.ts`](aide-link/frames.d.ts)（与 Rust 同步，有测试守着）。

## 1. 它解决什么

手机要用 Aide 的会话 / agent，而 agent 跑在 **Host**（本机、WSL、SSH 服务器——见 [host-model.md](host-model.md)）上。
Aide Link 是**手机 ↔ Host** 之间的一条协议化通道：

- **直连 Host，不经桌面**：每个 Host（常驻守护进程）自己持有网关，手机配对的对象是 Host，不是某台桌面。
  桌面关了，Host 上的会话照常在，手机照常连。
- **协议，不是补丁**：握手 / 版本协商 / 认证 / 调用 / 订阅 / 续传 / 心跳 / 终止都有明确的帧；能调什么、能收什么
  由**一张可审计的目录**决定（且可经 `link.describe` 在线查询），不再是「桌面加一个能力就在手机协议里加一个消息变体」。
- **一张命令表，多个前门**：`call` 的方法名就是 Host 命令表里的命令名，参数 / 结果形状与桌面前端 `invoke` 完全一致。
  Aide Link 只是命令表的又一扇前门，不另造一套命令。

## 2. 分层与传输

```
┌──────────────────────────────────────────────┐
│ Aide Link 帧（本文）：hello / auth / call …    │  ← 手机端实现这一层
├──────────────────────────────────────────────┤
│ 中继层帧：connect / keepalive / connect_error  │  ← relay-server，已存在，不变（§2.2）
├──────────────────────────────────────────────┤
│ WebSocket 文本消息，每条 = 一个 JSON 对象       │
└──────────────────────────────────────────────┘
```

### 2.1 帧的通用规则

- 一条 WebSocket **文本**消息 = 一帧 = 一个 JSON 对象，`type` 字段区分种类（snake_case）。不用二进制消息。
- 帧自身的字段 snake_case（`device_id`、`max_frame_bytes`）；`params` / `payload` / `value` 里是 Host 命令的原样 JSON
  （camelCase，与桌面前端一致）。
- **接收方忽略未知字段**。客户端忽略未知的 Host 帧类型；Host 对未知的客户端帧类型回 `error{invalid_frame}`。
- 单帧上限 **8 MiB**（`limits.max_frame_bytes`），超过 = 协议违规，Host `bye{too_large}` 后断开。
- 编码 UTF-8。数字是 JSON 数字；`id` / `seq` / `n` 都是非负整数（`< 2^53`，JS 安全）。

### 2.2 中继（relay-server）——不变

中继是**哑管道**：只理解下面几种中继层帧，其余字节原样转发，**不解析 Aide Link**。每个 Host 在中继上有一个稳定的
`device_id`（Host 自己生成并持久化；`hello_ok.host.id` / `paired.device_id` 都是它）。

| 方向 | 帧 | 说明 |
|---|---|---|
| 手机 → 中继 | `{"type":"connect","code":"123456"}` | 首次配对：用 Host 上显示的配对码寻址 Host |
| 手机 → 中继 | `{"type":"connect","device_id":"…","token":"…"}` | 已配对：按 `device_id` 寻址（token 中继不校验，由 Host 校验） |
| 手机 → 中继 | `{"type":"keepalive"}` | 每 ~20s 一次；中继收到首帧后武装 60s 静默超时（消费，不转发）。**仍必须发** |
| 中继 → 手机 | `{"type":"connect_error","reason":"unknown_code"\|"device_offline"\|"superseded"}` | 之后中继关连接。`device_offline` 可退避重试；`superseded` 表示被同一设备的新连接顶替，**不要自动重连**（会互踢） |

`connect` 之后，中继把两端字节桥接起来，**从这一刻起双方说 Aide Link**。完整中继契约见
`relay-server/src/protocol.rs`。

> v1 的传输适配器只有中继。协议本身与传输无关（会话状态机只吃「一条文本消息」），将来加直连（局域网 /
> Tailscale 的 `ws://host:port`）只是多一个适配器，帧不变。

### 2.3 明文说明（务必知道）

v1 **没有端到端加密**：中继是哑管道但能看到明文帧。请把中继部署在 `wss://`（TLS 终结在你信任的反向代理），或自托管中继。
端到端加密（Noise 之类）是协议的可演进点——经 `hello.versions` 协商 v2 引入，不破坏 v1。

## 3. 连接生命周期

```
手机                                   Host
 │── relay: connect ─────────────────────▶│  （中继层，§2.2）
 │── hello{versions} ────────────────────▶│
 │◀─────────────────── hello_ok{version,host,auth,limits}
 │── pair{code} ──── 或 ──── auth{token} ─▶│
 │◀──────────────── paired{device_id,token,granted} / authed{granted}
 │── subscribe{sessions,since} ──────────▶│
 │◀────────────────────── subscribed{epoch,seq,resumed,gap,replayed}
 │◀──────────────────────────── event{seq,name,payload} …（回放，然后实时）
 │── call{id,method,params} ─────────────▶│
 │◀────────────────────────── result{id,value} / error{id,code,message}
 │◀── ping{n} ──▶ pong{n}    （双向，§4.5）
 │◀────────────────────────────── bye{code,message}   （Host 终止；之后关连接）
```

阶段规则（Host 强制）：

| 阶段 | 允许的客户端帧 | 违规时 |
|---|---|---|
| 新连接 | 只有 `hello` | 其他任何帧 / 乱码 → `bye{protocol_error}` |
| 已 hello | `pair` `auth` `ping` `pong` | `call` → `error{unauthenticated}`；`subscribe` → 同 |
| 已认证 | `call` `subscribe` `unsubscribe` `ping` `pong` | 再发 `pair` / `auth` / `hello` → `error{invalid_frame}`（连接不断） |

## 4. 帧参考

下列示例都是真实的线上形状（与 `tests/fixtures/` 里的向量一致）。

### 4.1 握手：`hello` / `hello_ok` / `hello_err`

```json
→ {"type":"hello","versions":[1],"client":{"name":"aide-pwa","version":"0.8.0","platform":"web"}}
← {"type":"hello_ok","version":1,
   "host":{"id":"dev-1","name":"devbox","os":"linux","arch":"x86_64","version":"0.8.0"},
   "auth":["pair","token"],
   "limits":{"max_frame_bytes":8388608,"max_in_flight":64}}
```

- `versions`：客户端会的协议版本；Host 选**交集里最大的**填进 `version`。`client` 可省（给 Host 日志 / 设备列表用）。
- 无交集：`← {"type":"hello_err","code":"unsupported_version","supported":[1]}`，随后 Host 断开。

### 4.2 认证：`pair` / `paired` / `auth` / `authed` / `auth_error`

**首次配对**（手机上输入 Host 上显示的 6 位配对码）：

```json
→ {"type":"pair","code":"123456","device":{"name":"Pixel 9"}}
← {"type":"paired","device_id":"dev-1","token":"<64 位十六进制>",
   "granted":["chat","sessions","workspace","settings","codegraph","automation"]}
```

`token` 长期有效，**客户端必须安全保存** `device_id` + `token`（以后 `connect` 与 `auth` 都要）。配对成功即视为已认证。

**已配对重连**：

```json
→ {"type":"auth","token":"…"}
← {"type":"authed","granted":[…]}
```

**失败**：`← {"type":"auth_error","code":"bad_code"|"expired_code"|"bad_token"|"too_many_attempts","message":"…"}`。
同一连接上认证失败累计 5 次 → `bye{too_many_attempts}`。`bad_token` 的含义是「这个 token 不再有效」（被顶替 / 被撤销）：
客户端应清掉本地凭据、回到「需要重新配对」，**不要无限重试**。

`granted`：授予这台设备的方法组（见 §5）。v1 单设备全授；字段为将来按设备收窄预留，客户端应按它决定 UI 暴露哪些功能。

### 4.3 调用：`call` / `result` / `error`

```json
→ {"type":"call","id":1,"method":"list_sessions","params":{}}
← {"type":"result","id":1,"value":[ … ]}

→ {"type":"call","id":2,"method":"set_model","params":{"sessionId":"s1","model":"nope"}}
← {"type":"error","id":2,"code":"failed","message":"model not found"}
```

- `id`：客户端选的非负整数，**连接内在途唯一**。`params` 缺省 = `{}`；必须是对象。
- **应答无序**：慢调用不堵快调用，按 `id` 对号。同连接在途上限 64（`limits.max_in_flight`），超过立即 `error{busy}`。
- `method` 是 Host 命令名（§5 目录），`params` / `value` 形状与桌面前端 `invoke` 一致（以 `@aide/sdk` 的 api 门面为准）。
- 命令自身的失败 = `error{failed, message}`（`message` 是 Host 给的人话）；`message` 只给人看，**程序按 `code` 分支**。
- 二进制结果包成 `{"$bytes":"<base64>"}`（目录里目前没有返回字节的方法，预留）。
- 协议自己的方法在 `link.` 命名空间：`link.describe`、`link.unpair`（§5.3），不转给 Host 命令表。

`error.code` 见 §9。

### 4.4 事件：`subscribe` / `subscribed` / `event` / `unsubscribe`

**v1 起事件必须订阅才推送**（v2 是认证后无条件全量推送，且只有 `chat-event`）。

```json
→ {"type":"subscribe","sessions":null,"since":{"epoch":"3f2a…","seq":120}}
← {"type":"subscribed","epoch":"3f2a…","seq":128,"resumed":true,"gap":false,"replayed":8}
← {"type":"event","seq":121,"name":"chat-event","payload":{ … }}
   … 回放的 8 条 …
← {"type":"event","seq":129,"name":"chat-event","payload":{ … }}      （之后是实时）
```

- `sessions`：`null` = 全部会话；`["id", …]` = 只收这些会话的 `chat-event`。**不带会话号的事件**（`system-notification`、
  `permissions-changed`）不受过滤、照常收。再发一次 `subscribe` = **替换**订阅（要无缝请带 `since`）。`unsubscribe` 停止推送。
- 顺序保证：`subscribed` → 回放的事件（`seq` 升序）→ 实时事件，**不丢、不重、不乱序**。
- `event.seq`：Host 全局事件序号，在同一 `epoch` 内**单调递增**（过滤后收到的 `seq` 可能不连续，这是正常的）。
  `payload` 是 Host 事件的原样 JSON；`chat-event` 的各 `type` 形状见 `packages/aide-sdk/src/types/chat.ts`（协议层不解释它）。
- 只会收到目录里公开的事件名（§6）。

### 4.5 心跳：`ping` / `pong`

双向、同形：收到 `ping{n}` 回 `pong{n}`。Host 在连接静默 **25 s** 后发 `ping`；**75 s** 没收到客户端任何帧 → `bye{timeout}`。
客户端空闲时也应每 ~20 s 发一次 `ping`（或任意帧）。这是**端到端**的活体，与中继层的 `keepalive`（客户端 → 中继，§2.2）互不替代。

### 4.6 终止：`bye`

Host 主动结束连接前的原因帧，随后关闭：

| `code` | 含义 | 客户端该做什么 |
|---|---|---|
| `superseded` | 另一台设备与这台 Host 配对了（单设备模型） | 清凭据，停在「需要重新配对」；**不要自动重连** |
| `revoked` | 配对被撤销（Host 上撤销 / 本设备 `link.unpair`） | 同上 |
| `timeout` | 静默太久 | 可退避重连 |
| `shutdown` | Host 正在退出 | 可退避重连 |
| `too_large` | 发了超大帧 | 修 bug |
| `protocol_error` | 违反阶段规则 / 乱码 | 修 bug |
| `too_many_attempts` | 本连接认证失败过多 | 检查凭据 |

## 5. 方法目录

### 5.1 机制

`call.method` 必须在目录里，否则 `error{unknown_method}`。目录按**组**归类（组既是文档分类，也是授权粒度）。
目录整张表在 `crates/aide-link/src/catalog.rs`，**读它即可审计远程暴露面**；运行时用 `link.describe` 取（§5.3）——
**客户端应以运行时目录为准**，下表只是 v1 的快照。

收录原则：共享聊天闭包（`@aide/sdk`）被动调用 + 手机 UI 必需。桌面 UI 专属动作（定制项 CRUD、终端、文件写入、git、
打开方式…）不收录。

### 5.2 v1 目录快照

| 组 | 方法 |
|---|---|
| `chat` 聊天控制 | `send_message` `permission_response` `interrupt_session` `stop_chat_session` `stop_bg_task` `set_model` `set_effort` `set_permission_mode` `btw_ask` `get_default_models` `get_default_permission_modes` |
| `sessions` 会话与元数据 | `list_sessions` `list_sessions_for_workspace` `create_session` `delete_session` `rename_session` `auto_rename_session` `load_messages` `session_last_event` `session_model` `session_effort` `session_provider` `session_workspace` `set_session_workspace` `session_identity_drift` `set_session_meta` `session_alive` `list_bg_tasks` |
| `workspace` 工作区 | `list_workspaces` `daily_workspace` `get_active_workspace` `is_workspace_trusted` `trust_workspace` `untrust_workspace` |
| `settings` 设置与供应商 | `get_settings` `set_settings` `get_providers` `set_providers` `get_active_provider_id` `set_active_provider_id` `get_provider_catalog` `refresh_models` `claude_credentials_exist` `load_notifications` `save_notifications` |
| `codegraph` 代码索引 | `codegraph_build_index` `codegraph_build_progress` `codegraph_close` `codegraph_reindex_file` `codegraph_rescan` |
| `automation` 自动化任务 | `list_automations` `get_automation` `create_automation` `update_automation` `delete_automation` `set_automation_enabled` `list_automation_runs` `automation_run_stats` `run_automation_now` `get_automation_playbook` `redistill_automation` |

**远程专属行为**（只此一处，由 Host 在转发前应用）：

- `send_message` 缺 `permissionMode` 时，Host 补上自己的「远程默认权限模式」（Host 设置项）；旧 id `default` 归一化为 `manual`。
  客户端显式给的优先。其余参数原样交给 Host 命令（Host 命令自己校验形状）。

### 5.3 `link.*`

| 方法 | 作用 |
|---|---|
| `link.describe` | 返回机器可读目录：`{"version":1,"groups":[{"id","title","methods":[…]}],"link_methods":[…],"events":[{"name","session_routed"}]}` |
| `link.unpair` | 本设备撤销自己的配对：Host 先回 `result{null}`，随即 `bye{revoked}` 并作废 token |

## 6. 事件目录

| `name` | `session_routed` | 说明 |
|---|---|---|
| `chat-event` | 是（payload 里的 `session_id`） | 会话的全部对话事件（流式 delta、工具调用、权限请求、`user_message`、`session_init`、自动化运行结束…） |
| `system-notification` | 否 | Host 想让用户知道的事 `{title, body}`（手机可自行弹通知） |
| `permissions-changed` | 否 | Host 的权限策略版本号变了 |

### 多端一致性（客户端必须遵守，沿用 Aide 的红线）

桌面、手机共享同一会话：**UI 状态只认事件通道，不认本地乐观更新**。用户气泡只在收到 `user_message` 事件时渲染；
权限请求只认 `permission_request` / `permission_cancelled` 事件；等等——细则见仓库 `CLAUDE.md`「命令 / 事件双通道契约」。

## 7. 重连与续传

客户端保存每台 Host 的 `{device_id, token, epoch, lastSeq}`（`lastSeq` = 收到的最大 `event.seq`）。断线后：

1. 退避重连（1 s → 30 s 封顶，抖动）：打开 WebSocket，发中继 `connect{device_id,token}`（中继 `device_offline` = Host 暂时不在线，继续退避）。
2. `hello` → `hello_ok`。
3. `auth{token}`：`bad_token` → 清凭据、回「需要重新配对」。
4. `subscribe{sessions, since:{epoch, seq:lastSeq}}`。看 `subscribed`：

| `resumed` | `gap` | 含义 | 客户端 |
|---|---|---|---|
| true | false | 原 Host，错过的事件已按序补齐 | 什么都不用做（事件流像没断过） |
| true | true | 原 Host，但断线太久，缓冲已覆盖不到 | 会话还在；**重新拉取状态**（`list_sessions` / `load_messages` / `list_bg_tasks`），然后照常收事件 |
| false | — | Host 重启过（`epoch` 变了），原会话已不在 | 重新拉取全部状态；`lastSeq` 重置为 `subscribed.seq` |

Host 的事件缓冲：最近 16 MiB / 5 万条（先到先止）；Host 进程不重启就不丢历史（会话转录在磁盘上，`load_messages` 总能取到）。
首次订阅（没有 `since`）= 只收之后的实时事件，不回放。

## 8. 配对与安全

- **单设备模型（刻意设计）**：一个 Host 同一时刻只认一个已配对设备。新设备配对成功 = 覆盖旧 token = 旧设备的连接收到
  `bye{superseded}`。这是安全设计不是缺陷——配对码泄露后恶意设备若能静默共存是安全降级；宁可让「后来者顶掉前者」**可见**。
- **配对码**：6 位数字，10 分钟有效，**一次性**（配对成功即作废换新）。同一枚码**错满 5 次即作废换新**（防经中继在线爆破）。
  码由用户在 Host 的设置里查看 / 刷新（Host 窗口里操作的是那台 Host 的网关）。
- **token**：256 位随机，长期有效直至被顶替 / 撤销；Host 常量时间比较。客户端把它当密码对待（系统钥匙串 / 加密存储）。
- **撤销**：Host 设置里「撤销」或设备自己 `link.unpair` → 已连的连接收到 `bye{revoked}`。
- **认证前**只有握手类帧可用；目录之外的方法一律 `unknown_method`，没有任何「调试后门」。
- 明文说明见 §2.3。

## 9. 错误码

封闭集合，客户端按码分支：

| 码 | 出现在 | 含义 |
|---|---|---|
| `unsupported_version` | `hello_err` | 无共同协议版本 |
| `bad_code` / `expired_code` / `too_many_attempts` | `auth_error`、`bye` | 配对码错误 / 过期 / 错误次数过多 |
| `bad_token` | `auth_error` | token 无效（被顶替 / 撤销 / 伪造） |
| `unauthenticated` | `error` | 认证前发了 `call` / `subscribe` |
| `unknown_method` | `error` | 方法不在目录（含不存在的、桌面专属的、`link.` 里没有的） |
| `invalid_frame` | `error` | 帧无法解析 / 未知类型 / 阶段不对（连接不断） |
| `invalid_params` | `error` | `params` 不是对象 |
| `failed` | `error` | Host 命令执行失败（`message` 是原因） |
| `busy` | `error` | 在途调用超过上限 |
| `internal` | `error`、`auth_error` | Host 内部错误 |
| `superseded` `revoked` `shutdown` `timeout` `too_large` `protocol_error` | `bye` | 见 §4.6 |

## 10. 版本与演进

- 协议版本号 = `hello.versions` / `hello_ok.version`，**只在不兼容变更时递增**。
- v1 内允许的兼容扩展：新增帧字段（接收方忽略未知字段）、新增 Host 帧类型（客户端忽略未知类型）、新增目录方法 / 事件 /
  组、新增 `error.code`（客户端对不认识的码按 `failed` 处理）。
- 不兼容（须新版本）：改字段含义、删字段、改阶段规则、改帧语义、引入端到端加密。
- 新增目录方法 = 改 `catalog.rs` + 本文 §5 快照 + 一条一致性向量。

## 11. 一致性向量（手机端自测）

`src-tauri/crates/aide-link/tests/fixtures/*.json`：语言无关的对话脚本（握手 / 配对 / 调用 / 并发 / 事件过滤 / 续传 /
心跳超时 / unpair…共 20+ 条）。格式与步骤种类见该目录的 `README.md`。手机端可以：

- 写一个小执行器（30 行：`send` 发帧、`expect` 子集匹配收到的帧）对着**真实 Host** 跑；
- 或对着自己的 mock Host 跑，保证两边对同一份规约达成一致。

固定值（配对码 `123456`、token `test-token` …）是向量对**测试 Host** 的约定，见 README；真实 Host 的一致性套件会用同一个执行器
（`aide_link::conformance::Harness`）验证自己。

## 12. 与旧协议 v2 的对照（给手机端迁移用）

| v2（`src-tauri/src/remote/protocol.rs`） | Aide Link v1 |
|---|---|
| 无握手，连上即 `pair` / `auth` | 先 `hello` / `hello_ok`（版本协商 + Host 画像 + 限额） |
| `pair{code}` → `pair_ok{device_id,token}` | `pair{code,device}` → `paired{device_id,token,granted}` |
| `auth{token}` → `auth_ok` / `auth_error{message}` | `auth{token}` → `authed{granted}` / `auth_error{code,message}` |
| `invoke{id,command,params}` | `call{id,method,params}` |
| `invoke_ok{id,payload}` / `invoke_err{id,error}` | `result{id,value}` / `error{id,code,message}`（错误有类型化的 `code`） |
| `event{event}`：认证后**无条件**全量推送，只有 chat-event，无序号 | `subscribe` 才推；`event{seq,name,payload}`；可按会话订阅；`since` 续传；`gap` / `resumed` 如实告知 |
| 白名单散在桌面 `rpc.rs` + `handlers.rs` | 一张目录 `catalog.rs`，`link.describe` 在线可查，按组授权 |
| `send_message` 的远程默认权限模式在 handler 里 | 目录里 `prepare` 一处声明 |
| 配对码 10 分钟内可重复使用、可无限试错 | 一次性 + 错 5 次作废 |
| 无应用层心跳（靠中继 keepalive） | `ping` / `pong` 端到端 + 中继 keepalive 仍需 |
| 被顶替 / 撤销：连接静默断开 | `bye{superseded}` / `bye{revoked}` |
| 配对对象 = 桌面 | 配对对象 = Host（一台手机可配对多个 Host，各有 `device_id` / token / epoch） |

迁移建议：先让手机端在 v1 之上实现一个与现有 `AideTransport { invoke, listen }` 同形的适配器
（`invoke → call`、`listen("chat-event") → event`），上层 SDK 不用动。

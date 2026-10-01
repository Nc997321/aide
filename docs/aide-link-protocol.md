# Aide Link 协议（v1）

> 状态：**v1 草案**（2026-09-30）——协议核心（帧 / 安全通道 / 目录 / 配对 / 状态机 / 一致性向量）已在
> `src-tauri/crates/aide-link` 落地并通过测试；Host 侧接入（守护进程里的中继适配器）是下一步（P3b-2）。
> 手机端按本文实现；在手机端迁移完成之前，旧协议 v2（`src-tauri/src/remote/`）原样继续服务现有的 PWA / 鸿蒙端，
> 两者互不影响。
>
> **谁是真相源**：`crates/aide-link/src/frame.rs` + `secure.rs`（帧与握手）、`catalog.rs`（暴露目录）、
> `tests/fixtures/`（对话向量 + 逐字节密码学向量）。本文是它们的叙述版；冲突时以代码和向量为准，并请把本文改对。
> TypeScript 类型见 [`docs/aide-link/frames.d.ts`](aide-link/frames.d.ts)（与 Rust 同步，有测试守着）。

## 1. 它解决什么

手机要用 Aide 的会话 / agent，而 agent 跑在 **Host**（本机、WSL、SSH 服务器——见 [host-model.md](host-model.md)）上。
Aide Link 是**手机 ↔ Host** 之间的一条协议化通道：

- **直连 Host，不经桌面**：每个 Host（常驻守护进程）自己持有网关，手机配对的对象是 Host，不是某台桌面。
  桌面关了，Host 上的会话照常在，手机照常连。
- **端到端加密，中继不被信任**：帧在中继上只以密文出现；配对靠**扫二维码**，之后手机的密钥就是凭据，没有可被偷走的 token。
- **协议，不是补丁**：安全通道 / 版本协商 / 调用 / 订阅 / 续传 / 心跳 / 终止都有明确的帧；能调什么、能收什么由**一张可审计的
  目录**决定（且可经 `link.describe` 在线查询）。
- **一张命令表，多个前门**：`call` 的方法名就是 Host 命令表里的命令名，参数 / 结果形状与桌面前端 `invoke` 完全一致。
  Aide Link 只是命令表的又一扇前门，不另造一套命令。

## 2. 分层与传输

```
┌────────────────────────────────────────────────────┐
│ Link 帧：hello / call / subscribe / event …（§6）    │  ← 内层，明文 JSON，被加密承载
├────────────────────────────────────────────────────┤
│ 安全通道（§4）：sc_init / sc_resp / sc_err / sc      │  ← Noise 握手 + 加密数据，外层 JSON 中继可见但不可读
├────────────────────────────────────────────────────┤
│ 中继层帧：connect / keepalive / connect_error（§2.2） │  ← relay-server，只认这几种
├────────────────────────────────────────────────────┤
│ WebSocket 文本消息，每条 = 一个 JSON 对象              │
└────────────────────────────────────────────────────┘
```

### 2.1 通用规则

- 一条 WebSocket **文本**消息 = 一帧 = 一个 JSON 对象，`type` 字段区分种类（snake_case）。不用二进制消息。
- 帧自身的字段 snake_case；`params` / `payload` / `value` 里是 Host 命令的原样 JSON（camelCase，与桌面前端一致）。
- **接收方忽略未知字段**。客户端忽略未知的 Host 帧类型；Host 对未知的客户端 Link 帧类型回 `error{invalid_frame}`。
- 一个 Link 帧上限 **8 MiB**（`limits.max_frame_bytes`）；一条外层文本消息上限 128 KiB（一块密文 base64 后约 44 KiB）。
- 编码 UTF-8。数字是 JSON 数字；`id` / `seq` / `n` 都是非负整数（`< 2^53`，JS 安全）。

### 2.2 中继（relay-server）

中继是**哑管道**：只理解下面几种中继层帧，其余字节原样转发，**不解析、也解不开**后面的内容。每个 Host 在中继上有一个稳定的
`device_id`（128 位随机，32 位十六进制；Host 自己生成并持久化，**不可猜**）。

| 方向 | 帧 | 说明 |
|---|---|---|
| 手机 → 中继 | `{"type":"connect","device_id":"…"}` | 按 `device_id` 寻址 Host（配对时它来自二维码，之后手机自己存着） |
| 手机 → 中继 | `{"type":"keepalive"}` | 每 ~20 s 一次；中继收到首帧后武装 60 s 静默超时（消费，不转发）。**仍必须发** |
| 中继 → 手机 | `{"type":"connect_error","reason":"device_offline"\|"superseded"\|"unknown_code"}` | 之后中继关连接。`device_offline` 可退避重试；`superseded` = 被同一设备的新连接顶替，**不要自动重连**（会互踢） |

`connect` 之后，中继把两端字节桥接起来，**从这一刻起双方说安全通道（§4）**。

> **与旧协议 v2 的差别**：v2 用 6 位配对码路由（`connect{code}`），码既是路由键又是密钥——短、会撞、可被在线爆破，
> 也让中继知道了配对码。v1 **只按 `device_id` 路由**，配对密钥在二维码里、永不上线；中继不再需要（也不该再有）码路由。
> Host 向中继注册时不再带配对码（中继的 `register` 将把 `pairing_code` 改为可选，属 P3b-2 的基础设施改动）。
> 建议中继对 `connect` 的失败按来源 IP 限速，作为多一层防护（`device_id` 不可猜，所以这只是纵深防御）。

> v1 的传输适配器只有中继。协议本身与传输无关（安全通道只吃「一条文本消息」），将来加直连（局域网 / Tailscale 的
> `ws://host:port`）只是多一个适配器，帧不变。

### 2.3 安全模型（务必读）

| 威胁 | v1 的结果 |
|---|---|
| 中继被攻破 / 运营者作恶 | 只能看到密文、长度与时间；**伪造不了帧**（每块密文带认证标签，Host / 手机公钥已互相认证）；能做的是丢弃 / 延迟（拒绝服务）。 |
| 二维码被拍下 | 一次性（用掉即作废）、10 分钟过期。窃取者抢先扫了，真正的手机会**配对失败**（可见）；配对后二维码毫无价值。 |
| 有人持续向中继试探 | `device_id` 128 位不可猜；没有配对码可爆破；握手需要 Host 公钥对应的私钥 / 已配对的手机私钥。 |
| 手机丢了 | 在 Host 设置里「撤销」，或配对另一台手机（单设备模型会顶掉旧的）。 |
| 重放 / 乱序 | 每个方向严格递增的 nonce，WebSocket 有序；重放 / 乱序 / 篡改都解密失败，连接即断。 |
| 降级 | v1 只有一个版本。`sc_init.versions` 在握手外层、不被认证——将来引入新版本时，新版本的 prologue 标签（`aide-link/<v>:`）会绑定版本，降级会导致握手失败。 |

前向保密：握手含临时密钥交换（`ee`），事后泄露静态私钥不能解开已录下的通话。

## 3. 配对：扫二维码

### 3.1 二维码里是什么

Host 设置里点「配对手机」，Host 生成一次性配对 offer 并显示二维码，内容是一个 URI：

```
aide-link://pair?v=1&relay=wss%3A%2F%2Frelay.example.com%2F&id=00112233445566778899aabbccddeeff
               &pk=<Host 公钥 base64url>&psk=<一次性密钥 base64url>&n=<Host 名>&exp=<过期 unix 秒>
```

| 键 | 含义 |
|---|---|
| `v` | 配对 URI 版本，目前恒为 `1`（不认识的版本：提示用户升级 App） |
| `relay` | 要连的中继地址（URL 编码） |
| `id` | Host 的 `device_id`（32 位十六进制） |
| `pk` | Host 的 X25519 静态公钥（32 字节，base64url 无填充，43 字符）——**手机据此认 Host，没有中间人** |
| `psk` | 一次性密钥（32 字节，base64url，43 字符）——**只在这个二维码里，永不经过网络** |
| `n` | Host 的显示名（给手机 UI 用，可缺省） |
| `exp` | 过期时刻（unix 秒；Host 自己也强制 10 分钟过期，这个值给 UI 倒计时） |

接收方**忽略未知键**。整串约 220 字符，QR 码轻松装下。**`psk` 是秘密：不要存、不要写日志。**

### 3.2 配对流程

1. 手机扫码，解析 URI；若是第一次配对，生成自己的 **X25519 静态密钥对**（私钥放系统安全存储；公钥就是它在这台 Host
   上的身份）。
2. 连中继（`connect{device_id: id}`），发 `sc_init{mode:"pair"}`（§4），完成握手——握手用 `psk` 做 Noise 的 psk，
   用 `pk` 当 Host 公钥。**psk 不对 / 连到的不是二维码里那台 Host，握手在手机读到 `sc_resp` 时就会失败**。
3. 握手完成后，手机发第一个 Link 帧 `hello`。**Host 收到这个有效帧才真正记下手机的公钥**（配对确认）：二维码作废，手机公钥
   写入 Host；若之前配对过另一台手机，那台的连接收到 `bye{superseded}`。
4. 手机收到 `hello_ok` = 配对成功：此时再把 `{device_id, Host 公钥, 自己的密钥对, relay, 名字}` 持久化。

之后每次连接用 `resume`（§4.2）：不再需要二维码、不再需要任何口令——**手机的静态私钥就是凭据**。

### 3.3 单设备模型（刻意设计，改动前先确认）

一个 Host 同一时刻只认**一把**手机公钥。新手机配对成功 = 覆盖旧公钥 = 旧手机被踢（`bye{superseded}`，且它之后 `resume`
会得到 `sc_err{unauthorized}`）。这是安全设计不是缺陷——二维码泄露后恶意设备若能静默共存是安全降级；宁可让「后来者顶掉
前者」**可见**。同一台手机重新扫码不算顶替。握手失败**不会烧掉**二维码（否则知道 `device_id` 的人可以反复发垃圾握手把它
烧掉）。撤销：Host 设置里「撤销」，或手机调 `link.unpair`（§7.3）。

## 4. 安全通道

### 4.1 外层帧

| 帧 | 方向 | 含义 |
|---|---|---|
| `sc_init` | 手机 → Host | 发起握手：`{"type":"sc_init","versions":[1],"mode":"pair"\|"resume","msg":"<Noise 第一条消息，标准 base64>"}` |
| `sc_resp` | Host → 手机 | `{"type":"sc_resp","version":1,"msg":"<Noise 第二条消息>"}`；`version` 是选定的协议版本（`versions` 与 Host 支持的交集里最大的） |
| `sc_err` | Host → 手机 | `{"type":"sc_err","code":"…","message":"…"}`，握手被拒，随后 Host 断开 |
| `sc` | 双向 | `{"type":"sc","c":"<一块密文，标准 base64>","last":true}`：承载内层 Link 帧 |

握手阶段 Host 的拒绝原因（`sc_err.code`）：`unsupported_version`（无共同版本）、`unauthorized`（`resume` 的手机公钥不是已配对的
那把）、`no_pairing_offer`（`pair` 但 Host 当前没有有效二维码）、`bad_handshake`（消息无法解析 / 认证失败）、
`protocol_error`（第一帧不是 `sc_init` / 乱码）、`timeout`（握手 15 s 内没完成）、`too_large`。

### 4.2 握手（Noise）

手机是发起方，Host 是响应方；手机事先知道 Host 的静态公钥。

| `mode` | Noise 协议名 | 场景 |
|---|---|---|
| `pair` | `Noise_IKpsk2_25519_ChaChaPoly_SHA256` | 首次配对；psk = 二维码里的 `psk`（32 字节原始值，`psk` 位置 2） |
| `resume` | `Noise_IK_25519_ChaChaPoly_SHA256` | 之后每次重连 |

- **prologue** = UTF-8 字节 `aide-link/1:` + Host 的 `device_id`（小写十六进制 32 字符）。它把通道绑到这台 Host 和协议版本上。
- 两条握手消息的 **payload 都为空**。第一条（手机 → Host，放在 `sc_init.msg`）是 `e ‖ ENC(s) ‖ ENC(空)` = **96 字节**；
  第二条（Host → 手机，放在 `sc_resp.msg`）是 `e ‖ ENC(空)` = **48 字节**。
- `resume` 时 Host 读完第一条消息、拿到手机静态公钥后，**先**核对它是不是已配对的那把，不是就 `sc_err{unauthorized}`，不回第二条。
- `pair` 时 Host 读第一条、回第二条，然后进入「待确认」：**等手机用握手派生的密钥发来第一个有效的 `sc` 帧**才提交配对
  （手机若 psk 不对，在读第二条时就失败，永远发不出有效帧，Host 因此不会被骗去配对）。
- 手机若读第二条失败：psk 不对 / 连错了 Host（公钥或 `device_id` 不符）——提示用户重新扫码。

**逐字节向量**：[`crates/aide-link/tests/fixtures/noise_vectors.json`](../src-tauri/crates/aide-link/tests/fixtures/noise_vectors.json)
给出两种模式下固定的密钥与临时密钥、握手两条消息的十六进制与 base64、以及传输态第一块密文——你的 Noise 实现必须对同样输入
产出同样的字节。库的选择：X25519 + ChaCha20-Poly1305 + SHA-256 是 Noise 的标准套件；TypeScript 有现成实现
（`noise-handshake`、`@noble/curves` + `@noble/ciphers` + `@noble/hashes`）。鸿蒙 ArkTS 可用系统 `cryptoFramework` 或纯 TS
的 noble 系列移植（以实际 API 级别为准）。

### 4.3 传输态

握手完成后双方进入传输态：

- 加密：ChaCha20-Poly1305，nonce = 4 个零字节 ‖ 64 位小端计数器，无附加数据；**每个方向各一个计数器，从 0 起，
  每块密文加一**。WebSocket 有序，所以丢失 / 重放 / 乱序都会解密失败——解密失败 = 通道不可信，立即断开。
- **分块**：一个 Link 帧的明文（JSON UTF-8）按 **32768 字节**切块，逐块加密成 `sc` 帧，**末块 `last:true`**，其余
  `last:false`；明文为空也发一块（`last:true`）。接收方把各块明文按序拼接，`last:true` 时得到完整的 Link 帧。
  重组后上限 8 MiB，超过即断开。

## 5. 连接生命周期

```
手机                                         Host
 │── relay: connect{device_id} ───────────────▶│  （中继层，§2.2）
 │── sc_init{versions,mode,msg} ──────────────▶│
 │◀─────────────────────── sc_resp{version,msg}  或  sc_err{code}
 │══ 此后全部是 sc 帧（加密）══════════════════════│
 │── hello{client} ───────────────────────────▶│   （pair 模式下，它同时是配对确认）
 │◀──────────────────────── hello_ok{version,host,granted,limits}
 │── subscribe{sessions,since} ───────────────▶│
 │◀───────────────── subscribed{epoch,seq,resumed,gap,replayed}
 │◀───────────────────────── event{seq,name,payload} …（回放，然后实时）
 │── call{id,method,params} ──────────────────▶│
 │◀────────────────────────── result{id,value} / error{id,code,message}
 │◀── ping{n} ──▶ pong{n}    （双向，§6.4）
 │◀────────────────────────────────── bye{code,message}   （Host 终止；之后关连接）
```

阶段规则（Host 强制）：

| 阶段 | 允许的帧 | 违规时 |
|---|---|---|
| 新连接 | 只有 `sc_init` | 其他任何帧 / 乱码 → `sc_err{protocol_error}` |
| 握手完成、未 `hello` | 只有 `hello` | 其他 → `bye{protocol_error}` |
| 已 `hello` | `call` `subscribe` `unsubscribe` `ping` `pong` | 再发 `hello` → `error{invalid_frame}`（连接不断） |

## 6. Link 帧参考

以下都是**内层**帧（经 `sc` 加密承载）。示例是真实的线上形状（与 `tests/fixtures/` 里的向量一致）。

### 6.1 `hello` / `hello_ok`

```json
→ {"type":"hello","client":{"name":"aide-pwa","version":"0.8.0","platform":"web"}}
← {"type":"hello_ok","version":1,
   "host":{"id":"00112233445566778899aabbccddeeff","name":"devbox","os":"linux","arch":"x86_64","version":"0.8.0"},
   "granted":["chat","sessions","workspace","settings","codegraph","automation"],
   "limits":{"max_frame_bytes":8388608,"max_in_flight":64}}
```

- `client` 可省（给 Host 日志 / 设备列表用）。协议版本在 `sc_init` 已协商，`hello_ok.version` 是结果。
- `granted`：授予这台设备的方法组（§7）。v1 单设备全授；字段为将来按设备收窄预留，客户端应按它决定 UI 暴露哪些功能。

### 6.2 `call` / `result` / `error`

```json
→ {"type":"call","id":1,"method":"list_sessions","params":{}}
← {"type":"result","id":1,"value":[ … ]}

→ {"type":"call","id":2,"method":"set_model","params":{"sessionId":"s1","model":"nope"}}
← {"type":"error","id":2,"code":"failed","message":"model not found"}
```

- `id`：客户端选的非负整数，**连接内在途唯一**。`params` 缺省 = `{}`；必须是对象（否则 `error{invalid_params}`）。
- **应答无序**：慢调用不堵快调用，按 `id` 对号。同连接在途上限 64（`limits.max_in_flight`），超过立即 `error{busy}`。
- `method` 是 Host 命令名（§7 目录），`params` / `value` 形状与桌面前端 `invoke` 一致（以 `@aide/sdk` 的 api 门面为准）。
- 命令自身的失败 = `error{failed, message}`（`message` 是 Host 给的人话）；`message` 只给人看，**程序按 `code` 分支**。
- 二进制结果包成 `{"$bytes":"<base64>"}`（目录里目前没有返回字节的方法，预留）。
- 协议自己的方法在 `link.` 命名空间：`link.describe`、`link.unpair`（§7.3），不转给 Host 命令表。

### 6.3 `subscribe` / `subscribed` / `event` / `unsubscribe`

**事件必须订阅才推送**（v2 是认证后无条件全量推送，且只有 `chat-event`）。

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
- 只会收到目录里公开的事件名（§8）。

### 6.4 `ping` / `pong`

双向、同形：收到 `ping{n}` 回 `pong{n}`。Host 在连接静默 **25 s** 后发 `ping`；**75 s** 没收到客户端任何帧 → `bye{timeout}`。
客户端空闲时也应每 ~20 s 发一次 `ping`（或任意帧）。这是**端到端**的活体，与中继层的 `keepalive`（客户端 → 中继，§2.2）互不替代。

### 6.5 `bye`

Host 主动结束连接前的原因帧（加密的 Link 帧），随后关闭：

| `code` | 含义 | 客户端该做什么 |
|---|---|---|
| `superseded` | 另一台设备与这台 Host 配对了（单设备模型） | 清凭据，停在「需要重新配对」；**不要自动重连** |
| `revoked` | 配对被撤销（Host 上撤销 / 本设备 `link.unpair`） | 同上 |
| `timeout` | 静默太久 | 可退避重连 |
| `shutdown` | Host 正在退出 | 可退避重连 |
| `too_large` | 发了超大帧 | 修 bug |
| `protocol_error` | 违反阶段规则 / 乱码 | 修 bug |

## 7. 方法目录

### 7.1 机制

`call.method` 必须在目录里，否则 `error{unknown_method}`。目录按**组**归类（组既是文档分类，也是授权粒度）。
目录整张表在 `crates/aide-link/src/catalog.rs`，**读它即可审计远程暴露面**；运行时用 `link.describe` 取（§7.3）——
**客户端应以运行时目录为准**，下表只是 v1 的快照。

收录原则：共享聊天闭包（`@aide/sdk`）被动调用 + 手机 UI 必需。桌面 UI 专属动作（定制项 CRUD、终端、文件写入、git、
打开方式…）不收录。

### 7.2 v1 目录快照

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

### 7.3 `link.*`

| 方法 | 作用 |
|---|---|
| `link.describe` | 返回机器可读目录：`{"version":1,"groups":[{"id","title","methods":[…]}],"link_methods":[…],"events":[{"name","session_routed"}]}` |
| `link.unpair` | 本设备撤销自己的配对：Host 先回 `result{null}`，随即 `bye{revoked}` 并作废这把手机公钥 |

## 8. 事件目录

| `name` | `session_routed` | 说明 |
|---|---|---|
| `chat-event` | 是（payload 里的 `session_id`） | 会话的全部对话事件（流式 delta、工具调用、权限请求、`user_message`、`session_init`、自动化运行结束…） |
| `system-notification` | 否 | Host 想让用户知道的事 `{title, body}`（手机可自行弹通知） |
| `permissions-changed` | 否 | Host 的权限策略版本号变了 |

### 多端一致性（客户端必须遵守，沿用 Aide 的红线）

桌面、手机共享同一会话：**UI 状态只认事件通道，不认本地乐观更新**。用户气泡只在收到 `user_message` 事件时渲染；
权限请求只认 `permission_request` / `permission_cancelled` 事件；等等——细则见仓库 `CLAUDE.md`「命令 / 事件双通道契约」。

## 9. 重连与续传

客户端保存每台 Host 的 `{device_id, Host 公钥, 自己的密钥对, relay, epoch, lastSeq}`（`lastSeq` = 收到的最大 `event.seq`）。断线后：

1. 退避重连（1 s → 30 s 封顶，加抖动）：打开 WebSocket，发中继 `connect{device_id}`（中继 `device_offline` = Host 暂时不在线，继续退避）。
2. `sc_init{mode:"resume"}` 握手。`sc_err{unauthorized}` = 已被顶替 / 撤销：清凭据、回「需要重新配对」，**不要重试**。
3. `hello` → `hello_ok`。
4. `subscribe{sessions, since:{epoch, seq:lastSeq}}`。看 `subscribed`：

| `resumed` | `gap` | 含义 | 客户端 |
|---|---|---|---|
| true | false | 原 Host，错过的事件已按序补齐 | 什么都不用做（事件流像没断过） |
| true | true | 原 Host，但断线太久，缓冲已覆盖不到 | 会话还在；**重新拉取状态**（`list_sessions` / `load_messages` / `list_bg_tasks`），然后照常收事件 |
| false | — | Host 重启过（`epoch` 变了），原会话已不在 | 重新拉取全部状态；`lastSeq` 重置为 `subscribed.seq` |

Host 的事件缓冲：最近 16 MiB / 5 万条（先到先止）；Host 进程不重启就不丢历史（会话转录在磁盘上，`load_messages` 总能取到）。
首次订阅（没有 `since`）= 只收之后的实时事件，不回放。

## 10. 错误码

封闭集合，客户端按码分支：

| 码 | 出现在 | 含义 |
|---|---|---|
| `unsupported_version` | `sc_err` | 无共同协议版本 |
| `unauthorized` | `sc_err` | `resume` 的手机公钥不是已配对的那把（含被顶替 / 被撤销之后） |
| `no_pairing_offer` | `sc_err` | `pair` 但 Host 当前没有有效二维码（过期 / 已被用掉 / 没生成） |
| `bad_handshake` | `sc_err` | 握手消息无法解析 / 认证失败 / 通道密文不可信 |
| `unauthenticated` | `error` | 预留（v1 中认证发生在握手层，不会出现） |
| `unknown_method` | `error` | 方法不在目录（含不存在的、桌面专属的、`link.` 里没有的） |
| `invalid_frame` | `error` | 帧无法解析 / 未知类型 / 阶段不对（连接不断） |
| `invalid_params` | `error` | `params` 不是对象 |
| `failed` | `error` | Host 命令执行失败（`message` 是原因） |
| `busy` | `error` | 在途调用超过上限 |
| `internal` | `error`、`sc_err` | Host 内部错误 |
| `superseded` `revoked` `shutdown` `timeout` `too_large` `protocol_error` | `bye` / `sc_err` | 见 §6.5 / §4.1 |

## 11. 版本与演进

- 协议版本号 = `sc_init.versions` / `sc_resp.version`，**只在不兼容变更时递增**；新版本的 prologue 标签随之变化。
- v1 内允许的兼容扩展：新增帧字段（接收方忽略未知字段）、新增 Host 帧类型（客户端忽略未知类型）、新增目录方法 / 事件 /
  组、新增 `error.code`（客户端对不认识的码按 `failed` 处理）、配对 URI 新增键。
- 不兼容（须新版本）：改字段含义、删字段、改阶段规则、改握手 / 加密 / 分块格式、改 prologue。
- 新增目录方法 = 改 `catalog.rs` + 本文 §7 快照 + 一条一致性向量。

## 12. 一致性向量（手机端自测）

两类，都在 `src-tauri/crates/aide-link/tests/fixtures/`：

- **对话向量** `01_*.json … 04_*.json`：语言无关的对话脚本（安全通道 / 配对（含顶替、撤销、二维码一次性）/ 调用 / 并发 /
  事件过滤 / 续传 / 心跳超时…共 28 条）。格式与步骤种类见该目录的 `README.md`。手机端可以写一个小执行器对着**测试 Host**
  跑，保证两边对同一份规约达成一致。
- **密码学向量** `noise_vectors.json`：逐字节（§4.2）。

向量约定的固定身份（Host 的密钥、手机 A / B 的密钥、一次性密钥）见 README；参考实现（Rust，手机一侧的握手 + 加密传输）在
`crates/aide-link/src/client.rs`，移植时可对照。真实 Host 的一致性套件会用同一个执行器
（`aide_link::conformance::Harness`）验证自己。

## 13. 与旧协议 v2 的对照（给手机端迁移用）

| v2（`src-tauri/src/remote/protocol.rs`） | Aide Link v1 |
|---|---|
| 明文，中继可读全部内容与 token | 端到端加密（Noise），中继只见密文 |
| 6 位配对码：路由键 + 密钥合一，可撞可爆破 | 扫二维码：`device_id`（路由，不可猜）+ Host 公钥 + 一次性密钥（永不上线） |
| 长期 token（明文上线，可被中继偷走） | 无 token：手机的静态私钥就是凭据 |
| 无握手，连上即 `pair` / `auth` | `sc_init` / `sc_resp`（Noise）+ 版本协商，然后 `hello` / `hello_ok` |
| `invoke{id,command,params}` | `call{id,method,params}` |
| `invoke_ok{id,payload}` / `invoke_err{id,error}` | `result{id,value}` / `error{id,code,message}`（错误有类型化的 `code`） |
| `event{event}`：认证后**无条件**全量推送，只有 chat-event，无序号 | `subscribe` 才推；`event{seq,name,payload}`；可按会话订阅；`since` 续传；`gap` / `resumed` 如实告知 |
| 白名单散在桌面 `rpc.rs` + `handlers.rs` | 一张目录 `catalog.rs`，`link.describe` 在线可查，按组授权 |
| `send_message` 的远程默认权限模式在 handler 里 | 目录里 `prepare` 一处声明 |
| 无应用层心跳（靠中继 keepalive） | `ping` / `pong` 端到端 + 中继 keepalive 仍需 |
| 被顶替 / 撤销：连接静默断开 | `bye{superseded}` / `bye{revoked}`；重连得 `sc_err{unauthorized}` |
| 配对对象 = 桌面 | 配对对象 = Host（一台手机可配对多个 Host，各有自己的 `device_id` / Host 公钥 / epoch） |

迁移建议：先让手机端在 v1 之上实现一个与现有 `AideTransport { invoke, listen }` 同形的适配器
（`invoke → call`、`listen("chat-event") → event`），上层 SDK 不用动。

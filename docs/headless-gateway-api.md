# Aide Headless 引擎 API 对接文档

| 项 | 值 |
|---|---|
| 适用协议版本 | `PROTOCOL_VERSION = 2` |
| 适用引擎版本 | `agent-sidecar` @ `05c024a` 及以后（含 F3/F4 修复轮） |
| 文档版本 | 1.3（2026-09-15） |
| 读者 | 把 Aide headless 引擎当编排大脑的宿主网关实现方 |
| 真相源 | `agent-sidecar/src/headless-schema.ts`（命令字段）· `engine/types.ts`（事件字段）· `headless-server.ts`（HTTP/SSE 层）· `src/index.ts`（启动面） |
| 验收底稿 | `docs/headless-test-checklist.md`（本文件每条实测断言都可回溯到该清单的 A/B/C/D 组用例与 F1–F11 发现） |

**本文的写法约定**：每条来自实测的断言在末尾用 `〔清单 F1〕` / `〔清单 A20〕` 形式标注底稿出处。`〔清单〕` 标注不是引用装饰——它表示这条结论有可复跑的实测证据，出处编号在附录 B 有对照表。

## 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-14 | 1.0 | 首版定稿。合并 2026-09-11 的对接说明草稿与测试清单的文档级处置项，全量补齐 10 条命令与 44 个事件类型（42 个 headless 可达 + 2 个桌面专用）的字段级参考。 |
| 2026-09-14 | 1.1 | btw 侧问接入：新增命令 `btw_ask`（§4.12）与事件 `btw_answer`（§5.2）；**从 send schema 剥除 `btw` / `lightweight` / `fork_from` / `tools` 四个桌面字段**（原「明令禁发」改为 schema 层直接拒绝，清单 B14 结案）。事件总数 44 → 45，命令总数 10 → 11。**`PROTOCOL_VERSION` 1 → 2**（命令面不兼容变更，按 §1.2 判据必须递增）。 |
| 2026-09-15 | 1.2 | `permission_response` 增**标签形态**（§4.2，官方推荐）：`response:{kind}` 四变体 `approve` / `answer` / `deny` / `unanswered`，与扁平形态**互斥**（恰好一个在场）。新增 `unanswered` 语义 = 无人应答（确认超时等），模型侧走官方「无人工审批可用」外框（自带"不要重试"）；`deny` 仍走人工外框。新增类别校验与 `fatal:false` 报错臂。**`PROTOCOL_VERSION` 保持 2**——纯增量（新形态是可选字段，扁平形态语义零变化，旧客户端不受影响）。 |
| 2026-09-15 | 1.3 | `send.images` 增**本地路径形态** `{path}`（§4.1）：引擎自己读文件，绕开 1MB body 上限——手机原图经 base64 后 2.7~5.3MB，此前根本进不来。两种形态互斥；路径形态**不需要 mediaType**（引擎按魔数嗅探），并带读入上限 20MB/张与非图片拒收两道守卫。既有内嵌形态零改动。**`PROTOCOL_VERSION` 保持 2**（纯增量）。另记 §9.3 第 11 条：图片失败的可见性缺口（`terminal_reason`/`image_error` 未接），待真模型实测后落地。 |

---

## 0. 先读：对接规程（11 条）

网关实现方在写第一行代码前读完本节。这些是实测钉死的语义，每一条踩中都是静默故障。

1. **re-key，且必须幂等。** 收到 `session_init` 事件后，命令键与订阅键**立即**换成事件里的 SDK 真 id（`event.session_id`）。拿旧 client sid 续发 = 静默新建一个全新会话，上一轮上下文全丢，**没有任何报错**。注意 `session_init` **每轮都会重发**（同一 id），所以 re-key 处理必须幂等：id 没变就不动键。**会话重启的唯一判据是 init id 变了**，不是 init 计数。〔清单 B1 / F10〕

2. **发给不存在会话的命令会被静默吞掉，但返回 200。** 除 `send` 和 `session_stop` 外，所有命令都要先按 `session_id` 找到活着的会话；找不到（已停止、从未创建、或 id 拼错）就地丢弃且**不报错**，HTTP 层照常回 `200 {"ok":true}`。〔清单 A15〕

3. **SSE 无回放。** 断开期间的事件永久丢失，重连只补一帧 `hello`。网关必须自行容忍断流，或在自己的状态里做补偿。〔清单 A11〕

4. **SSE 必须勤读。** 写路径没有任何熔断或降级：`res.write` 返回 false（内核缓冲满）时服务端只当写成功。慢消费 = 引擎侧内存线性累积，治理责任完全在网关。实测 10×500KB 灌入一个暂停读取的连接，RSS 涨 5.2MB、恢复读取后零丢帧。〔清单 A20〕

5. **token 轮换三句。** ① 存活的 query 续轮**永不换头**——MCP 头的注入时机是 `query()` 启动那一刻；② 要轮换就 `session_stop` 然后用 `resume_session_id` + 新的 `mcp_headers` 重发；③ error 终态之后的下一条 `send` 会**自动**以 resume 重启重连，带上最新头。〔清单 C4 / D3 / F3〕

6. **引擎无持久化。** 会话是内存态。runtime 崩溃或重启 = 所有会话全丢，`resume_session_id` 是唯一续接通道（CLI 侧转录还在就能接上）。〔清单 D5 / B11〕

7. **故障可见性很慢。** 模型端点不可达时，`error` 帧最长约 **189 秒**才到（CLI 内部重试梯度）。90 秒窗口里必然一条都没有。网关必须自备轮次超时，超时后用 `interrupt` 驱动终态。〔清单 F2〕

8. **Windows 上没有优雅关停。** `kill` 在 Windows 等价于强制终止：`SIGTERM` 处理器不执行、退出码非 0、SSE 收到的是 RST 而非干净的 done。Windows 上部署网关必须自带孤儿 `claude.exe` 清理（按父 PID 差集算）。〔清单 F1〕

9. **权限模式别裸依赖 auto。** 第三方 provider 下 CLI 内置的 auto 分类器不稳定：单步分类延迟 48–154 秒、stage-2 报错时 fail-closed 误拒良性命令。长驻会话按 §6 三选一（规则前置 / manual / bypassPermissions）。〔清单 F9〕

10. **body 上限 1MB，且超限响应形态对 fetch 客户端不友好。** 超限时服务端先回 400，再因请求体未读尽 RST 连接；用 `fetch` 会抛 `ECONNRESET` 而拿不到状态码（裸 `http.request` 可以）。网关侧先自我限界，或按「以首响应为准」处理。**大图不要走 body**——`send.images` 的路径形态（§4.1）让引擎自己去读本地文件，路径字符串几十字节，绕开这道闸。另：`env` / `metadata` / `mcp_headers` 的值是凭据，引擎保证不落日志、不进 Bash 子进程 env，网关侧同样不要记。〔清单 F5 / C7 / C8〕

11. **桌面字段不接。** `automation` 是桌面/调度器语义，网关不要发——它会让引擎按无人值守白名单执行，行为与网关预期不符。〔清单 F8〕此前放行的 `btw` / `lightweight` / `fork_from` / `tools` 已在 1.1 版从 schema 剥除：现在发它们会得到 `400 invalid invoke body`（不再是「收下但按桌面语义执行」）。侧问走专用命令 `btw_ask`（§4.12）。〔清单 B14 结案〕

---

## 1. 部署与启动

### 1.1 启动

```bash
node dist/runtime.js headless
```

只读两个环境变量：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AIDE_HEADLESS_PORT` | `18090` | 监听端口 |
| `AIDE_HEADLESS_TOKEN` | 无 | 设了则 `/invoke` 与 `/events` 全部要求 `Authorization: Bearer <token>` |

网关形态推荐同时设置隔离配置根，让引擎读专属的 MCP server 表而不碰用户桌面配置：

```bash
AIDE_HEADLESS_TOKEN=<secret> \
CLAUDE_CONFIG_DIR=<专属配置目录> \
node dist/runtime.js headless
```

### 1.2 启动成功标志

stdout 输出一行 JSON：

```json
{"type":"headless-listening","port":18090,"protocol":2}
```

`protocol` 字段是版本握手的第一处暴露（另两处在 §2.2 与 §2.1）。网关应在起服时解析这一行，`protocol` 与预期不符即拒绝接入。〔清单 A1〕

**当前值 `2`**（2026-09-14 起）。v1 → v2 是不兼容变更：send 剥除 `btw` / `lightweight` / `fork_from` / `tools` 四个桌面字段，并新增 `btw_ask` 命令。仍在发这些字段的 v1 网关会在升级后**直接拿到 `400 invalid invoke body`**（v1 时只是被忽略）——这正是按等值比较拦版本号的用意。

### 1.3 监听地址与安全基线

引擎**只监听 `127.0.0.1`**，产物形态没有配置监听地址的环境变量（`AIDE_HEADLESS_HOST` 不存在）。代码里的安全基线是「不鉴权则禁止监听非回环地址」——启动即抛错拒绝，不靠自觉。〔清单 A4 / F6〕

因此**对外暴露的唯一正确形态是网关反向代理**：网关是引擎唯一的网络前置，由网关负责对外 TLS 与用户鉴权。引擎自身的 Bearer token 是网关与引擎之间的第二道锁，不是终端用户的身份。

### 1.4 平台行为

Windows 下引擎会为 Bash 工具注入口 `BASH_ENV`（`chcp 65001`），让 CLI 输出 UTF-8 防止 GBK 乱码。这是引擎级行为，桌面与 headless 两宿主共享，网关无需干预。

---

## 2. 传输契约

两个端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/invoke` | 下发命令 |
| `GET` | `/events?sessionId=<sid>` | 订阅某会话的事件流（SSE） |

### 2.1 POST /invoke

**请求体**：一个 JSON 对象，`cmd` 字段决定命令类型；大小上限 1MB（`1024 × 1024` 字节）。

**响应**：

| 状态码 | 载荷 | 含义 |
|---|---|---|
| `200` | `{"ok":true,"protocol":2}` | **只表示已入队**。真实结果一律走 SSE，不在这个响应里。〔清单 A3〕 |
| `400` | `{"ok":false,"error":"…"}` | schema 校验失败 / body 不是合法 JSON / body 超 1MB |
| `401` | `{"ok":false,"error":"unauthorized"}` | `Authorization` 缺失或不为 `Bearer <token>` |
| `404` | `{"ok":false,"error":"no route: …"}` | 路径或方法不匹配 |
| `500` | `{"ok":false,"error":"command dispatch failed: …"}` | 命令路由抛了同步异常；进程不崩〔清单 A15〕 |

**400 的错误消息只含字段路径与问题码，不回显提交的值。** 形如：

```
invalid invoke body — mcp_headers.X-User-Token: invalid_type; images.0.data: invalid_type
```

这是刻意的（`env` / `mcp_headers` 的值是凭据）。网关不要指望从错误消息里回读自己提交的内容。〔清单 A7〕

**前向兼容**：schema 是 loose 的——未知的顶层字段与未知的 `display` 块**不剥除**，原样透传到命令层。所以引擎升级不会破坏旧网关；反过来网关也不要指望未知字段有任何语义。〔清单 A8〕

### 2.2 GET /events（SSE）

**请求**：`GET /events?sessionId=<sid>`，`sessionId` 必填，缺失返回 `400`。

**响应**：HTTP 200 + `content-type: text/event-stream`。

**首帧**恒为版本握手（`data:` 后是 JSON，SSE 标准帧格式）：

```
data: {"type":"hello","protocol":2,"sessionId":"<你订阅的 sid>"}

```

注意 `hello` 是**裸帧**（顶层直接是 `type`），而业务帧是**包装帧**（`sessionId` + `event` 两层）。这个区别是有意的，别写一个统一的解包函数把两者混起来。

**业务帧**：

```
data: {"sessionId":"<路由 sid>","event":{"type":"text_delta","delta":"你", …}}

```

`event` 里就是 §5 的事件对象。事件类型与字段见 §5。

**心跳**：每 30 秒一行 SSE 注释，防中间层静默断链：

```
: ping

```
〔清单 A12〕

**订阅语义**（网关必须理解这五条）：

- **按 sessionId 隔离投递**：只有订阅了该 sid 的连接收得到它的帧。〔清单 A9〕
- **一条连接同时只订阅一个会话**：同一条连接重订阅新 sid 后，旧 sid 停止投递（引擎会先摘旧订阅再挂新的）。要同时看多个会话就开多条连接。〔清单 A10〕
- **无人订阅的事件静默丢弃**，不积压、不回放。〔清单 A18〕
- **断线重连无回放**，重连只补 `hello`。〔清单 A11〕
- **特殊 sid `_runtime`**：订阅它收到引擎级健康帧（`health`）。业务会话的订阅者**不会**收到 `health`——两者不串。〔清单 A19〕

**背压**：没有熔断。见规程第 4 条。

### 2.3 鉴权

设了 `AIDE_HEADLESS_TOKEN` 时，两个端点都要求：

```
Authorization: Bearer <token>
```

缺失或错误一律 `401`。〔清单 A5〕

---

## 3. 会话生命周期

### 3.1 时序全貌

```
网关                                        引擎
 │ POST /invoke  {cmd:"send", session_id:"我的sid"} │
 │ ──────────────────────────────────────────────▶│ 起 claude.exe
 │ SSE(<我的sid>): session_init{event.session_id: <真 id>} │ ◀── 真 id 诞生
 │ 【re-key：命令键与订阅键都换成真 id】              │
 │ POST /invoke  {cmd:"send", session_id:<真 id>} │
 │ SSE(<真 id>): text_delta … message_stop        │
 │ POST /invoke  {cmd:"session_stop", session_id:<真 id>} │
 │                                                │ worker 停止、claude.exe 释放
 │ POST /invoke  {cmd:"send", session_id:"新sid", resume_session_id:<真 id>} │ ◀── 唯一续接通道
```

### 3.2 sid 由谁生成

`session_id` 由**客户端**生成并持有：它既是命令的路由键，也是事件订阅的键，同一把钥匙。网关为每个「租户请求 / 用户会话」生成一个 sid（UUID 即可），用同一个值发命令、订阅事件。

### 3.3 re-key 规程（最容易踩的一条）

第一次 `send` 用一个客户端自造的 sid。引擎起 `claude.exe` 后，SDK 会给出**真实会话 id**，引擎通过 `session_init` 事件把它交给你：

```
data: {"sessionId":"<你的 client sid>","event":{"type":"session_init","session_id":"<真 id>","_routing_id":"<你的 client sid>"}}

```

**这一帧投递在 client sid 的通道上**（因为此刻还没 re-key），真 id 在 `event.session_id` 里。收到之后：

1. 后续所有命令的 `session_id` 用**真 id**；
2. SSE 换订阅到**真 id**（断开旧连接、新开一条订阅真 id 的连接，或者在同一条连接上重订阅——但这条连接在切换的空窗期收不到事件，见 §2.2）。

**re-key 必须幂等。** `session_init` **每一轮都会重发**，携带同一个 id（这是 CLI 流式输入的良性行为：PID 不变、零 error 帧）。所以判据是「id 变了才 re-key」，不是「收到 init 就 re-key」。id 没变时什么都不要做。〔清单 F10〕

**会话重启的判据 = init id 变化**，通常伴随 `error` 帧或 `claude.exe` PID 更换。仅靠 init 计数判断会把正常续轮误判成重启。

### 3.4 续接与恢复

- `session_stop` 之后，同一 sid 再 `send` = **全新会话**，上下文不接续。〔清单 B6〕
- 要接续上一轮，用 `resume_session_id` 带上前一会话的**真 id**。〔清单 B11〕
- 引擎重启 / 崩溃后，旧会话一律不恢复；旧 sid 重发 = 全新会话。`resume_session_id` 是唯一通道。〔清单 D5〕

### 3.5 同会话并发

同一 sid 快速连发多条 `send`：串行排队，不丢不乱序。〔清单 B13〕并发多会话之间按 sid 各归各，无交叉污染。〔清单 B12〕

### 3.6 关停

- POSIX：`SIGTERM` / `SIGINT` 触发收尾——SSE 连接被主动断开（客户端 reader 收到干净 done）、worker 停止、进程退出码 0。
- **Windows：不成立。** `kill` 即强制终止，收尾代码全部旁路。见规程第 8 条。〔清单 F1〕

---

## 4. 命令参考

`POST /invoke` 的 body 形如 `{"cmd":"<命令名>", "session_id":"<sid>", …}`。共 **11 条**命令，白名单之外（含 `codegraph_result`）一律 `400`。〔清单 A6〕

除 `send` 与 `session_stop` 外的命令，若 `session_id` 找不到活着的会话会被静默丢弃（规程第 2 条）。

### 4.1 send

下发一条用户消息并开始一轮对话。**新会话由它创建**——对任何未知 sid 发 `send` 都会起一个新会话。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | ✅ | 客户端生成的 sid；re-key 之后用真 id |
| `prompt` | string | ✅ | 发给模型的纯文本（@引用已展开） |
| `display` | array | — | 渲染描述块，见 §4.11 |
| `images` | array | — | 图片附件，两形态**二选一**（见下方「图片附件」） |
| `cwd` | string | — | 会话工作目录 |
| `permission_mode` | string | — | **首条生效**，存活期切换走 `set_permission_mode`（§4.8） |
| `permission_policy` | object | — | 策略快照，见 §6.1 |
| `resume_session_id` | string | — | 要接续的前一会话真 id |
| `env` | object | — | provider 凭据通道（字符串→字符串），见 §7.3 |
| `metadata` | object | — | 不透明租户上下文，见 §7.2 |
| `mcp_headers` | object | — | MCP 头注入表，见 §7.1 |

**网关应当只使用上表这些字段。** 引擎还接受 `automation` / `jump_queue` / `provider_switched` / `auto_title` / `thinking_enabled` / `output_style` / `trusted` / `codegraph_enabled` 等字段，但它们是桌面产品语义，未在网关场景验证过：`automation` 明令禁发（规程第 11 条），其余下发后按引擎内部语义执行，网关不要依赖其行为。1.1 版起 `btw` / `lightweight` / `fork_from` / `tools` **不在 schema 内**，发送即 400。

两个具体警告：

- **`codegraph_enabled: true` 在 headless 下是个死胡同。** 它会让引擎注册 codegraph MCP 工具，工具调用会发出 `codegraph_query` 事件等一个 `codegraph_result` 命令来应答——而那个响应通道是桌面 Rust 进程专属的，headless 下**没有人会应答**。网关不要开这个字段。
- **`permission_mode` / `effort` / `model` / `mode` 的值在 schema 层是不校验的字符串**（`z.string()`，不是枚举）。引擎把它当不透明值透传给 provider。写错值的后果是 provider 侧拒绝，不是 400。

#### 图片附件（`images`）

两种形态**二选一**（`{data, mediaType}` 与 `{path}` 恰好一个在场；都在场或都不在场都是 `400`，报 `images.N.path: custom`）：

| 形态 | 形状 | 说明 |
|---|---|---|
| 内嵌 | `{"data": "<base64 无前缀>", "mediaType": "image/png"}` | 字节随 body 一起传；`mediaType` 必填 |
| 本地路径 | `{"path": "C:/photos/a.jpg"}` | 引擎自己去读这个文件；**不传 mediaType**，引擎按文件头嗅探 |

**为什么要路径形态**：`/invoke` body 上限 1MB（规程 10），base64 再膨胀 4/3——手机原图（2~4MB → 2.7~5.3MB）根本进不来。路径字符串本身只有几十字节，绕开了这道闸；引擎与网关同机（网关 spawn 它），所以那个文件它读得到。

**路径形态的两道守卫**（引擎侧，不可协商）：

- **读入上限 20MB/张**：超限即拒。这是**引擎进程的自我保护**（读入 → base64 ≈ ×1.33 → JSON 副本），不是模型的能力线。
- **魔数嗅探**：读进来必须是 png / jpeg / gif / webp，否则拒。传一个非图片文件（比如 `/etc/passwd`）不会静默成功。

**失败可见**：路径不存在 / 非图片 / 超限，都会让**该条 send 整体拒发**，并推一条 `fatal:false` 的 `error` 帧（`message` 以 `图片` 开头，见 §5.1）——消息不会静默丢。

> **仍建议网关侧按需降采样**（长边 ~1500px）。视觉输入按像素面积计费（约 1 token / 28×28 像素），一张 4000×3000 原图 ≈ 15k 视觉 token，信息量却未必增加。路径形态解决的是"传得进来"，不是"值得传"。

**官方没有输入图片的大小上限**（SDK 文档通篇未提；文中唯一的尺寸数字是宿主侧 `readFile` 控制通道的 1MB 默认 / 10MB 上限）。多大、怎么处理是 SDK 的事，我们只负责形状对、字节在。**但图片失败的可见性当前有缺口**，见 §9.3 第 11 条。

**触发的事件**：`session_init`（首条，或会话重启时）→ 流式过程事件 → `message_stop`。

### 4.2 permission_response

应答一条挂起的 `permission_request`。不应答会一直挂着（`interrupt` 可整轮撤销，挂起请求一并作废）。

**两种形态，二选一**：同一命令里 **`response`（标签形态）与 `approved`（扁平形态）恰好一个在场**——两个都在场或都不在场都是 `400`（`response: custom`）。标签形态是官方推荐；扁平形态是桌面客户端的历史形状，**新写网关不要用**。

#### 标签形态（推荐）

按挂起请求的 `name` 与你的意图选一个变体：

| 收到的请求 | 变体 | 必传 | 可选 |
|---|---|---|---|
| 问答类（`name === "AskUserQuestion"`） | `answer` | `answers` | — |
| | `deny`（拒答 / 跳过） | — | `message` |
| 工具授权类 | `approve` | — | `nextMode`、`sessionRules` |
| | `deny`（人拒绝 / 转述人的拒绝） | — | `message` |
| | `unanswered`（没人应答） | — | `reason` |

变体与引擎能力一一对应，不多不少——刻意**没有** `skip`（它与 `deny` 是同一段引擎行为）；拒绝理由一律**可选**（理由归你，引擎不发明也不索取）。

```jsonc
{ "cmd": "permission_response", "session_id": "…", "id": "perm-7",
  "response": { "kind": "approve",    "nextMode": "auto", "sessionRules": [ … ] } }

{ "cmd": "permission_response", "session_id": "…", "id": "perm-7",
  "response": { "kind": "answer",     "answers": { "选哪个？": "A" } } }

{ "cmd": "permission_response", "session_id": "…", "id": "perm-7",
  "response": { "kind": "deny",       "message": "客户经理已驳回，请改成只读查询" } }

{ "cmd": "permission_response", "session_id": "…", "id": "perm-7",
  "response": { "kind": "unanswered", "reason": "确认超时，操作未执行" } }
```

**`deny` 与 `unanswered` 的区别是「谁拒的」，模型侧措辞因此不同**：

- `deny` → 官方 nhe/YFe 外框，模型被告知"用户不想继续……（用户说了什么）"。
- `unanswered` → 官方「无人工审批可用」外框，措辞自带 `do not retry it in this session — report the limitation to the user`。

> ⚠️ **超时自动拒绝请用 `unanswered`，不要拿 `deny` 塞系统判词。** 把"确认超时"放进 `deny` 的 `message`，模型会被告知"用户说：确认超时"——归因失真，且**丢掉"不要重试"指令**（实测后果：模型按 6 分钟周期反复重试同一写操作，共 3 轮）。

**类别必须匹配**（只对标签形态校验；扁平形态保持历史行为一格不动）：

| 变体 × 挂起工具 | 结果 |
|---|---|
| `answer` × 非 `AskUserQuestion` | 拒绝 + 非致命 `error` 帧 |
| `approve` × `AskUserQuestion` | 拒绝 + 非致命 `error` 帧（问答必须用 `answer`，否则作答丢失） |
| 其余组合 | 正常应答 |

**非法组合不静默**：POST 仍回 `200`（fire-and-forget），随后 SSE 推一条 `fatal:false` 的 `error` 帧（`message` 以 `permission_response` 开头），该挂起请求按**拒绝**收尾（工具不执行，**绝不悬死**）。它表示你的用法有 bug，应当记录并修正。

**触发的事件**：无直接回执；工具的继续 / deny 结果走既有的工具事件与后续流。

#### 扁平形态（兼容，桌面在用）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | ✅ | |
| `id` | string | ✅ | 对应 `permission_request.id` |
| `approved` | boolean | ✅ | 批准 / 拒绝 |
| `message` | string | — | 拒绝理由（**人工**拒绝才用它，见上方警告） |
| `answers` | object | — | 字段式问答的回答 |
| `nextMode` | string | — | 顺带切换权限模式 |
| `sessionRules` | array | — | 会话级规则草稿，见 §6.3 |

### 4.3 interrupt

终止当前轮。会话可继续使用。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |

**触发的事件**：`message_stop`，`stop_reason` 为 `interrupted`。〔清单 B5〕

### 4.4 stop_bg_task

停止一个后台任务。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |
| `task_id` | string | ✅ |

**触发的事件**：`bg_task_ended`，`status` 为 `stopped`。〔清单 B9〕

### 4.5 set_model

存活会话切换模型。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |
| `model` | string | ✅ |

**触发的事件**：`model_switch_result`（成功 / 失败坐实回执）。若「缓存热 + 上下文有体量」，会**先**发 `model_switch_confirm` 等你确认，见 §5.1。

**第三方 provider 注意**：不走 Anthropic 目录的 provider 下，`set_model` 成功但**不发 `models_available`** 事件。网关的模型选择器不要依赖 `models_available` 渲染——那是 Anthropic 系 provider 才有的回执。〔清单 F7〕

### 4.6 model_switch_confirm_decision

应答 `model_switch_confirm` 成本确认。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |
| `confirm_id` | string | ✅ | 对应 `model_switch_confirm.confirm_id` |
| `approve` | boolean | ✅ |

**触发的事件**：`model_switch_result`。**10 秒不应答自动按 deny 收尾**（不会悬死）。〔清单 B8〕

### 4.7 set_effort

切换思考深度档位。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |
| `effort` | string | ✅ |

**触发的事件**：`effort_changed`。非法值会被拒绝且**不脏账面**（回滚到旧值 + 带 `error`）。〔清单 B7〕

### 4.8 set_permission_mode

存活期切换权限模式。**这是存活会话切模式的唯一通道**——`send.permission_mode` 只在首条生效。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |
| `mode` | string | ✅ |

**触发的事件**：`permission_modes_available`。〔清单 B7〕

### 4.9 session_stop

停止会话：worker 停止、`claude.exe` 释放、从注册表移除。

| 字段 | 类型 | 必填 |
|---|---|---|
| `session_id` | string | ✅ |

停止后同一 sid 再 `send` = 全新会话。要接续用 `resume_session_id`（§3.4）。对不存在的 sid 调用是本操作的空转，同样回 200。

### 4.10 update_permission_policy

存活会话推送策略快照，**不重启会话**。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | ✅ | |
| `policy` | object | ✅ | `{revision: number, rules: PermissionRule[]}`，见 §6.1 |

语义：`revision` **单调不回退**——旧 revision 的快照被静默忽略（入队仍回 200）；推送后存活 worker 的下一次工具调用即按新策略裁决。〔清单 B10〕

### 4.12 btw_ask

对**存活的**主会话做一次侧问（走 Claude CLI 的 `side_question` 控制通道，在主会话进程内完成，不新建进程）。典型耗时 1~2 秒。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | ✅ | **主会话** sid（侧问没有自己的会话 id） |
| `question` | string | ✅ | 侧问内容 |
| `history` | array | — | 跨问历史，元素 `{question, response}`，最多 20 条。省略 = 不继承此前侧问 |

**语义要点：**

- **无返回值**（与 `send` 同形，fire-and-forget）：`200` 只表示命令已入队。答案**经 `btw_answer` 事件回来**（§5.2）——不消费该事件的网关会「发了没有回音」。
- **进程内、不落转录**：侧问跑在主会话进程里，不写会话转录 JSONL，也不影响正在进行的回合（主轮进行中也可以问）。
- **模型不调工具**：官方 fork 层对侧问硬编码拒绝一切工具调用，天然纯问答；网关不要指望它读文件。
- **主会话不在 = 拒绝**：没有存活会话（从未 `send` 过 / 已 `session_stop` / 进程崩过）时，事件里回一条带 `error` 的 `btw_answer`，不会凭空建会话。规程第 2 条的「静默丢弃」**不适用于本命令**——它一定会回一条事件。
- 会话正在关闭时 CLI 会回 `Session is shutting down`，同样以 `error` 形态进事件。

**网关动作**：发完后在事件流里按 `session_id` + `question` 匹配 `btw_answer`；带 `error` 的即失败。想要跨问连续性就把此前的 `{question, response}` 累积成 `history` 回传（`synthetic: true` 的兜底答复不要入史）。

### 4.11 display 块（`send.display` 的元素）

`display` 是**不透明渲染描述**：发起方构造，引擎原样搬运，各端自行渲染。引擎不解释内容、不深校验（只认「对象数组、`type` 是字符串」）。

引擎在实践中会回灌这四种形态（`UserMessageBlock`）：

| `type` | 字段 | 说明 |
|---|---|---|
| `text` | `text` | 纯文本段 |
| `image` | `data`, `mediaType` | 图片 |
| `action` | `actionId`, `label`, `icon?` | 动作胶囊（斜杠命令等） |
| `mention` | `path`, `content`, `range?` | @引用卡片；`range` 表示只引用了文件的一段 |

为什么需要它：`prompt` 是 @引用展开后的纯文本，正文 / 引用卡片 / 动作胶囊的边界在编译成 `prompt` 时就丢了，引擎无法还原。渲染信息只能随 `send` 下发、再随 `user_message` 回灌。〔清单 B3〕

**降级约定**：`display` 缺失或出现未知形态时降级为纯文本或跳过该块，**整条消息不能消失**；`text` 字段取 display 原文而非 `prompt`。网关加新的 block 形态时要知道：`UserMessageBlock` 在 `agent-sidecar/src/types.ts` 与 `packages/aide-sdk/src/types/chat.ts` 各定义一份且必须同形，形态漂移会让 display **静默失效**（降级成纯文本，不报错）。

---

## 5. 事件参考

事件分两档：

- **必须处理**——不处理会导致挂死、状态错乱或丢失模型答案。
- **可忽略**——不处理只是少显示一些东西，不影响正确性。

**「可忽略」不等于「可以崩溃」。** 所有帧都必须能被解析或安全跳过；引擎新增事件类型时不保证通知你（前向兼容）。网关的 SSE 解包逻辑应当是「认识就处理，不认识就丢」。

**两个桌面专用事件在 headless 下不会出现**，但列在这里以免你对着类型定义找：

- `heartbeat`——桌面路径每 5 秒往 stdout 发一行供 Rust 看门狗消费；headless 分支不挂这个定时器。
- `session_dead`——由 Rust 进程合成（reader EOF 或看门狗超时），headless 没有 Rust reader，**没有任何组件会发它**。网关检测会话失活要靠 SSE 连接断开 + 自己的轮次超时。

同理 `codegraph_query` 在 headless 下没有应答方（见 §4.1），不应出现。

### 5.1 必须处理（13 种）

#### session_init

会话建立或重启的通知，也是 re-key 的来源。

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | **SDK 真 id** |
| `_routing_id` | string | 本帧投递所用的路由键（此刻等于你的 client sid） |

**到达时机**：首条 `send` 后；以及存活会话的**每一轮**（同 id 重发）。

**网关动作**：见 §3.3。幂等 re-key，id 变了才动键。

#### text_delta

模型正文的流式增量。

| 字段 | 类型 | 说明 |
|---|---|---|
| `delta` | string | 增量文本 |
| `model` | string? | 本条消息的真实 wire model，只盖在同消息首个块事件上 |
| `modelLabel` | string? | 展示建议名（如 `"sonnet"`），可能为空 |

**网关动作**：按 sid 累积渲染。若要做打字机效果，注意增量可能被引擎侧合并过，不要假设一个字一帧。

#### message_stop

一轮结束的**权威信号**。网关的状态机以此收尾。

| 字段 | 类型 | 说明 |
|---|---|---|
| `stop_reason` | string | 如 `end_turn` / `interrupted` |
| `total_cost_usd` | number \| null | 本轮费用 |
| `usage` | object \| null | token 用量（`inputTokens` / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` / `costUsd`，另有 `byModel` / `apiCallCount` 等可选诊断字段） |
| `effort` | string? | 本轮**实际生效**的档位（可能含 provider 侧静默降级）；provider 无此概念时不带 |

**网关动作**：结束「运行中」状态、解除忙碌标记。轮次超时应当以「多久没等到它」为判据（规程第 7 条）。

#### permission_request

工具调用需要授权。**必须应答**，否则一直挂着。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 应答时回填 |
| `name` | string | 工具名 |
| `input` | unknown | 工具入参（如 Bash 的 `command`） |
| `fromSubagent` | object? | `{id, agentName}`——这次请求是子代理内部发起的；缺省表示来自主线程 |

**网关动作**：把 `name` / `input` / `fromSubagent` 呈现给终端用户（或按 §6 的策略自动裁决），然后用 `permission_response`（§4.2）应答。

#### permission_cancelled

撤下一条挂起的权限请求。**语义是「这条请求已终结」，不是「被取消」**——批准、拒绝、`interrupt`、模式切换连带放行**都会**发它。

| 字段 | 类型 |
|---|---|
| `id` | string |

**网关动作**：按 `id` 从待办里移除。重复到达是 no-op（要幂等）。工程上最容易漏的点：一条请求可能先被你自己应答、随后又收到它的 `permission_cancelled`，两者不能互相覆盖。

#### model_switch_confirm

切换模型的成本确认。只在「缓存热 + 上下文有体量」时发出。

| 字段 | 类型 | 说明 |
|---|---|---|
| `confirm_id` | string | 应答时回填 |
| `from_model` / `to_model` | string | |
| `source` | string | `command` \| `picker` \| `sdk` |
| `context_tokens` | number | 当前上下文规模 |
| `prompt_cache_warm` | boolean | 缓存是否热 |
| `estimated_cache_write_usd` | number | 切过去重铺缓存的预估成本（美元） |
| `cache_ttl` | string | `5m` \| `1h` |

**网关动作**：呈现成本给用户，用 `model_switch_confirm_decision`（§4.6）应答。**10 秒不应答自动 deny**，所以你即使不打算询问用户也要及时应答或接受自动拒绝。〔清单 B8〕

#### error

| 字段 | 类型 | 说明 |
|---|---|---|
| `message` | string | 人类可读说明 |
| `fatal` | boolean? | `false` = 可恢复（进程仍存活，可继续发消息）；缺省 / `true` = 致命 |

**网关动作**：`fatal !== false` 时把会话标记为停止；`fatal: false` 时展示警告但保持会话可用。

**协议用法错误也走这一帧**：命令在 schema 层过了、但语义不成立（如 `permission_response` 的变体与挂起请求类别不匹配，见 §4.2）时，引擎推一条 `fatal:false` 的 `error`（`message` 以命令名开头，如 `permission_response answer 变体只对 AskUserQuestion 有效…`），并把该挂起请求按拒绝收尾。会话保持可用。

**注意到达延迟**：模型端点不可达时这一帧最长约 189 秒才来（规程第 7 条）。网关不能靠它做快速故障检测。〔清单 F2〕

#### user_message

用户消息已入队的权威广播。**三端（桌面 / 鸿蒙 / PWA）都只认这条事件渲染用户气泡**，不本地乐观渲染。

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | display 原文 |
| `display` | array? | 原样回灌的渲染描述块 |

**网关动作**：收到才画用户气泡——不要在自己发 `send` 成功后本地画。这样插队消息（§5.2）也能正确显示，且不存在重复渲染（单一渲染来源，无需 id 去重）。

代价是多一个 RTT 才出气泡，已接受。〔清单 B3〕

#### model_switch_result

`set_model` 的坐实回执。

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | boolean | |
| `model` | string | 真名（不是 CLI 别名回显） |
| `display` | string | 人类可读名 |
| `error` | string? | `ok:false` 时的原因 |

#### permission_modes_available

| 字段 | 类型 | 说明 |
|---|---|---|
| `modes` | array | `[{value, displayName}]` |
| `current` | string | |
| `error` | string? | |

#### models_available

| 字段 | 类型 | 说明 |
|---|---|---|
| `models` | array | `[{value, displayName}]` |
| `current` | string | |

**第三方 provider 下可能不发**（§4.5）。

#### effort_changed

| 字段 | 类型 | 说明 |
|---|---|---|
| `effort` | string | 新值（失败时是回滚后的旧值） |
| `error` | string? | 失败原因 |

#### health

引擎级健康快照。**只投给订阅了 `_runtime` 的连接**，业务会话订阅者收不到。

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessions` | object | `{active, idle, stalled, total}` |
| `processes` | object | `{claudeExeCount}` |
| `timestamp` | number | |

每 30 秒一帧。网关若做看板可以订阅 `_runtime`，但不要把它和业务会话的订阅混在一条连接上。〔清单 A19〕

### 5.2 可忽略（30 种）

这些事件不驱动状态机。网关可以全部丢弃。

| 事件 | 载荷要点 | 若你要消费它 |
|---|---|---|
| `btw_answer` | `session_id`, `question`, `response?`, `error?`, `synthetic?` | **侧问的答案通道**——见下方注 |
| `thinking` | `text` | 思考块整块（非增量） |
| `thinking_delta` | `delta` | 思考块逐字增量 |
| `tool_use_start` | `id`, `name`, `input`, `model?` | 展示「正在用什么工具」 |
| `tool_result` | `id`, `content`, `is_error` | 展示工具产出 |
| `subagent_start` | `id`, `agentName`, `description`, `prompt?` | 展示子代理 |
| `subagent_text_delta` | `id`, `delta` | 子代理正文流 |
| `subagent_thinking_delta` | `id`, `delta` | 子代理思考流 |
| `subagent_progress` | `id`, `toolUseId`, `toolName`, `input` | 子代理的工具步骤 |
| `subagent_tool_result` | `id`, `toolUseId`, `content`, `is_error` | 子代理工具产出 |
| `subagent_async_launched` | `id`, `agentId`, `outputFile` | 后台子代理启动 ack |
| `subagent_end` | `id`, `result`, `is_error` | 子代理收尾 |
| `subagent_nesting_warning` | `depth`, `threshold` | 嵌套过深的软告警（只警告不阻止） |

> **`btw_answer` 是「可忽略」列表里唯一的例外。** 它不驱动状态机的前提是**你没发过 `btw_ask`**——发过就必须消费：`btw_ask` 没有返回值，答案只从这里来。字段语义：`response` 与 `error` 互斥；`synthetic: true` 表示官方兜底答复（照常展示，但不要喂进 `history`）。
| `bg_task_started` | `id`, `command?`, `description?`, `outputFile?` | 后台 shell 任务启动 |
| `bg_task_output` | `id`, `delta` | 后台任务输出增量 |
| `bg_task_ended` | `id`, `status`, `summary?`, `durationMs?` | 后台任务终态（`completed`/`failed`/`stopped`） |
| `jump_queued` | `prompt` | 插队消息已登记（桌面语义） |
| `jump_promoted` | — | 插队消息已接入 |
| `session_title` | `title` | 自动生成的会话标题 |
| `tasks_update` | `tasks` | 待办列表快照 |
| `context_usage` | `total_tokens`, `max_tokens`, `raw_max_tokens?`, `percentage`, `categories?`, `breakdown?` | 上下文占用（含占用来源明细，见下方注） |
| `context_compaction` | `stage`, `detail?`, `error?` | 上下文压缩生命周期 |
| `rate_limit` | `subscription`, `windows` | 订阅额度窗口 |
| `model_committed` | `from_model`, `to_model`, `requested_model`, `source` | 进程级切换坐实 |
| `builtin_hooks_manifest` | `manifest` | 内建 hook 清单 |
| `slash_commands_available` | `commands` | 可用斜杠命令清单 |
| `image_input_rejected` | `message` | 图片输入被拒的说明 |
| `image_input_rollback` | `text` | 图片被回滚，`text` 是要放回输入框的原文 |
| `notification` | `message`, `notification_type` | 信息性提示 |
| `codegraph_query` | `request_id`, `tool`, `args`, `project_root` | 代码索引查询。**headless 下没有应答方**——别开 `send.codegraph_enabled`（§4.1） |

> `bg_task_*` 三个事件：网关若要在业务界面展示「后台跑着什么」，消费它们即可；不消费也不影响会话正确性。

> **`context_usage` 的两个切面**（都可不消费）。`categories` 说「窗口怎么分块」（provider 自报的分类，`name` 是不透明标签）；`breakdown` 说「这些 token 是谁的」——哪个 MCP server 的哪条工具、哪份记忆文件。六组各自可选，缺席即不渲染：
> `mcpTools[{name, serverName, tokens}]` / `systemTools[{name, tokens}]` / `deferredBuiltinTools[{name, tokens}]` / `systemPromptSections[{name, tokens}]` / `memoryFiles[{path, type, tokens}]` / `agents[{agentType, source, tokens}]`。
> 两者粒度不同（类 vs 实例），**不保证合计相等**（延迟加载的工具是否计入 `mcpTools` 未验证）——不要拿 `breakdown` 的合计去对 `categories` 的某一行。

---

## 6. 权限模型

三层裁决，优先级从高到低。

### 6.1 第一层：策略快照（Aide policy）

由 `send.permission_policy` 首带，或 `update_permission_policy` 活体推送。

```jsonc
{
  "revision": 1,            // 单调不回退；旧 revision 被静默忽略
  "rules": [
    {
      "id": "r1",
      "scope": "session",   // managed | user | project | local | session
      "order": 10,
      "effect": "allow",    // allow | ask | deny
      "tool": "mcp__agri-platform__query_device",
      "matcher": { "kind": "tool" }
    }
  ]
}
```

`matcher` 四种形态：

| `kind` | 字段 | 匹配 |
|---|---|---|
| `tool` | — | 工具名即匹配 |
| `bash` | `mode`: `all`\|`prefix`\|`contains`, `value?` | Bash 命令文本 |
| `path` | `field`: `file_path`\|`path`\|`notebook_path`, `folder?`, `file?` | 文件路径 |
| `field` | `field`: `url`\|`query`\|`command`, `equals` | 指定字段等值 |

规则形状与桌面端 `src-tauri/src/policy/model.rs` 同形。

**语义**：`allow` / `deny` 由 PreToolUse hook **直接裁决**，不产生 `permission_request`；`ask` 转入确认流；没有规则匹配则回退第二层的模式默认流。推送**不重启会话**——存活 worker 的下一次工具调用即按新策略生效。〔清单 B10〕

### 6.2 第二层：权限模式

`send.permission_mode` 首条生效（续发不回放；存活期切换走 `set_permission_mode`）。

| 模式 | 行为 |
|---|---|
| `manual` | 每个工具都走 `permission_request` 确认流〔清单 B4 / D2〕 |
| `bypassPermissions` | 工具直接放行（策略 hook 仍然生效） |
| `auto` / `default` | 由 CLI 内置分类器判断命令安全性——见 6.3 的选型警告 |
| `plan` | 计划模式 |

### 6.3 第三层：CLI 内置 auto 分类器 + 选型建议

`auto` / `default` 模式下，CLI 自行分类命令是否安全。**第三方 provider（实测 qwen）下这个分类器不稳定**：单步分类延迟 48–154 秒、stage-2 出错时 fail-closed 误拒完全良性的命令、模型重试放大轮次预算。〔清单 F9〕

长驻网关会话**三选一**：

1. **规则前置（推荐）**——用 `permission_policy` 把业务工具面写成明确的 allow / deny 规则。规则命中不经过分类器，裁决确定性恢复。
2. **模式选型**——写确认场景用 `manual`（把 `permission_request` 转发给业务前端，见 §4.2 / §8）；受信批处理场景用 `bypassPermissions`。
3. **预算放宽**——坚持 `auto` 就把轮次超时与重试预算按 **≥3 分钟/轮**放宽，并容忍偶发误拒。

证据可复跑：`agent-sidecar/smoke-headless-bashprobe.ts`。

### 6.4 确认流的闭环

```
SSE: permission_request{id, name, input}
      ↓ 网关按 name 与意图选变体
POST: permission_response{session_id, id, response:{kind, …}}     ← 标签形态
      ↓
SSE: tool_use_start / tool_result … → message_stop
```

选变体的三分支：`name === "AskUserQuestion"` → `answer`（作答）或 `deny`（拒答）；工具授权 → `approve` / `deny`；**没人应答（确认超时、离线批处理）→ `unanswered`**（见 §4.2 的警告：别拿 `deny` 塞系统判词）。变体与请求类别不匹配时，SSE 另推一条 `fatal:false` 的 `error`，该请求按拒绝收尾。

拒绝时把理由放进 `message` / `reason`，模型会据此自然语言收尾而不是硬中断。〔清单 B4 / D2〕

**`sessionRules`**（可选）：随 `permission_response` 下发会话级规则草稿 `[{effect, tool, matcher}]`，引擎入库时补全 `id` / `scope`（恒为 `session`）/ `order`。用于「这次批准，本会话内同类都放行」。

---

## 7. 多租户与凭据注入

网关把终端用户身份透传到 MCP 工具层的三条通道。

### 7.1 mcp_headers — 按会话注入 HTTP 头

```jsonc
{
  "mcp_headers": {
    "*":                { "X-Request-Id": "trace-123" },   // 打底
    "agri-platform":    { "X-User-Token": "<用户 token>" } // 精确名优先
  }
}
```

- 只作用于 `http` / `sse` 型 MCP server；`stdio` 型没有头面。
- `"*"` 打底，精确名覆盖。
- 注入的头**覆盖** `settings.json` 里的静态同名头。
- **每次 `send` 刷新，缺席 = 清空**——这构成轮换语义。
- 非法表 fail-closed：schema 层 400；绕过 schema 直灌时整表忽略且日志不含值。〔清单 C1 / C2 / C3 / C5〕

**生效时机**（规程第 5 条）：头在 `query()` 启动那一刻定装。存活 query 内续轮**永不换头**；要轮换就重启会话 + resume；error 终态后的下一条 `send` 会自动以 resume 重连带新头。〔清单 C4 / D3 / F3〕

**会话间隔离**：同一个 MCP server 按连接收到各会话自己的头，不串。〔清单 C9〕

### 7.2 metadata — 不透明租户上下文

任意 `Record<string, unknown>`。进程内 hook 通过 `HookBuildContext.session.metadata()` 读活值；**用户 shell hook 读不到**（刻意的设计代价）。〔清单 C6〕

### 7.3 env — provider 凭据通道

`{"ANTHROPIC_BASE_URL": "…", "ANTHROPIC_AUTH_TOKEN": "…", "ANTHROPIC_MODEL": "…"}`。只进 `claude.exe` 子进程的环境变量。

### 7.4 安全红线（实测钉死）

- `metadata` / `mcp_headers` 的值**绝不进** Bash 工具子进程的 env——实测子进程 141 个环境变量键逐值扫描零命中。〔清单 C7〕
- 这些值**绝不落** runtime 日志——实测含真 token 哨兵的日志扫描零命中。〔清单 C8〕

也就是说：**模型无法经由工具面外带网关注入的凭据**。但这是引擎侧的保证——网关自己那一侧（日志、错误上报、前端存储）仍要按凭据对待。

---

## 8. 端到端示例

### 8.1 起服

```bash
AIDE_HEADLESS_TOKEN=s3cret CLAUDE_CONFIG_DIR=/tmp/aide-headless node dist/runtime.js headless
# stdout: {"type":"headless-listening","port":18090,"protocol":2}
```

### 8.2 订阅事件流

```bash
curl -N -H "Authorization: Bearer s3cret" \
  "http://127.0.0.1:18090/events?sessionId=租户请求的sid"
```

先收到 hello：

```
data: {"type":"hello","protocol":2,"sessionId":"租户请求的sid"}
```

### 8.3 发第一条消息

```bash
curl -s -X POST http://127.0.0.1:18090/invoke \
  -H "Authorization: Bearer s3cret" \
  -H "Content-Type: application/json" \
  -d '{
    "cmd": "send",
    "session_id": "租户请求的sid",
    "prompt": "查一下最近的设备台账",
    "permission_mode": "manual",
    "metadata": { "tenant": "acme", "user": "u-42" },
    "mcp_headers": { "agri-platform": { "X-User-Token": "<用户 token>" } }
  }'
# → {"ok":true,"protocol":2}
```

### 8.4 收 re-key 帧

```
data: {"sessionId":"租户请求的sid","event":{"type":"session_init","session_id":"1f3a-…-真id","_routing_id":"租户请求的sid"}}
```

**此刻换键**：后续命令用 `1f3a-…-真id`，订阅也换到它。

### 8.5 流式与权限确认

```
data: {"sessionId":"1f3a-…","event":{"type":"text_delta","delta":"我来查", …}}
data: {"sessionId":"1f3a-…","event":{"type":"permission_request","id":"perm-7","name":"mcp__agri-platform__query_device","input":{"lineId":"L-9"}}}
```

应答：

```bash
curl -s -X POST http://127.0.0.1:18090/invoke \
  -H "Authorization: Bearer s3cret" -H "Content-Type: application/json" \
  -d '{"cmd":"permission_response","session_id":"1f3a-…-真id","id":"perm-7","response":{"kind":"approve"}}'
```

然后收工具产出与收尾：

```
data: {"sessionId":"1f3a-…","event":{"type":"tool_use_start", …}}
data: {"sessionId":"1f3a-…","event":{"type":"tool_result", …}}
data: {"sessionId":"1f3a-…","event":{"type":"message_stop","stop_reason":"end_turn","total_cost_usd":0.012,"usage":{…}}}
```

### 8.6 续轮

```bash
curl -s -X POST http://127.0.0.1:18090/invoke \
  -H "Authorization: Bearer s3cret" -H "Content-Type: application/json" \
  -d '{"cmd":"send","session_id":"1f3a-…-真id","prompt":"再查 L-10"}'
```

同一 sid 续发即接上下文（会话活着）。会话已经 `session_stop` 过则要带 `resume_session_id`。

### 8.7 最小 SSE 客户端（node）

```js
// 勤读、不积压、不认识的事件直接丢——这三点就是对网关的全部要求。
const res = await fetch(`${BASE}/events?sessionId=${encodeURIComponent(sid)}`, {
  headers: { authorization: `Bearer ${TOKEN}` },
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";

for (;;) {
  const { value, done } = await reader.read();   // 立刻回到这里继续读，别在循环里 await 业务处理
  if (done) break;
  buf += decoder.decode(value, { stream: true });

  let idx;
  while ((idx = buf.indexOf("\n\n")) !== -1) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    if (raw.startsWith(":")) continue;           // 心跳注释行
    if (!raw.startsWith("data: ")) continue;
    const frame = JSON.parse(raw.slice(6));
    if (frame.type === "hello") continue;        // 裸帧
    handleEvent(frame.sessionId, frame.event);   // 包装帧
  }
}

function handleEvent(sessionId, ev) {
  switch (ev.type) {
    case "session_init":   /* 幂等 re-key：ev.session_id !== 当前键才换 */ break;
    case "text_delta":     /* 累积 ev.delta */ break;
    case "permission_request": /* 呈现给用户，然后回 permission_response */ break;
    case "message_stop":   /* 收尾 */ break;
    case "error":          /* ev.fatal !== false → 标记会话停止 */ break;
    default:               /* 不认识就丢 */ break;
  }
}
```

**注意这个循环的形状本身就是规程第 4 条**：读取不能被业务处理阻塞。真要把事件投给慢消费者，先入内存队列再异步消费，别在 `for(;;)` 里同步做重活。

---

## 9. 运维基线与已知限制

### 9.1 容量

单实例 10 个并行会话的实测（死端点，只压宿主面）：〔清单 D6〕

- runtime 本体 RSS 增量约 **6MB**（≈0.6MB/会话，亚线性）
- 每个会话对应一个 `claude.exe`，1:1，各约 **280MB**——内存大头在这里
- 10/10 成流、零串扰、`session_stop` 后残留 0

容量规划按 `claude.exe` 算，不按 runtime 算。

> **数字强度说明**：上面「残留 0」「1:1」这类进程数结论来自当时的进程枚举观测面，而该观测面后来被发现会间歇漏检活进程（`tasklist` 在本机不可靠，`smoke-headless-lib.ts` 已整体切到 PowerShell CIM）。所以这些数字应读作「观测面未见异常」，不是「已证明为零」。会话数、内存趋势、成流与串扰结论不受影响。〔清单 F11〕

### 9.2 故障可见性

| 情况 | 感知方式 | 延迟 |
|---|---|---|
| 模型端点不可达 | `error` 帧（`fatal:false`，进程存活） | 最长约 **189s**〔清单 F2〕 |
| runtime 崩溃 | SSE 连接断开（reader error） | 立即〔清单 D5〕 |
| 网关重启 | 引擎不受影响；重订阅后继续收新事件 | 立即〔清单 D4〕 |
| 会话卡死 | **引擎不发信号**，靠网关自己的轮次超时 | — |

最后一行是设计现状：headless 没有看门狗（那是桌面 Rust 的职责），网关必须自备轮次超时。

### 9.3 已知限制汇总

| # | 限制 | 应对 |
|---|---|---|
| 1 | SSE 无回放 | 网关容忍或自补偿（规程 3） |
| 2 | SSE 无背压熔断 | 勤读（规程 4） |
| 3 | Windows 无优雅关停、会留孤儿进程 | 网关自带按父 PID 差集的清理（规程 8） |
| 4 | 引擎无持久化 | `resume_session_id` 续接（规程 6） |
| 5 | 超 1MB 的响应对 fetch 不友好 | 自我限界（规程 10）；**大图改用 `send.images` 的路径形态**（§4.1），不经 body |
| 6 | 第三方 provider 下 `models_available` 缺席 | 选择器不依赖它〔清单 F7〕 |
| 7 | 第三方 provider 下 auto 分类器不稳 | §6.3 三选一〔清单 F9〕 |
| 8 | `session_init` 每轮重发 | re-key 幂等〔清单 F10〕 |
| 9 | 命令发给不存在会话静默丢弃 | 网关自己维护会话状态（规程 2） |
| 10 | `unanswered` 的外框（官方「无人工审批可用」模板）未登记进桌面/PWA 的拒绝态识别前缀——本产品 UI 认不出它会当普通工具报错 | 无实际影响：headless 会话的转录不由本产品 UI 渲染（网关自己的界面消费）。将来若把桌面 automation 的两处裸文案收编到这条外框，必须同步 `packages/aide-sdk/src/utils/toolDenial.ts` 的前缀 |
| 11 | **图片失败可能不可见**：引擎不读 result 消息的 `terminal_reason`（SDK 正式字段，取值含 `"image_error"`，见 `docs/TypescriptSDk.MD:1489`）。图片过大或损坏导致本轮异常收尾时，若落在 `subtype:"success"` + `is_error:false` 上，引擎会当**正常结束**处理（`mapper.ts` 的 success 早退），网关看到的是一个「没产出就结束」的轮次 | 网关侧：发过 `images` 且本轮无产出地结束 → 优先怀疑图片（缩小后重发）。引擎侧已排期接住 `terminal_reason`，但 `image_error` 实际落在哪个 subtype 需真模型实测校准，故未随 v1.3 落地 |

### 9.4 复跑验收

```bash
cd agent-sidecar && npm run build
npx tsx smoke-headless-host.ts       # 协议面，期望 22/22
npx tsx smoke-headless-gateway.ts    # 网关彩排，期望 20/20
npx tsx smoke-headless-realmodel.ts  # 真模型（需要 provider 凭据），期望 13/13
npx tsx smoke-headless-policy.ts     # 策略与后台任务，期望 6/6
```

四个脚本都输出 `ledger n/n passed` 并以 exit code 表达结果，可直接进 CI。

---

## 附录 A：状态码总表

| 端点 | 码 | 触发条件 |
|---|---|---|
| `/invoke` | 200 | 已入队（不代表执行成功） |
| `/invoke` | 400 | schema 校验失败 / body 非 JSON / body > 1MB / JSON 解析失败 |
| `/invoke` | 401 | Bearer 缺失或错误 |
| `/invoke` | 404 | 路径或方法不对 |
| `/invoke` | 500 | 命令路由同步异常 |
| `/events` | 200 | SSE 流已建立 |
| `/events` | 400 | `sessionId` 查询参数缺失或为空 |
| `/events` | 401 | Bearer 缺失或错误 |
| 两者 | 401 | 鉴权先于路由判断——没有 token 时连 404 也拿不到 |

## 附录 B：底稿编号对照

本文件里所有 `〔清单 Xn〕` 标注指向 `docs/headless-test-checklist.md` 的编号。对照如下。

**A 组（协议面，`smoke-headless-host.ts` 22/22）**

| 编号 | 本文位置 |
|---|---|
| A1 | §1.2 启动标志 |
| A3 | §2.1 响应语义 |
| A4 / F6 | §1.3 监听地址 |
| A5 | §2.3 鉴权 |
| A6 | §4 命令白名单 |
| A7 | §2.1 400 不回显 |
| A8 | §2.1 前向兼容、§4.11 降级约定 |
| A9 / A10 / A11 / A18 | §2.2 订阅语义 |
| A12 | §2.2 心跳 |
| A15 | 规程 2、§2.1 状态码 |
| A19 | §5.1 health |
| A20 | 规程 4、§2.2 背压 |

**B 组（引擎集成）**

| 编号 | 本文位置 |
|---|---|
| B1 | 规程 1、§3.3 |
| B3 | §4.11、§5.1 user_message |
| B4 / D2 | §6.2、§6.4 |
| B5 | §4.3 |
| B6 | §3.4 |
| B7 | §4.7、§4.8 |
| B8 | §4.6、§5.1 model_switch_confirm |
| B9 | §4.4 |
| B10 | §4.10、§6.1 |
| B11 | §3.4 |
| B12 / B13 | §3.5 |
| B14 / F8 | 规程 11 |

**C 组（多租户与安全红线，机制①）**

| 编号 | 本文位置 |
|---|---|
| C1 / C2 / C3 / C5 | §7.1 |
| C4 / D3 / F3 | 规程 5、§7.1 生效时机 |
| C6 | §7.2 |
| C7 / C8 | 规程 10、§7.4 |
| C9 | §7.1 会话间隔离 |

**D 组（网关彩排，`smoke-headless-gateway.ts` 20/20）**

| 编号 | 本文位置 |
|---|---|
| D1 | §7 多租户总述 |
| D4 | §9.2 网关重启 |
| D5 | 规程 6、§3.4、§9.2 |
| D6 | §9.1 容量 |

**发现清单 F1–F11**

| 编号 | 级别 | 本文位置 |
|---|---|---|
| F1 | P1 | 规程 8、§3.6、§9.3 |
| F2 | P1 | 规程 7、§5.1 error、§9.2 |
| F3 | P0 已修 | 规程 5、§7.1 |
| F4 | P0 已修 | （引擎内部修复，不构成本文对接约束） |
| F5 | P2 | 规程 10、附录 A |
| F6 | P2 | §1.3 |
| F7 | P2 | §4.5、§9.3 |
| F8 | P2 | 规程 11 |
| F9 | P1 | 规程 9、§6.3 |
| F10 | P2 | 规程 1、§3.3 |
| F11 | P2 | （验收工具观测面，不构成对接约束） |

**未纳入本文**：清单 §6 的 E 组（agri 真项目联调，7 项）待业务侧完成 starter 接入后执行，属联调范围而非协议契约。

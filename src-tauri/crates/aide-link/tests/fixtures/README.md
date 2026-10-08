# Aide Link 一致性向量

两类向量，**手机端实现可以直接拿来自测**（见 `docs/aide-link-protocol.md` §12）。

## 1. 对话向量 `01_*.json … 04_*.json`

每个文件是一个数组，元素 = 一个向量：`{ "name", "channel"?, "offer"?, "steps": [ … ] }`。执行器：
`crates/aide-link/src/conformance.rs`（对着 `testkit` 里的假 Host 跑；真实 Host 实现 `Harness` 即可复用）。

`channel`（默认 `"resume"`）：开始前由执行器完成的握手——`resume`（以手机 A 恢复）、`pair`（以手机 B 用有效二维码配对）、
`none`（不握手，全靠 `connect` / `wire_*` 步骤）。`offer: "none"`：开始前撤掉 Host 的配对二维码。

内层（Link 帧，经加密通道）：

| 步骤 | 含义 |
|---|---|
| `{"send": <帧>}` | 客户端发一个 Link 帧 |
| `{"expect": <帧模式>}` | 下一个 Link 帧必须匹配（**子集匹配**：只校验写出的键，Host 多给的键忽略） |
| `{"expect_set": [<模式>…]}` | 这几帧都要到，顺序不限（并发应答） |
| `{"expect_none": true}` | 此刻不应有多余的帧 |
| `{"emit": {"name", "payload"}}` | 让 Host 产生一个事件 |
| `{"tick_secs": N}` | 假装过了 N 秒（心跳 / 超时 / 配对状态变化） |
| `{"expect_closed": true}` | Host 此刻应已终止连接 |

外层（握手，明文）：

| 步骤 | 含义 |
|---|---|
| `{"connect": {"mode", "as", "psk", "versions"}}` | 发 `sc_init`；Host 回 `sc_resp` 则完成客户端握手，回 `sc_err` 则留给 `wire_expect` |
| `{"wire_send": <外层帧 \| 字符串>}` | 原样发一条外层消息（字符串 = 原样文本，用来造乱码） |
| `{"wire_expect": <外层帧模式>}` | 下一条外层帧必须匹配 |
| `{"connection": "名字"}` | 切到另一条并行连接（首次出现即新建，共享同一个 Host） |

`connect.mode`：`resume` / `pair`；`as`：角色 `a`（已配对的手机）/ `b`（另一台）/ 其他（陌生人，随机密钥）；`psk`：`offer`（有效二维码里的）/ `wrong`。

模式里的占位符：`"<any>"` / `"<string>"` / `"<number>"` / `"<bool>"`。

**约定的固定值**（`crates/aide-link/src/testkit.rs`）：Host `device_id` `00112233445566778899aabbccddeeff`、
Host 私钥 `0x42` × 32；手机 A 私钥 `0xA1` × 32（已配对）；手机 B 私钥 `0xB2` × 32；有效二维码的一次性密钥 `0x5A` × 32；
Host 画像 `name=fake-host os=linux`；`list_sessions` → `["s1","s2"]`；`send_message` / `get_settings` 回显参数；
`set_model` 失败 `model not found`；`load_messages` 慢 150ms 后回 `["slow"]`；Host 的远程默认权限模式 `acceptEdits`；
事件 epoch `epoch-1`，序号从 1 起。

## 2. 逐字节密码学向量 `noise_vectors.json`

固定密钥 + 固定临时密钥 → Noise 握手两条消息与传输态第一块密文都是确定的。你的 Noise 实现对同样输入必须产出同样的字节
（见协议文档 §4.2）。由 `tests/noise_vectors.rs` 生成并校验（`UPDATE_VECTORS=1` 重写）；它变了 = 协议不兼容变更，须升版本号。

# Aide Link 一致性向量

语言无关的对话脚本，**手机端实现可以直接拿来自测**（见 `docs/aide-link-protocol.md` §11）。
每个 `*.json` 是一个数组，元素 = 一个向量：`{ "name", "steps": [ … ] }`。

步骤种类（执行器：`crates/aide-link/src/conformance.rs`）：

| 步骤 | 含义 |
|---|---|
| `{"send": <帧>}` | 客户端发一帧（字符串 = 原样发，用来造乱码） |
| `{"expect": <帧模式>}` | 下一帧 Host 帧必须匹配（**子集匹配**：只校验写出的键，Host 多给的键忽略） |
| `{"expect_set": [<模式>…]}` | 这几帧都要到，顺序不限（并发应答） |
| `{"expect_none": true}` | 此刻不应有多余的帧 |
| `{"emit": {"name", "payload"}}` | 让 Host 产生一个事件 |
| `{"tick_secs": N}` | 假装过了 N 秒（心跳 / 超时） |
| `{"expect_closed": true}` | Host 此刻应已终止连接 |

模式里的占位符：`"<any>"` / `"<string>"` / `"<number>"` / `"<bool>"`。

**约定的固定值**（被测 Host 需满足；aide 的假 Host 在 `crates/aide-link/src/testkit.rs`）：
配对码 `123456`；已配对的 token `test-token`；Host 画像 `id=dev-1 name=fake-host os=linux`；
`list_sessions` → `["s1","s2"]`；`send_message` / `get_settings` 回显参数；`set_model` 失败
`model not found`；`load_messages` 慢 150ms 后回 `["slow"]`；Host 的远程默认权限模式 `acceptEdits`；
事件 epoch `epoch-1`，序号从 1 起。

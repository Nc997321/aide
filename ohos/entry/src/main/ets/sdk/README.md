# ohos sdk 过筛副本

`packages/aide-sdk` 的 ArkTS 化子集。**上游是唯一事实源**，本目录是单向同步的副本——改协议/改上游实现后必须重新过筛到这里。

## 来源映射

| 本目录 | 上游 | 性质 |
|---|---|---|
| `transport.ets` | `packages/aide-sdk/src/transport.ts` | 过筛（去 Tauri 默认实现） |
| `remote.ets` | `packages/aide-sdk/src/remote.ts` | 过筛 → **编排层**（重连/配对/状态机只做编排，连接细节全部下沉 `link/`，协议语义零改动） |
| `link/types.ets` | `packages/aide-sdk/src/remote.ts` | 拆分（`WsLike` 契约 + 连接事件/配置类型） |
| `link/frames.ets` | `packages/aide-sdk/src/remote.ts` | 拆分（wire 装配器：字符串帧拼接/取帧，三端字节序契约的本地端） |
| `link/backoff.ets` | `packages/aide-sdk/src/remote.ts` | 拆分（退避策略：1s→30s + 0-500ms 抖动，纯函数） |
| `link/attempt.ets` | `packages/aide-sdk/src/remote.ts` | 拆分（`ConnAttempt`：单次连接生命周期——握手/keepalive/watchdog/废弃判定，回调四槽 + 定时器零泄漏） |
| `storage.ets` | `remote-pwa/src/storage.ts` | 过筛（localStorage → preferences，键名/校验语义零改动） |
| `api.ets` | `packages/aide-sdk/src/api.ts` | 过筛子集（对象字面量门面 → class + 单例；命令名/参数形状零偏差） |
| `types.ets` | `packages/aide-sdk/src/types.ts` | 过筛子集（按页面域收录 DTO） |
| `ws-ohos.ets` | — | 平台新代码（@ohos.net.webSocket → WsLike 适配器） |

## 过筛规则（同步脚本/手工同步都须遵守）

1. DOM 事件类型（`Event`/`MessageEvent`/`CloseEvent`）→ 最小事件 interface（`WsOpenEvent` 等）
2. 对象字面量（`{ type: "connect", code }` 直传 `send`）→ 显式具名 interface 实例（ArkTS 拒绝无类型字面量）
3. `"code" in creds` 判别 → `as ConnectByCode` 收窄 + `!== undefined` 字段探测（ArkTS 无 `in` 操作符）
4. `for-of` 迭代 Map → `forEach`；无参 `catch {}` → `catch (e)`
5. `unknown` → `Object`；`ReturnType<typeof setTimeout>` → `number`
6. 默认 `wsFactory` 从浏览器 `new WebSocket(url)` → `createOhosWs(url)`
7. 上游注释里的「不可达」防御性守卫**原样保留**——它们是竞态文档，不是死代码
8. `localStorage` → `preferences`（`initStorage(context)` 先行；存储操作 try/catch 包裹——凭据失败只降级不崩配对流程）

## 尚未过筛（后续按需）

- `api.ets` / `types.ets` 按需扩容：会话页接入时补 `load_messages`/`send_message` 与 `ChatMessageItem`/`HistoryBlock`/`LoadMessagesResult`
- `utils/`、`chat/`——随会话页一起（transcriptMapping 等）
- 注意：过筛 `pagination.hydrate` 语义时必须带 d88dd73c 的修复（失败回滚 hydrated），上游旧版有状态粘滞 bug

## 验证状态

- `transport` / `remote` / `link/*` / `ws-ohos` / `storage` / `api` / `types` 已通过 hvigor 编译（ArkTS 零告警，API 12 兼容）。
- `link/` 纯模块（backoff / frames / attempt）有 ohosTest 单测安全网：`entry/src/ohosTest/ets/test/`（hypium，FakeWs 模拟 WsLike，10ms 级时钟压缩）。真机命令：`hdc shell aa test -b com.aide.ohos -m entry_test -s unittest OpenHarmonyTestRunner`。

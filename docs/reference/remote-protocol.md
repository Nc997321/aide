# 远程协议：relay 层帧契约与连接生命周期

**地位**：relay-server（哑管道）唯一理解的帧 = 本文件所列；之外的字节一律原样桥接。
桌面 RPC/事件层契约（REGISTRY 白名单、双通道）见 CLAUDE.md 多端一致性红线，不在本文范围。

**三端义务**：relay-server ↔ `packages/aide-sdk/src/remote.ts`（PWA）↔ `ohos/entry/src/main/ets/sdk/remote.ets`（鸿蒙）。
新增/修改本文件任何帧 = 三端同步；ohos 为过筛镜像，转换规则见 `ohos/.../sdk/README.md`。

## 帧表

| 帧 | 方向 | 阶段 | 语义 |
|---|---|---|---|
| `{type:"register",device_id,pairing_code}` | 桌面→relay | 首消息 | 登记路由 + 首次码宣告 |
| `{type:"connect",code}` 或 `{type:"connect",device_id,token?}` | 手机→relay | 首消息 | 码路由 / 设备路由认领桌面连接 |
| `{type:"update_code",code}` | 桌面→relay | 连接中途 | 换码宣告（设置面板「刷新」）。watcher 与 bridge 循环都消费，**不转发** |
| `{type:"keepalive"}` | 手机→relay | 桥接期 | 手机腿活体帧；relay 消费不转发；**首帧武装静默超时**（opt-in） |
| WS Ping / Pong | relay↔桌面 | 桥接期 | 桌面腿活体；relay 发 Ping，tungstenite 自动回 Pong；**Pong 消费不转发** |
| `{type:"connect_error",reason}` | relay→手机 | 关连接前 | 原因帧，send→flush→2s 超时 close 后关连接 |

`connect_error.reason` 取值（封闭枚举，`relay-server/src/protocol.rs` ConnectErrorReason）：

| reason | 触发 | 手机侧应做 |
|---|---|---|
| `unknown_code` | 码路由未命中（码错 / 过期 / 桌面未上报） | 回配对屏报码错，**停止重试** |
| `device_offline` | 设备不在路由表 / 桌面腿死亡 / 被新 register 顶代 | 忽略或按离线退避重试 |
| `superseded` | 被新 connect 顶替（last-connect-wins） | 回 idle **停止重试**（防互踢循环） |

帧文本逐字节确定：`connect_error` 手写 format!（serde_json 默认 BTreeMap 会重排键序，三端按字符串对账）。

## 常量（`relay-server/src/protocol.rs`，测试可经 `LivenessCfg` 注入短值）

| 常量 | 值 | 语义 |
|---|---|---|
| `CODE_TTL_SECS` | 600 | 码路由 TTL，对齐桌面 `PairingState` 10 分钟；惰性过期 |
| `PHONE_SILENCE_SECS` | 60 | 手机腿静默超时；**仅首帧 keepalive 后武装** |
| `DESKTOP_PING_SECS` | 30 | 桌面腿 Ping 间隔 |
| `DESKTOP_PING_MAX_MISS` | 3 | 连续 miss 判桌面腿死 |

## 码路由生命周期（单一事实源 = 桌面宣告 + TTL）

- 进出只经 `register` / `update_code`（`RelayState::announce_code`）；**桥接结束不删路由**
  （旧实装 teardown 删光 → 桌面仍展示的未过期码会话一结束即失效）。
- 同码 + 同设备重宣告保留原宣告时刻（TTL 对齐码生成时刻，不被 relay 重连续期）。
- 跨设备码碰撞 last-wins：新设备获独立 TTL；碰撞只混淆不越权（配对终验在桌面
  `relay_client` 的 `PairingState::validate`）。
- 桌面换码上报通道 = `CodeAnnouncer`（`src-tauri/src/remote/mod.rs`）：latest-wins 暂存 +
  Notify 唤醒；`connect_once` 读码前 `clear_pending` 防断连期积压的旧码在 register 之后
  发出清掉新码。**无连接态门控**（门控会在「读码→set_connected」窗口 reintroduce 不上报 bug）。

## 桥接生命周期（last-connect-wins + 双向活体）

- 桥接期设备**仍在路由表**（新代 + 新 claim 通道）：第二条 connect = supersede——
  旧桥交还桌面半对、旧手机腿收 `superseded` 被关（旧实装桥接期摘登记 → 重连一律
  device offline，手机切网/锁屏后分钟级连不上）。
- 桥接期同 device_id 新 register（桌面重连）= Replaced：旧桥 claim 通道被顶，旧手机腿
  收 `device_offline` 被关；新登记立即可认领。
- 手机腿：keepalive 首帧武装 60s 静默超时，武装后任何帧重置；超时 = 手机腿死 →
  桌面半连接重挂。**opt-in**：不发 keepalive 的老客户端不启用超时（部署顺序无关）。
- 桌面腿：30s Ping / Pong 清零 / 3 次 miss = 桌面腿死 → 手机腿收 `device_offline`
  （合盖静默丢包不再劫持手机）。
- teardown 重挂守卫：仅 `desktop_alive && !devices.contains_key`（桥接期间的新登记
  不被旧半连接覆盖成僵尸）。
- 两腿解析失败的帧一律原样转发（哑管道契约）。

## 排查指引

- 手机「配对码无效或已过期」= 桌面层拒（码过期/错）；手机「offline 重试」却配不上 =
  relay 层拒或桥接劫持——先看 relay 日志 `relay-server/relay.err.log` 的
  `registered/bridging/connect ->` 三行。手动起走 `relay-server/run.ps1` / `run.sh`；
  开机自启走 `~/.aide/remote/start-remote.vbs`（ASCII-only 文件，勿写非 ASCII 字节）——
  两条路径都固定落该日志文件，与 cwd 无关。
- 手机没连时桌面仍全量转发事件（设计如此），relay 逐帧丢弃；**丢帧日志已限频**：
  `idle device … dropped` 每设备每 60s 一条、带 `suppressed N`，`grep "sent data frame, dropped"`
  仍可统计。**relay 热路径（每帧/每连接）新增日志必须过限频器并保留 grep 指纹**——2026-09-12
  两份实证：`registered device` 洪流 1.9GB（3757 万行，桌面重连热循环）、丢帧日志 ~5 条/秒；
  范式见 `handler.rs` 的 `IdleDropLog`。
- 桌面设置面板码显示「—」= `PairingState` 过期（10 分钟），点刷新即触发 update_code 上报。

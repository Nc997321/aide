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

- **「手机连不上」先分三段**（2026-09-12 定型）：① nginx `logs/access.log` **有没有记录**——
  一条都没有 = 手机侧（DNS / 链路）根本没发出，别在服务端找；到了但 101 后立刻断 =
  relay / 配对层。**400 行即时落盘、101 行在连接关闭时才落盘**（nginx 对 upgrade 长连接
  的 access log 在 close 时写，状态码后的数字 = 该连接生命周期累计字节，如 `101 22127`
  = 一条传过 22KB 的已死连接）——判「是否已连上」别等 101 行，用 relay 日志 `bridging
  phone` 行计数或手机 netstat 对照。② 该日志格式已带 `$http_host`（紧跟 `"$request"` 的引号字段，形如
  `"home.aideai.store:8000"` 或 `"[2409:…]:8000"`），**直接区分「按域名来」还是「按字面量来」**
  （改动 2026-09-12 之前的行没有该字段）。③ 域名不通而字面量通 = 解析路径（运营商 / 光猫
  DNS 缓存旧 AAAA）出问题，与 relay / nginx / 防火墙无关；本机对照 `nslookup -type=AAAA`
  走光猫 vs `nslookup … 223.5.5.5`。域名只有 AAAA 记录（无 A），任何过时缓存 = 直接连不上。
  **典型形态是间歇性**（换解析节点 / 缓存过期即自愈）：「刚刚不行、现在又行了」≠ 修好了。
- **② 的判读（2026-09-12 DoH 直连上线 + 真机实测定型）**：手机 app 连接前先走 DoH（阿里公共
  解析 `dns.alidns.com`）取字面量直连，域名降为兜底（仅 `ws://`）。但**ohos webSocket 栈对
  v6 字面量 URL 生成的 Host 头不带方括号**（形如 `"2409:…:8000"`），nginx 按规范回 400——
  且 `WebSocketRequestOptions.header` 自定义 Host 被 netstack 无视（实测无法客户端修正），
  **服务端对该 400 永远无责，别在 nginx/relay 上找**。ohos 栈对被拒握手不回调 close/error，
  唯一感知路径是客户端 15s 握手看门狗，强杀时计入 DoH 熔断（10min）→ 下一跳自动回落域名。
  **2026-09-13 起 app 对 v6 解析结果直接跳过字面量直连**（doh.ets：解析出 v6 → 直接走
  域名——该探测对本部署注定 400、白烧 15s 握手看门狗且用户可感；v4 字面量保留直连探测，
  无方括号问题）。故判读：**域名 Host 101 = 健康态**；**孤立字面量 Host 400 = 旧版本
  app**（新版冷启动不再探 v6，v4 场景另议）→ 升级客户端。客户端侧对照指纹：hilog
  `[doh]`（新版命中 `解析为 v6，跳过字面量直连…走域名`；旧版命中 `-> 字面量直连` /
  `直连失败，熔断期内回落`）。上一条「域名不通而字面量通 = 解析路径问题」的判读，此后
  仅适用于手动 nslookup 对照排查（app 产生的字面量 400 不指示解析问题）。
- **「锁屏后必重连」→「锁屏播报待命」（2026-09-12 定型 / 09-13 待命上线）**：手机腿 20s
  keepalive 帧由 app 进程发出；熄屏后鸿蒙资源调度冻结整个进程 → keepalive 断供 → relay 60s
  静默超时清腿（冻结还会主动掐 TCP：doze 事件后 ~3s nginx 即出 101 死亡行）。**长时任务借道
  逐一实测**：`MULTI_DEVICE_CONNECTION` 授予后 ~60s 被行为校验取消（自建 relay WS 非 softbus
  分布式链路；指纹 `OnContinuousTaskStop … cancelReason 2` → `DOZE_AFTER_CONTINUOUS_TASK_FINISH`
  → `NORMAL_FREEZE_AFTER_DOZE`）；`AUDIO_PLAYBACK` 纯待命同样 +60s 被查（指纹
  `TASK_DETECTION backgroundMode:2` → `OnContinuousTaskAudioStateChange state=1` →
  `cancelReason 0` → `DOZE_BY_CONTINUOUS_DETECTION_FAILED`）——**任务只是资格，系统还要验
  行为**。但息屏后播报是真实需求（TtsModel `isBackStage` 后台 TTS 需要活进程），2026-09-13
  三轮实测打通「播报待命」：`AUDIO_PLAYBACK` 任务 + **180Hz 近静音正弦垫底音**
  （BroadcastStandby.ets；VOICE_ASSISTANT 单声道 16k S16LE，100ms 块恰 18 整周期无缝循环，
  峰值 300/32767 ≈ -40dB——手机喇叭物理放不出 180Hz，人耳不可闻但 RMS 非零；module.json5
  已重新声明 `backgroundModes: ["audioPlayback"]`）。三轮指纹：①无垫音 +60s `state=1` 取消；
  ②**全零垫音被静音播放检测器识破**——熄屏 +17s `DOZE_BY_SILENT_PLAYBACK` 直接冻结（cgroup
  `freezer:/Frozen` 实锤；微信有 `Doze has special:ERR_HAS_CONTINUOUS_TASK` 豁免，三方 app
  没有）；③180Hz 正弦垫——检测器静默、校验通过，熄屏 11 分钟进程未冻结、同一条 WS 零重连，
  且锁屏状态下 agent 回复到达 → `[tts] speak` → 出声播报（用户验收，firstSoundDelay 0.157s）。
  **安全约束**：垫音严格随任务启停（后台有音频无任务 = 被查杀）；`loadTtsEnabled()` 开（默认）
  才挂任务——播报关 = 无任务无垫音无打扰。**降级链**：垫音失败 → 纯任务仅 60s 容忍；任务被
  取消 → 垫音即停、回落冻结形态。**判读变化**：待命生效时熄屏**不再重连**（连接一直活着）；
  熄屏后仍见 bridging 递增 = 待命未生效（开关关 / 任务被取消 / 垫音失败）→ 查 hilog
  `standby task started` / `silent bed started`。冻结 + 秒级恢复仍是兜底：EntryAbility
  `onForeground` 见 `state === 'offline'` 即调 `connModel.autoConnect()` 立即重连（不等退避
  计时器——计时器随进程冻结迟到）；仅 offline 态触发，authed/connecting 活态不动（`connect()`
  会掐活连接）。2026-09-12/13 两次实测验收：解锁 → `Ability onForeground` → 毫秒级触发
  poke、秒级完成重连；其中一次为熄屏后 ~1 分钟连接已被掐死——蜂窝熄屏无线电休眠可**早于
  进程冻结**断 TCP，与冻结断供 keepalive 殊途同归，秒连方案两者通吃。另 Push Kit 勘误：后台
  数据消息到不了非前台 app（端侧缓存最多 7 天），push 唤不醒冻结进程——锁屏播报唯一真解
  是长时任务 + 垫音。
- **「卡 connecting 永不动」僵死（2026-09-12 发现 / 09-13 修复，指纹归档）**：app 停在
  `connecting` 十几分钟不动（UI 可点、无 crash、无日志流动）；手机 netstat 对 relay TCP
  ESTABLISHED 但**服务器视角零字节**——HTTP 升级请求从未发出。根因 = ohos netstack 对
  「TCP 已建立但握手管道卡死」的 socket，`close()` **同步抛异常**（对比：被 400 拒的
  socket `close()` 只走回调报错、不同步抛）→ 异常裸穿 remote.ets 看门狗回调 → 状态机
  后续（setState('offline') / scheduleReconnect）永不执行 → 永久卡死。修复 = ws-ohos.ets
  适配层 startConnect / send / close 三处 try/catch 兜住同步异常（close 抛 → 捕获记
  日志，状态机照常走 offline → 退避重连），remote.ets 镜像零改动。指纹：**15s 看门狗
  到期后无任何后续日志** = 老版本此 bug 实锤 → 升级客户端（2026-09-13 构建起已防护）。
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

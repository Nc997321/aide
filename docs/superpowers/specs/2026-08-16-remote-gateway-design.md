# 设计:远程控制网关(Remote Gateway)

**日期**:2026-08-16
**状态**:已确认(分节设计逐节通过)
**关联**:`docs/discussions/2026-07-09-sidecar-sse-streaming-architecture.md`(方案 B 的 LAN 版思路)、记忆条 `aide-session-init-freeze-rootcause.md`(前端路径不可轻动)。

---

## 1. 要做什么

做一个**手机端 APP(PWA 先行)**远程控制电脑上的 aide:人在外面时,通过手机发消息给桌面 aide、看流式回复、看历史会话。桌面端零额外软件——网关内置在 aide 里;跨公网走**自建云中继**(哑管道),不需要公网 IP、不需要路由器端口转发(CGNAT 也能用)。

## 2. 已确认的产品决策

| 决策 | 结论 |
|---|---|
| 使用场景 | 人在外面远程控制(跨公网) |
| 控制范围 | 只发消息看回复 + 历史会话 |
| 权限模型 | 远程会话自动批准(复用现有 permission_mode,可配置) |
| 跨网方案 | 云中继,自建 VPS 部署 |
| 客户端形态 | 先 Web/PWA 验证闭环,后续可 ArkTS 包原生壳(协议不变) |
| 网关实现 | **Rust 内置**(方案 1),Node 零改动 |
| 测试布局 | 测试代码与源代码分离(`tests/` 目录,源文件零测试代码) |

## 3. 总体架构

```
┌─ 手机 PWA ──────────────┐      ┌─ VPS ──────────────┐      ┌─ 桌面 aide ──────────────────────┐
│ 聊天 UI(发消息/流式/历史) │ ─WS→ │ 中继服务器(哑管道)  │ ←WS─ │ Rust 网关(出站客户端)           │
│ 配对码输入 / token 存储   │      │ 路由 + 桥接         │      │  ├ relay_client(重连/心跳)      │
└─────────────────────────┘      └────────────────────┘      │  ├ bridge(命令/事件桥)          │
                                                              │  └ auth(配对/token)             │
                                                              │        │ 复用 send_to_runtime     │
                                                              │        ▼                          │
                                                              │  sidecar(Node,零改动)          │
                                                              └──────────────────────────────────┘
```

**发消息数据流**:
1. 手机 PWA 发 `send_message` → WS → 中继 → 桌面网关
2. 网关映射成现有 sidecar 命令 → `send_to_runtime` 写 stdin(`src-tauri/src/runtime/mod.rs:345` 现成通道)
3. sidecar 驱动 SDK,事件走 stdout → worker → **broadcast 扇出**(新增)
4. 网关订阅 broadcast → 经中继推给手机(text_delta 流式渲染)
5. 桌面端 UI 同时收到同样事件(前端 poll 缓冲**不动**)——手机发起的会话在桌面端也可见,这是特性

**历史数据流**:手机 `load_messages` → 网关 → sidecar 现有命令 → 返回 JSON

## 4. 中继服务器(`relay-server/`)

- 独立小服务,Rust + tokio-tungstenite,~200 行,部署到用户 VPS
- **哑管道**:不理解协议,只做两件事:
  - 路由表:`配对码 → 桌面连接`、`device_id → 桌面连接`
  - 桥接:手机连接与桌面连接之间双向转发 WS 帧
- 状态纯内存(无持久化;重启丢路由表,桌面端自动重连即恢复)
- TLS:Caddy 反代自动证书(推荐)或 rustls 直挂,部署细节实施时定
- 测试:路由/桥接单元测试 + 双客户端集成测试(`relay-server/tests/`)

## 5. 桌面端网关(`src-tauri/src/remote/`)

| 模块 | 职责 |
|---|---|
| `relay_client.rs` | 出站 WS 连中继;断线重连(指数退避 + 心跳);客户端走 wss(TLS 由中继侧终止) |
| `bridge.rs` | 协议桥:手机消息 → `send_to_runtime` 命令;sidecar 事件 → 中继推送。**协议解析/序列化做成独立纯函数模块**(可测性) |
| `auth.rs` | 配对码生成/验证、token 签发/吊销 |
| `mod.rs` | 生命周期:随 app 启动/停止,设置开关控制 |

**事件扇出**:worker 现在只推前端 poll 缓冲(`Arc<Mutex<VecDeque>>`)。新增 `tokio::sync::broadcast`:worker 同时推广播,网关订阅后经中继推给手机。**前端路径一行不动**(冻结史教训:不碰已验证的路径)。

**设置**:设置面板加"远程控制"tab——开关、中继 URL、配对码显示(10 分钟轮换)、已配对设备列表(可吊销)。

## 6. 协议 + 认证

**协议**(JSON 消息,风格对齐现有 sidecar 协议,经中继桥接):

手机 → 桌面:
- `send_message`(无 session_id 新建会话,有则续会话;带 `permission_mode` 注入)
- `load_messages`(历史)
- `list_sessions`(会话列表——手机端"看历史"需要)

桌面 → 手机:
- `event`(ChatEvent 流:text_delta / tool_use / message_stop…)
- `pair_ok` / `auth_error` 等控制消息

**配对流程**:
1. 桌面端设置面板显示配对码(6 位数字,10 分钟轮换)
2. 手机输入配对码 → 连中继 → 中继按配对码路由到桌面 → 桌面验证码 → 签发长期 token + device_id 给手机
3. 之后手机用 `{device_id, token}` 连接,无需再配对;桌面端可一键吊销

**中继保持哑管道**:只维护路由表(配对码/device_id → 连接),不理解协议内容。

## 7. 权限(远程会话自动批准)

**复用现有机制,sidecar 改动极小**:

- 网关在 `send_message` 命令里注入 `permission_mode`(`agent-sidecar/src/session-worker.ts:814` 已有 `if (cmd.permission_mode) this.applyPermissionMode(...)` 现成路径)
- 远程会话默认注入 `"auto"`(自动批准非危险工具);设置里可配置为 `acceptEdits`(编辑类自动批准)等现有模式
- 桌面端 UI 对远程会话不弹权限框(人不在,弹了也没人点)——这是预期行为
- 自定义策略(只读批准/危险工具拒绝)v1 不做,列为后续——现有模式已覆盖 90% 需求

## 8. 错误处理

- 中继不可达 → 桌面端指数退避重连;手机端显示"设备离线"
- 断线重连后事件缺口 → 手机端重新 `load_messages` 拉历史补齐(**不做** Last-Event-ID 回放,YAGNI)
- sidecar 崩溃 → 现有看门狗重启机制不变,网关命令通道恢复后继续
- 配对码过期 → 手机重新配对

## 9. 测试策略(分离布局)

**测试代码与源代码分离,源文件零测试代码**:

- 中继:路由/桥接单元测试 + 双客户端集成测试(`relay-server/tests/`)
- 网关:协议解析/序列化纯函数测试、命令桥映射测试、配对流程测试(`src-tauri/tests/`)
- 权限:sidecar 侧远程模式测试(现有 vitest 体系)
- 说明:Rust 分离后只能测公开 API——对网关/中继这种协议驱动组件,公开 API 就是协议消息,测试面天然完整;纯内部逻辑(配对码生成、帧解析)做成独立纯函数模块导出

## 10. 范围(YAGNI 明确不做)

- 会话管理 UI、文件树、设置、后台任务、权限审批 UI
- E2E 加密(TLS 到中继 + token 足够,中继是自己的 VPS;列为未来选项)
- 多设备(一个桌面 + 一个手机)
- 事件回放(重连后 load_messages 补齐)
- 现有 sidecar `*.test.ts` 迁移到分离布局(机械活,另开任务)

## 11. 未来选项

- 手机端 ArkTS 原生壳(协议不变,重写 UI)
- 自定义权限策略(只读批准/危险工具拒绝)
- E2E 加密(中继不可信场景)
- 多设备/多桌面

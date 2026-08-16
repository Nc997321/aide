# 远程控制网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机 PWA 通过自建云中继远程控制桌面 aide——发消息、看流式回复、看历史会话。

**Architecture:** 桌面 aide 内置 Rust 网关（出站 WS 连中继，复用现有 sidecar stdin 命令通道 + 事件流 broadcast 扇出）；中继服务器是哑管道（只路由+桥接，不理解应用协议）；远程会话注入 `permission_mode` 自动批准。Node sidecar 零改动。

**Tech Stack:** Rust（tokio-tungstenite / rand / futures-util）、Tauri v2、Vue 3（设置面板）、serde JSON 协议。

**Spec:** `docs/superpowers/specs/2026-08-16-remote-gateway-design.md`

## Global Constraints

- **测试与源代码分离**：Rust 测试全放 `src-tauri/tests/` 与 `relay-server/tests/`，源文件零测试代码（`#[cfg(test)] mod tests` 禁止新增）。
- **前端 chat-event 路径不动**：`src-tauri/src/runtime/mod.rs` 的 `app.emit("chat-event", event)` 保持原样，broadcast 是并行新增，不替换、不移动。
- **跨平台**：无平台特有代码（Windows/macOS/Linux 一致），不引入 `#[cfg(windows)]` 分支。
- **新 Tauri 命令全 async**：重 IO（设置读写）走 `spawn_blocking`，遵守「同步 command 禁止重 IO」红线。
- **中继是哑管道**：`relay-server` 不理解应用协议（send_message/event 等），只做 register/connect 路由 + 双向帧转发。
- **Windows 杀软锁**：`cargo test` 若报文件锁错误，改用 `cargo test --lib` 或重试（见记忆条 aide-repo-quirks）。

---

### Task 1: relay-server 骨架 + 路由 + 桥接

**Files:**
- Create: `relay-server/Cargo.toml`
- Create: `relay-server/src/lib.rs`（组装层：`run` 接受循环 + 模块出口）
- Create: `relay-server/src/state.rs`（数据层：`RelayState` 路由表 + `SharedState`）
- Create: `relay-server/src/handler.rs`（处理层：`handle_conn` 单连接处理）
- Create: `relay-server/src/main.rs`
- Test: `relay-server/tests/bridge.rs`

**Interfaces:**
- Consumes: 无（独立服务）
- Produces: `aide_relay::run(listener: TcpListener, state: SharedState)`、`aide_relay::handle_conn(stream: TcpStream, state: SharedState) -> Result<(), String>`、`aide_relay::RelayState { devices: HashMap<String, (WsSink, WsStream)>, codes: HashMap<String, String> }`、`aide_relay::SharedState = Arc<Mutex<RelayState>>`

- [ ] **Step 1: 写失败测试**

`relay-server/tests/bridge.rs`:

```rust
use aide_relay::state::RelayState;
use aide_relay::run;
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

async fn start_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state: Arc<Mutex<RelayState>> = Arc::new(Mutex::new(RelayState::default()));
    tokio::spawn(async move { run(listener, state).await; });
    format!("ws://{addr}")
}

#[tokio::test]
async fn bridges_frames_between_desktop_and_phone() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-1","pairing_code":"123456"}"#.into())).await.unwrap();
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","code":"123456"}"#.into())).await.unwrap();
    // 手机 → 桌面
    p_ws.send(Message::Text("hello-desktop".into())).await.unwrap();
    let msg = d_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("hello-desktop".into()));
    // 桌面 → 手机
    d_ws.send(Message::Text("hello-phone".into())).await.unwrap();
    let msg = p_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("hello-phone".into()));
}

#[tokio::test]
async fn connect_by_device_id_after_pairing() {
    let url = start_server().await;
    let (mut d_ws, _) = connect_async(&url).await.unwrap();
    d_ws.send(Message::Text(r#"{"type":"register","device_id":"dev-2","pairing_code":"654321"}"#.into())).await.unwrap();
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","device_id":"dev-2","token":"opaque"}"#.into())).await.unwrap();
    p_ws.send(Message::Text("ping".into())).await.unwrap();
    let msg = d_ws.next().await.unwrap().unwrap();
    assert_eq!(msg, Message::Text("ping".into()));
}

#[tokio::test]
async fn connect_to_unknown_device_closes() {
    let url = start_server().await;
    let (mut p_ws, _) = connect_async(&url).await.unwrap();
    p_ws.send(Message::Text(r#"{"type":"connect","code":"000000"}"#.into())).await.unwrap();
    let next = p_ws.next().await;
    assert!(next.is_none() || next.unwrap().is_err());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd relay-server && cargo test`
Expected: FAIL——`aide_relay` crate 不存在（`relay-server/` 目录还不存在）。

- [ ] **Step 3: 建 crate 骨架**

`relay-server/Cargo.toml`:

```toml
[package]
name = "aide-relay"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
tokio-tungstenite = "0.24"
futures-util = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

`relay-server/src/state.rs`（数据层——路由表，无逻辑）：

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use futures_util::stream::{SplitSink, SplitStream};

pub type Ws = WebSocketStream<TcpStream>;
pub type WsSink = SplitSink<Ws, Message>;
pub type WsStream = SplitStream<Ws>;

/// 路由表：device_id → 桌面连接（split 后的 sink/stream）；pairing_code → device_id。
/// 哑管道——不理解应用协议，只做路由 + 双向帧转发。
#[derive(Default)]
pub struct RelayState {
    pub devices: HashMap<String, (WsSink, WsStream)>,
    pub codes: HashMap<String, String>,
}

pub type SharedState = Arc<Mutex<RelayState>>;
```

`relay-server/src/handler.rs`（处理层——单连接处理）：

```rust
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::state::SharedState;

/// 单连接处理：首条消息必须是 register（桌面）或 connect（手机）。
pub async fn handle_conn(stream: TcpStream, state: SharedState) -> Result<(), String> {
    let ws = accept_async(stream).await.map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let first = stream.next().await.ok_or("closed before first message")?
        .map_err(|e| e.to_string())?;
    let text = match first {
        Message::Text(t) => t.to_string(),
        _ => return Err("first message must be text".into()),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    match v.get("type").and_then(|t| t.as_str()) {
        Some("register") => {
            let device_id = v.get("device_id").and_then(|s| s.as_str())
                .ok_or("register: missing device_id")?.to_string();
            let code = v.get("pairing_code").and_then(|s| s.as_str())
                .ok_or("register: missing pairing_code")?.to_string();
            {
                let mut st = state.lock().unwrap();
                st.devices.insert(device_id.clone(), (sink, stream));
                st.codes.insert(code.clone(), device_id.clone());
            }
            eprintln!("registered device {device_id}");
            Ok(())
        }
        Some("connect") => {
            let device_id = if let Some(code) = v.get("code").and_then(|s| s.as_str()) {
                state.lock().unwrap().codes.get(code).cloned()
            } else {
                v.get("device_id").and_then(|s| s.as_str()).map(|s| s.to_string())
            };
            let device_id = device_id.ok_or("connect: unknown device")?;
            let (mut d_sink, mut d_stream) = state.lock().unwrap()
                .devices.remove(&device_id)
                .ok_or("connect: device offline")?;
            eprintln!("bridging phone -> {device_id}");
            // 双向转发：任一侧断开，另一侧 sink 写失败即退出
            let f1 = tokio::spawn(async move {
                while let Some(Ok(msg)) = d_stream.next().await {
                    if sink.send(msg).await.is_err() { break; }
                }
            });
            let f2 = tokio::spawn(async move {
                while let Some(Ok(msg)) = stream.next().await {
                    if d_sink.send(msg).await.is_err() { break; }
                }
            });
            let _ = tokio::join!(f1, f2);
            // 桥接结束：清掉配对码路由（设备下次重连会重新 register）
            state.lock().unwrap().codes.retain(|_, v| v != &device_id);
            Ok(())
        }
        _ => Err("unknown first message type".into()),
    }
}
```

`relay-server/src/lib.rs`（组装层——接受循环 + 模块出口）：

```rust
pub mod handler;
pub mod state;

use state::SharedState;
use tokio::net::TcpListener;

/// 接受循环：每个连接一个任务。
pub async fn run(listener: TcpListener, state: SharedState) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => { eprintln!("accept error: {e}"); continue; }
        };
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handler::handle_conn(stream, state).await {
                eprintln!("relay conn error: {e}");
            }
        });
    }
}
```

`relay-server/src/main.rs`:

```rust
use aide_relay::state::{RelayState, SharedState};
use aide_relay::run;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind relay addr");
    eprintln!("aide-relay listening on {addr}");
    let state: SharedState = Arc::new(Mutex::new(RelayState::default()));
    run(listener, state).await;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd relay-server && cargo test`
Expected: 3 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add relay-server/
git commit -m "feat(relay): 哑管道中继服务器——register/connect 路由 + 双向桥接 + 集成测试"
```

---

### Task 2: 协议类型 + 认证模块 + RemoteSettings 类型

**Files:**
- Modify: `src-tauri/Cargo.toml`（加 tokio-tungstenite / rand / futures-util）
- Create: `src-tauri/src/remote/mod.rs`
- Create: `src-tauri/src/remote/protocol.rs`（协议层：纯数据）
- Create: `src-tauri/src/remote/auth.rs`（认证层：PairingState + TokenStore）
- Modify: `src-tauri/src/commands/settings.rs`（RemoteSettings struct + AppSettings.remote 字段 + Default——提前到本任务定义，Task 4 的 bridge/relay_client 依赖它）
- Test: `src-tauri/tests/remote_protocol.rs`
- Test: `src-tauri/tests/remote_auth.rs`
- Test: `src-tauri/tests/remote_settings.rs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `aide::remote::protocol::PhoneToDesktop`（serde tag="type" snake_case：`Pair{code}` / `Auth{token}` / `SendMessage{session_id: Option<String>, prompt}` / `LoadMessages{session_id}` / `ListSessions`）
  - `aide::remote::protocol::DesktopToPhone`（serde tag="type" snake_case：`PairOk{device_id, token}` / `AuthOk` / `AuthError{message}` / `Event{event: Value}` / `Error{message}` / `Sessions{sessions: Value}` / `Messages{messages: Value}`）
  - `aide::remote::auth::PairingState`（`new()` / `from_parts(code, expires_at)` / `refresh() -> String` / `current() -> Option<String>` / `validate(code) -> bool` / `ensure_valid() -> String`）
  - `aide::remote::auth::TokenStore`（`new(service: Arc<SettingsService>)` / `issue() -> Result<String, String>` / `validate(token) -> bool` / `revoke() -> Result<(), String>` / `device_id() -> Result<String, String>`）
  - `aide::remote::auth::generate_token() -> String`（32 字节 hex）
  - `aide::remote::auth::generate_device_id() -> String`（16 字节 hex）
  - `crate::commands::settings::RemoteSettings { enabled, relay_url, device_id, permission_mode }`（serde camelCase，`Default` 实现：enabled=false / relayUrl="" / deviceId="" / permissionMode="auto"）

- [ ] **Step 1: 写失败测试**

`src-tauri/tests/remote_protocol.rs`:

```rust
use aide::remote::protocol::{PhoneToDesktop, DesktopToPhone};

#[test]
fn parses_send_message_with_session() {
    let msg: PhoneToDesktop = serde_json::from_str(
        r#"{"type":"send_message","session_id":"s1","prompt":"hi"}"#,
    ).unwrap();
    match msg {
        PhoneToDesktop::SendMessage { session_id, prompt } => {
            assert_eq!(session_id.as_deref(), Some("s1"));
            assert_eq!(prompt, "hi");
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn parses_send_message_without_session() {
    let msg: PhoneToDesktop = serde_json::from_str(
        r#"{"type":"send_message","prompt":"hi"}"#,
    ).unwrap();
    match msg {
        PhoneToDesktop::SendMessage { session_id, .. } => assert!(session_id.is_none()),
        _ => panic!("wrong variant"),
    }
}

#[test]
fn parses_pair_and_auth() {
    let pair: PhoneToDesktop = serde_json::from_str(r#"{"type":"pair","code":"123456"}"#).unwrap();
    assert!(matches!(pair, PhoneToDesktop::Pair { code } if code == "123456"));
    let auth: PhoneToDesktop = serde_json::from_str(r#"{"type":"auth","token":"abc"}"#).unwrap();
    assert!(matches!(auth, PhoneToDesktop::Auth { token } if token == "abc"));
}

#[test]
fn parses_load_messages_and_list_sessions() {
    let lm: PhoneToDesktop = serde_json::from_str(r#"{"type":"load_messages","session_id":"s1"}"#).unwrap();
    assert!(matches!(lm, PhoneToDesktop::LoadMessages { session_id } if session_id == "s1"));
    let ls: PhoneToDesktop = serde_json::from_str(r#"{"type":"list_sessions"}"#).unwrap();
    assert!(matches!(ls, PhoneToDesktop::ListSessions));
}

#[test]
fn serializes_pair_ok() {
    let reply = DesktopToPhone::PairOk { device_id: "d1".into(), token: "t1".into() };
    let s = serde_json::to_string(&reply).unwrap();
    assert!(s.contains("\"type\":\"pair_ok\""));
    assert!(s.contains("\"device_id\":\"d1\""));
}
```

`src-tauri/tests/remote_auth.rs`:

```rust
use aide::remote::auth::{PairingState, generate_token, generate_device_id};
use std::time::{Duration, Instant};

#[test]
fn refresh_generates_six_digit_code() {
    let mut p = PairingState::new();
    let code = p.refresh();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
}

#[test]
fn validate_accepts_current_code() {
    let mut p = PairingState::new();
    let code = p.refresh();
    assert!(p.validate(&code));
}

#[test]
fn validate_rejects_wrong_code() {
    let mut p = PairingState::new();
    p.refresh();
    assert!(!p.validate("000000"));
}

#[test]
fn validate_rejects_expired_code() {
    let p = PairingState::from_parts("123456".into(), Instant::now() - Duration::from_secs(1));
    assert!(!p.validate("123456"));
}

#[test]
fn ensure_valid_refreshes_when_expired() {
    let mut p = PairingState::from_parts("123456".into(), Instant::now() - Duration::from_secs(1));
    let code = p.ensure_valid();
    assert_ne!(code, "123456");
    assert_eq!(code.len(), 6);
}

#[test]
fn token_and_device_id_are_hex() {
    let t = generate_token();
    assert_eq!(t.len(), 64);
    assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    let d = generate_device_id();
    assert_eq!(d.len(), 32);
    assert!(d.chars().all(|c| c.is_ascii_hexdigit()));
}

// TokenStore 不写专门测试：它是 secrets()/settings 的 IO 薄层（每方法 1-3 行），
// 集成测试无法构造 SettingsService（MemorySecretStore 是 #[cfg(test)] 导出，
// 集成测试 crate 里不可见；真实 KeyringSecretStore 会碰用户 keychain）。
// 其行为由 Task 5 的 remote_get_status 手动验证覆盖。
```

`src-tauri/tests/remote_settings.rs`:

```rust
use aide::commands::settings::{AppSettings, RemoteSettings};

#[test]
fn remote_settings_serde_roundtrip() {
    let s = RemoteSettings {
        enabled: true,
        relay_url: "wss://relay.example.com".into(),
        device_id: "abc".into(),
        permission_mode: "auto".into(),
    };
    let json = serde_json::to_string(&s).unwrap();
    let back: RemoteSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.enabled, true);
    assert_eq!(back.relay_url, "wss://relay.example.com");
    assert_eq!(back.permission_mode, "auto");
    // camelCase 序列化
    assert!(json.contains("\"relayUrl\""));
}

#[test]
fn app_settings_remote_defaults() {
    // 缺省时 remote 字段用默认值（enabled=false / permissionMode="auto"）
    let s: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
    assert_eq!(s.remote.enabled, false);
    assert_eq!(s.remote.permission_mode, "auto");
    assert_eq!(s.remote.relay_url, "");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test remote_protocol --test remote_auth --test remote_settings`
Expected: FAIL——`aide::remote` 模块与 `RemoteSettings` 类型不存在。

- [ ] **Step 3: 加依赖 + 建模块**

`src-tauri/Cargo.toml` 的 `[dependencies]` 追加：

```toml
# 远程控制网关：出站 WS 客户端（连自建中继）
tokio-tungstenite = "0.24"
futures-util = "0.3"
# 配对码 / token / device_id 生成
rand = "0.8"
```

`src-tauri/src/remote/mod.rs`:

```rust
pub mod auth;
pub mod protocol;
```

`src-tauri/src/remote/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 手机 → 桌面（经中继桥接的应用协议）。
/// 中继是哑管道，不理解这些消息——只做字节级转发。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneToDesktop {
    /// 首次配对：验证配对码
    Pair { code: String },
    /// 已配对：token 认证
    Auth { token: String },
    /// 发消息；无 session_id 时新建会话
    SendMessage { session_id: Option<String>, prompt: String },
    /// 拉历史
    LoadMessages { session_id: String },
    /// 会话列表
    ListSessions,
}

/// 桌面 → 手机
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopToPhone {
    PairOk { device_id: String, token: String },
    AuthOk,
    AuthError { message: String },
    /// 流式事件（ChatEvent 原样透传）
    Event { event: Value },
    /// 命令回执/错误
    Error { message: String },
    /// list_sessions / load_messages 的应答（现有命令结果原样透传）
    Sessions { sessions: Value },
    Messages { messages: Value },
}
```

`src-tauri/src/remote/auth.rs`:

```rust
use rand::Rng;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::settings::{SettingsError, SettingsScope, SettingsService};

/// 配对码状态：6 位数字，10 分钟有效，可轮换。
pub struct PairingState {
    code: String,
    expires_at: Instant,
}

impl PairingState {
    pub fn new() -> Self {
        Self { code: String::new(), expires_at: Instant::now() }
    }

    /// 测试构造：指定码 + 过期时刻（集成测试无法快进时钟）。
    pub fn from_parts(code: String, expires_at: Instant) -> Self {
        Self { code, expires_at }
    }

    /// 生成新 6 位数字配对码（10 分钟有效）。
    pub fn refresh(&mut self) -> String {
        let mut rng = rand::thread_rng();
        let code: u32 = rng.gen_range(0..1_000_000);
        self.code = format!("{code:06}");
        self.expires_at = Instant::now() + Duration::from_secs(600);
        self.code.clone()
    }

    /// 当前有效配对码（过期/未生成返回 None）。
    pub fn current(&self) -> Option<String> {
        if self.code.is_empty() || Instant::now() > self.expires_at {
            None
        } else {
            Some(self.code.clone())
        }
    }

    /// 校验配对码（过期即无效）。
    pub fn validate(&self, code: &str) -> bool {
        self.current().as_deref() == Some(code)
    }

    /// 返回当前有效码；过期/为空则刷新。中继重连时调用，避免配对中途换码。
    pub fn ensure_valid(&mut self) -> String {
        match self.current() {
            Some(code) => code,
            None => self.refresh(),
        }
    }
}

/// 长期 token 存储：签发/校验/吊销 + 设备身份。secrets 访问内聚在本层。
/// 每个方法都是 secrets()/settings 的薄封装（1-3 行 IO），不写专门测试
/// （集成测试无法构造 SettingsService，见 tests/remote_auth.rs 注释）。
pub struct TokenStore {
    service: Arc<SettingsService>,
}

impl TokenStore {
    pub fn new(service: Arc<SettingsService>) -> Self {
        Self { service }
    }

    /// 签发长期 token 并持久化（覆盖旧 token = 吊销旧设备）。
    pub fn issue(&self) -> Result<String, String> {
        let token = generate_token();
        self.service.secrets().set("remote/token", &token).map_err(|e| e.to_string())?;
        Ok(token)
    }

    /// 校验 token（与 secrets 中存储的比对）。
    pub fn validate(&self, token: &str) -> bool {
        self.service.secrets().get("remote/token").ok().flatten().as_deref() == Some(token)
    }

    /// 吊销所有远程设备（清 token）。
    pub fn revoke(&self) -> Result<(), String> {
        self.service.secrets().delete("remote/token").map_err(|e| e.to_string())
    }

    /// 读取/生成 device_id（持久化到 settings.remote.deviceId）。
    pub fn device_id(&self) -> Result<String, String> {
        let service = self.service.clone();
        let existing = tokio::task::spawn_blocking(move || {
            let doc = service.effective_document_blocking(None).map_err(|e| e.to_string())?;
            Ok::<_, String>(doc.values.get("settings")
                .and_then(|s| s.get("remote"))
                .and_then(|r| r.get("deviceId"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default())
        }).await.map_err(|e| e.to_string())??;
        if !existing.is_empty() {
            return Ok(existing);
        }
        let id = generate_device_id();
        let service = self.service.clone();
        let id2 = id.clone();
        tokio::task::spawn_blocking(move || {
            service.mutate_scope_blocking(SettingsScope::User, None, |document| {
                let target = document.values.entry("settings".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                let target = target.as_object_mut().ok_or_else(|| {
                    SettingsError::Validation("settings must be an object".to_string())
                })?;
                let remote = target.entry("remote".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                remote["deviceId"] = serde_json::json!(id2);
                Ok(())
            }).map_err(|e| e.to_string())
        }).await.map_err(|e| e.to_string())??;
        Ok(id)
    }
}

/// 长期 token（32 字节 hex，64 字符）。
pub fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// device_id（16 字节 hex，32 字符）——路由键，非机密。
pub fn generate_device_id() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 16] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
```

`src-tauri/src/commands/settings.rs` 改动：

1. `AppSettings` struct 加字段（`editor` 之后）：

```rust
    /// 远程控制网关配置（手机 APP 远程控制桌面 aide）。
    #[serde(default)]
    pub remote: RemoteSettings,
```

2. `Default` impl 加 `remote: RemoteSettings::default(),`。

3. 新 struct（`AppSettings` 定义之后）：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub relay_url: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default = "default_remote_permission_mode")]
    pub permission_mode: String,
}

fn default_remote_permission_mode() -> String { "auto".to_string() }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test remote_protocol --test remote_auth --test remote_settings`
Expected: 13 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/remote/ src-tauri/src/commands/settings.rs src-tauri/tests/remote_protocol.rs src-tauri/tests/remote_auth.rs src-tauri/tests/remote_settings.rs
git commit -m "feat(remote): 协议层 + 认证层（PairingState/TokenStore）+ RemoteSettings 类型（测试分离布局）"
```

---

### Task 3: 事件扇出 broadcast

**Files:**
- Modify: `src-tauri/src/runtime/mod.rs`（struct 加字段、new()、spawn_runtime worker、新方法）
- Modify: `src-tauri/src/lib.rs`（`mod runtime;` → `pub mod runtime;`）
- Test: `src-tauri/tests/runtime_broadcast.rs`

**Interfaces:**
- Consumes: 无
- Produces: `AgentRuntimeManager::subscribe_chat_events() -> tokio::sync::broadcast::Receiver<Value>`、`AgentRuntimeManager::chat_events_sender() -> tokio::sync::broadcast::Sender<Value>`（测试缝合）

- [ ] **Step 1: 写失败测试**

`src-tauri/tests/runtime_broadcast.rs`:

```rust
use aide::runtime::AgentRuntimeManager;
use serde_json::json;

#[tokio::test]
async fn subscribe_receives_events_from_channel() {
    let mgr = AgentRuntimeManager::new();
    let mut rx = mgr.subscribe_chat_events();
    let tx = mgr.chat_events_sender();
    tx.send(json!({"type": "text_delta", "delta": "hi"})).unwrap();
    let ev = rx.recv().await.unwrap();
    assert_eq!(ev["type"], "text_delta");
    assert_eq!(ev["delta"], "hi");
}

#[tokio::test]
async fn multiple_subscribers_each_get_events() {
    let mgr = AgentRuntimeManager::new();
    let mut rx1 = mgr.subscribe_chat_events();
    let mut rx2 = mgr.subscribe_chat_events();
    let tx = mgr.chat_events_sender();
    tx.send(json!({"type": "message_stop"})).unwrap();
    assert_eq!(rx1.recv().await.unwrap()["type"], "message_stop");
    assert_eq!(rx2.recv().await.unwrap()["type"], "message_stop");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_broadcast`
Expected: FAIL——`subscribe_chat_events` 方法不存在。

- [ ] **Step 3: 实现 broadcast 通道**

`src-tauri/src/runtime/mod.rs` 改动：

1. struct `AgentRuntimeManager` 加字段（`chat_events` 字段声明处，`sent_commands` 之后）：

```rust
    /// chat-event 广播：worker 读 sidecar stdout 后同时推这里，网关订阅后经中继
    /// 推给手机。前端路径（app.emit + poll 缓冲）不动，这是并行新增的扇出。
    chat_events: tokio::sync::broadcast::Sender<Value>,
```

2. `new()` 里初始化（`sent_commands: Arc::new(Mutex::new(Vec::new())),` 之后）：

```rust
        let (chat_events, _) = tokio::sync::broadcast::channel(1024);
        Self {
            // ... 现有字段 ...
            chat_events,
        }
```

3. `spawn_runtime` 里 worker 闭包 clone tx（`let tail_for_stderr = Arc::clone(&stderr_tail);` 附近）：

```rust
        let chat_events_tx = self.chat_events.clone();
```

4. worker 主循环里，`let _ = app.emit("chat-event", event);` 之前插入：

```rust
                        let _ = chat_events_tx.send(event.clone());
                        let _ = app.emit("chat-event", event);
```

5. 新方法（`send_to_runtime` 之后）：

```rust
    /// 订阅 chat-event 流（网关事件转发用）。broadcast 语义：慢消费者丢最旧。
    pub fn subscribe_chat_events(&self) -> tokio::sync::broadcast::Receiver<Value> {
        self.chat_events.subscribe()
    }

    /// 测试缝合：向 chat-event 通道发送（集成测试无法驱动真实 worker）。
    pub fn chat_events_sender(&self) -> tokio::sync::broadcast::Sender<Value> {
        self.chat_events.clone()
    }
```

`src-tauri/src/lib.rs` 第 7 行：

```rust
pub mod runtime;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test runtime_broadcast`
Expected: 2 个测试全 PASS。再跑 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 确认现有单测无回归。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/runtime/mod.rs src-tauri/src/lib.rs src-tauri/tests/runtime_broadcast.rs
git commit -m "feat(remote): chat-event broadcast 扇出——worker 并行推广播，前端路径不动"
```

---

### Task 4: 网关核心（relay client + bridge + lifecycle）

**Files:**
- Create: `src-tauri/src/remote/relay_client.rs`（传输层：重连循环 + 单次连接）
- Create: `src-tauri/src/remote/bridge.rs`（应用层：消息映射 + 动作执行）
- Modify: `src-tauri/src/remote/mod.rs`（组装层：RemoteGateway 生命周期 + `read_remote_settings` 辅助）
- Modify: `src-tauri/src/lib.rs`（setup 内 manage + 启动）
- Test: `src-tauri/tests/remote_bridge.rs`

**Interfaces:**
- Consumes: Task 2 的 `protocol::PhoneToDesktop` / `DesktopToPhone` / `auth::{PairingState, TokenStore}` / `commands::settings::RemoteSettings`；Task 3 的 `subscribe_chat_events()`
- Produces:
  - `aide::remote::RemoteGateway`（`new(app_handle)` / `start(self: &Arc<Self>)` / `stop(&self)` / `is_connected(&self) -> bool` / `set_connected(&self, bool)` / `pairing: Mutex<PairingState>` / `tokens: TokenStore`——**只做生命周期 + 状态，认证逻辑全在 TokenStore**）
  - `aide::remote::read_remote_settings(app: &AppHandle) -> Result<RemoteSettings, String>`（pub(crate) 辅助：spawn_blocking 读设置，bridge/relay_client 共用）
  - `aide::remote::bridge::BridgeAction`（`Pair{code}` / `Auth{token}` / `SendMessage{session_id, prompt}` / `LoadMessages{session_id}` / `ListSessions`——**不带 permission_mode，执行时读设置**）
  - `aide::remote::bridge::map_message(&PhoneToDesktop, authed: bool) -> Result<BridgeAction, String>`（纯函数）
  - `aide::remote::bridge::execute(&Arc<RemoteGateway>, BridgeAction) -> Result<Option<DesktopToPhone>, String>`
  - `aide::remote::relay_client::run(Arc<RemoteGateway>)`（主循环，指数退避重连）

- [ ] **Step 1: 写失败测试**

`src-tauri/tests/remote_bridge.rs`:

```rust
use aide::remote::bridge::{map_message, BridgeAction};
use aide::remote::protocol::PhoneToDesktop;

#[test]
fn map_send_message_requires_auth() {
    let msg = PhoneToDesktop::SendMessage { session_id: None, prompt: "hi".into() };
    let err = map_message(&msg, false).unwrap_err();
    assert!(err.contains("未认证"));
}

#[test]
fn map_send_message_generates_session_id_when_absent() {
    let msg = PhoneToDesktop::SendMessage { session_id: None, prompt: "hi".into() };
    match map_message(&msg, true).unwrap() {
        BridgeAction::SendMessage { session_id, prompt } => {
            assert!(session_id.starts_with("remote-"));
            assert_eq!(prompt, "hi");
        }
        _ => panic!("wrong action"),
    }
}

#[test]
fn map_send_message_keeps_existing_session_id() {
    let msg = PhoneToDesktop::SendMessage { session_id: Some("s1".into()), prompt: "hi".into() };
    match map_message(&msg, true).unwrap() {
        BridgeAction::SendMessage { session_id, .. } => {
            assert_eq!(session_id, "s1");
        }
        _ => panic!("wrong action"),
    }
}

#[test]
fn map_load_messages_and_list_require_auth() {
    let lm = PhoneToDesktop::LoadMessages { session_id: "s1".into() };
    assert!(map_message(&lm, false).is_err());
    let ls = PhoneToDesktop::ListSessions;
    assert!(map_message(&ls, false).is_err());
    assert!(map_message(&lm, true).is_ok());
    assert!(map_message(&ls, true).is_ok());
}

#[test]
fn map_pair_and_auth_never_require_auth() {
    let pair = PhoneToDesktop::Pair { code: "123456".into() };
    assert!(matches!(map_message(&pair, false).unwrap(), BridgeAction::Pair { code } if code == "123456"));
    let auth = PhoneToDesktop::Auth { token: "t".into() };
    assert!(matches!(map_message(&auth, false).unwrap(), BridgeAction::Auth { token } if token == "t"));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test remote_bridge`
Expected: FAIL——`aide::remote::bridge` 不存在。

- [ ] **Step 3: 实现 RemoteGateway + bridge + relay_client**

`src-tauri/src/remote/mod.rs` 完整替换为：

```rust
pub mod auth;
pub mod bridge;
pub mod protocol;
pub mod relay_client;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::task::JoinHandle;

use crate::commands::settings::{public_settings, RemoteSettings};
use crate::settings::SettingsService;

/// 远程控制网关：出站连中继，桥接手机消息到 sidecar 命令面。
/// 组装层——只做生命周期 + 连接状态；认证逻辑在 auth::TokenStore，
/// 消息映射在 bridge，传输在 relay_client。
pub struct RemoteGateway {
    app_handle: AppHandle,
    /// 配对码状态（10 分钟轮换）
    pub pairing: Mutex<auth::PairingState>,
    /// 长期 token 签发/校验/吊销 + 设备身份
    pub tokens: auth::TokenStore,
    relay_task: Mutex<Option<JoinHandle<()>>>,
    connected: AtomicBool,
}

impl RemoteGateway {
    pub fn new(app_handle: AppHandle) -> Self {
        let service = app_handle.state::<Arc<SettingsService>>().inner().clone();
        Self {
            app_handle,
            pairing: Mutex::new(auth::PairingState::new()),
            tokens: auth::TokenStore::new(service),
            relay_task: Mutex::new(None),
            connected: AtomicBool::new(false),
        }
    }

    /// 启动中继客户端任务（幂等：已在跑则不动）。
    pub fn start(self: &Arc<Self>) {
        if self.relay_task.lock().unwrap().is_some() { return; }
        let gateway = self.clone();
        let handle = tokio::spawn(async move {
            relay_client::run(gateway).await;
        });
        *self.relay_task.lock().unwrap() = Some(handle);
    }

    /// 停止中继客户端任务（abort 会打断重连退避 sleep）。
    pub fn stop(&self) {
        if let Some(h) = self.relay_task.lock().unwrap().take() {
            h.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn set_connected(&self, value: bool) {
        self.connected.store(value, Ordering::Relaxed);
    }
}

/// 读远程设置（spawn_blocking 包同步 IO）。bridge/relay_client 共用。
pub(crate) async fn read_remote_settings(app: &AppHandle) -> Result<RemoteSettings, String> {
    let service = app.state::<Arc<SettingsService>>();
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || public_settings(&service))
        .await.map_err(|e| e.to_string())?
        .map(|s| s.remote)
}
```

`src-tauri/src/remote/bridge.rs`:

```rust
use serde_json::json;
use tauri::Manager;

use super::auth;
use super::protocol::{DesktopToPhone, PhoneToDesktop};
use super::{read_remote_settings, RemoteGateway};

/// 手机消息 → 可执行动作（纯函数，可单测）。
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeAction {
    Pair { code: String },
    Auth { token: String },
    SendMessage { session_id: String, prompt: String },
    LoadMessages { session_id: String },
    ListSessions,
}

/// 纯映射：认证检查 + 消息规范化（无 session_id 时生成 remote- 前缀 id）。
/// permission_mode 不在这里——执行时读设置（可中途改，每次执行生效）。
pub fn map_message(msg: &PhoneToDesktop, authed: bool) -> Result<BridgeAction, String> {
    match msg {
        PhoneToDesktop::Pair { code } => Ok(BridgeAction::Pair { code: code.clone() }),
        PhoneToDesktop::Auth { token } => Ok(BridgeAction::Auth { token: token.clone() }),
        PhoneToDesktop::SendMessage { session_id, prompt } => {
            if !authed { return Err("未认证：请先配对".into()); }
            let sid = session_id.clone()
                .unwrap_or_else(|| format!("remote-{}", auth::generate_device_id()));
            Ok(BridgeAction::SendMessage { session_id: sid, prompt: prompt.clone() })
        }
        PhoneToDesktop::LoadMessages { session_id } => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::LoadMessages { session_id: session_id.clone() })
        }
        PhoneToDesktop::ListSessions => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::ListSessions)
        }
    }
}

/// 执行动作（薄层：调现有 Tauri 命令 / 认证逻辑）。返回要回给手机的应答（None = 无应答）。
pub async fn execute(
    gateway: &std::sync::Arc<RemoteGateway>,
    action: BridgeAction,
) -> Result<Option<DesktopToPhone>, String> {
    match action {
        BridgeAction::Pair { code } => {
            if gateway.pairing.lock().unwrap().validate(&code) {
                let token = gateway.tokens.issue()?;
                let device_id = gateway.tokens.device_id()?;
                Ok(Some(DesktopToPhone::PairOk { device_id, token }))
            } else {
                Ok(Some(DesktopToPhone::AuthError { message: "配对码无效或已过期".into() }))
            }
        }
        BridgeAction::Auth { token } => {
            if gateway.tokens.validate(&token) {
                Ok(Some(DesktopToPhone::AuthOk))
            } else {
                Ok(Some(DesktopToPhone::AuthError { message: "token 无效".into() }))
            }
        }
        BridgeAction::SendMessage { session_id, prompt } => {
            // 远程权限模式每次执行时读设置（可中途改，立即生效）
            let permission_mode = read_remote_settings(&gateway.app_handle).await?.permission_mode;
            let app = gateway.app_handle.clone();
            let runtime = app.state::<crate::runtime::AgentRuntimeManager>();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let settings = app.state::<std::sync::Arc<crate::settings::SettingsService>>();
            crate::commands::chat::send_message(
                session_id, prompt, None, None, None, None,
                Some(permission_mode), None, None,
                runtime, ws_state, settings,
            ).await?;
            Ok(None)
        }
        BridgeAction::LoadMessages { session_id } => {
            let app = gateway.app_handle.clone();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let messages = crate::commands::session::load_messages(ws_state, session_id).await?;
            Ok(Some(DesktopToPhone::Messages { messages: json!(messages) }))
        }
        BridgeAction::ListSessions => {
            let app = gateway.app_handle.clone();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let sessions = crate::commands::session::list_sessions(ws_state).await?;
            Ok(Some(DesktopToPhone::Sessions { sessions: json!(sessions) }))
        }
    }
}
```

`src-tauri/src/remote/relay_client.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tauri::Manager;
use tokio_tungstenite::tungstenite::Message;

use super::bridge;
use super::protocol::{DesktopToPhone, PhoneToDesktop};
use super::{read_remote_settings, RemoteGateway};

/// 主循环：连中继 → 注册 → 桥接；断开后指数退避重连（1s → 30s 封顶）。
pub async fn run(gateway: Arc<RemoteGateway>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect_once(&gateway).await {
            Ok(()) => backoff = Duration::from_secs(1),
            Err(e) => {
                eprintln!("[remote] relay error: {e}");
                gateway.set_connected(false);
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

/// 单次连接：连中继 → 注册 → 桥接，直到断开。
async fn connect_once(gateway: &Arc<RemoteGateway>) -> Result<(), String> {
    let settings = read_remote_settings(&gateway.app_handle).await?;
    if settings.relay_url.trim().is_empty() {
        return Err("relay URL 未配置".into());
    }
    let url = format!("{}/ws", settings.relay_url.trim_end_matches('/'));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;

    // 注册（配对码过期/为空则刷新，避免配对中途换码）
    let code = gateway.pairing.lock().unwrap().ensure_valid();
    let device_id = gateway.tokens.device_id()?;
    let register = json!({"type": "register", "device_id": device_id, "pairing_code": code});
    ws.send(Message::Text(register.to_string().into())).await.map_err(|e| e.to_string())?;
    gateway.set_connected(true);
    eprintln!("[remote] connected to relay {url}");

    let (mut sink, mut stream) = ws.split();

    // 事件转发：broadcast → mpsc → 主循环 sink（sink 单写者，避免跨任务共享）
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<String>(256);
    let mut rx = gateway.app_handle
        .state::<crate::runtime::AgentRuntimeManager>()
        .inner()
        .subscribe_chat_events();
    let fwd = tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let msg = json!({"type": "event", "event": event});
            if event_tx.send(msg.to_string()).await.is_err() { break; }
        }
    });

    // 入站处理 + 事件发送合并
    let mut authed = false;
    loop {
        tokio::select! {
            Some(text) = event_rx.recv() => {
                if sink.send(Message::Text(text.into())).await.is_err() { break; }
            }
            msg = stream.next() => {
                let Some(msg) = msg else { break; };
                let Ok(msg) = msg else { break; };
                let Message::Text(text) = msg else { continue; };
                let Ok(parsed) = serde_json::from_str::<PhoneToDesktop>(&text) else { continue; };
                let action = match bridge::map_message(&parsed, authed) {
                    Ok(a) => a,
                    Err(e) => {
                        let reply = DesktopToPhone::Error { message: e };
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                        continue;
                    }
                };
                match bridge::execute(gateway, action).await {
                    Ok(Some(reply)) => {
                        if matches!(reply, DesktopToPhone::PairOk { .. } | DesktopToPhone::AuthOk) {
                            authed = true;
                        }
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        let reply = DesktopToPhone::Error { message: e };
                        let text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                }
            }
        }
    }
    fwd.abort();
    Ok(())
}
```

`src-tauri/src/lib.rs` 改动：

1. 第 7 行 `mod runtime;` 已改为 `pub mod runtime;`（Task 3）。加：

```rust
pub mod remote;
```

2. **manage 链上拿不到 AppHandle**（`tauri::Builder::default()` 链上无 app 参数，`app_handle` 只在 setup 闭包内可用）——所以 `RemoteGateway` 在 setup 闭包内 manage。`.setup(|app| {` 闭包内、`initialize_blocking()` 之后加：

```rust
            // 远程控制网关：manage 需要 AppHandle，只能在 setup 内注册
            app.manage(std::sync::Arc::new(remote::RemoteGateway::new(app.handle().clone())));
            // 设置开启则随 app 启动
            {
                let gateway = app.state::<std::sync::Arc<remote::RemoteGateway>>();
                let service = app.state::<std::sync::Arc<crate::settings::SettingsService>>();
                let enabled = crate::commands::settings::public_settings(service.inner())
                    .map(|s| s.remote.enabled)
                    .unwrap_or(false);
                if enabled {
                    gateway.start();
                }
            }
```

注意：`initialize_blocking()` 必须先于 `public_settings` 调用（settings 未初始化时读会报 `NotInitialized`）——上面代码放在 `initialize_blocking()` 之后、`WebviewWindowBuilder::new` 之前即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test remote_bridge`
Expected: 5 个测试全 PASS。再跑 `cargo build --manifest-path src-tauri/Cargo.toml` 确认编译通过（lib.rs 改动）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote/ src-tauri/src/lib.rs src-tauri/tests/remote_bridge.rs
git commit -m "feat(remote): 网关核心——relay client 重连循环 + bridge 命令桥 + 生命周期"
```

---

### Task 5: 设置 descriptors + Tauri 命令

**Files:**
- Modify: `src-tauri/src/settings/descriptors.rs`（加 settings.remote.* 描述符）
- Create: `src-tauri/src/commands/remote.rs`（4 个 Tauri 命令）
- Modify: `src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Consumes: Task 2 的 `RemoteSettings`；Task 4 的 `RemoteGateway`（start/stop/pairing/tokens/is_connected）
- Produces:
  - Tauri 命令：`remote_get_status(app) -> RemoteStatus`、`remote_set_enabled(enabled, app)`、`remote_refresh_pairing_code(app) -> String`、`remote_revoke(app)`
  - `RemoteStatus { enabled, relay_url, device_id, pairing_code: Option<String>, connected, token_configured }`（serde camelCase）

**测试说明**：本任务无新集成测试——4 个命令是薄层（调 RemoteGateway + SettingsService，需要 AppHandle，集成测试无法构造）；descriptors 目录校验（id 非空/无重复）由 settings 模块内部测试覆盖（`validate_descriptor_catalog` 是 `#[cfg(test)]` 导出，集成测试不可见，新增描述符后 `cargo test --lib` 自动校验）。验证方式 = `cargo test --lib` + `cargo build`。

- [x] **Step 1: 写失败测试（无新测试，验证方式先行确认）**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS（基线——settings 内部测试当前全绿）。

- [x] **Step 2: 实现设置 + 命令**

`src-tauri/src/settings/descriptors.rs` 的 `DESCRIPTORS` vec 末尾（`permissions.rules` 之后）加：

```rust
        user("settings.remote.enabled", json!(false), SettingValueKind::Boolean, "remote"),
        user("settings.remote.relayUrl", json!(""), SettingValueKind::String, "remote"),
        user("settings.remote.deviceId", json!(""), SettingValueKind::String, "remote"),
        user("settings.remote.permissionMode", json!("auto"), SettingValueKind::String, "remote"),
```

`src-tauri/src/commands/remote.rs`（新文件）：

```rust
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::commands::settings::public_settings;
use crate::remote::RemoteGateway;
use crate::settings::{SettingsScope, SettingsService};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub relay_url: String,
    pub device_id: String,
    pub pairing_code: Option<String>,
    pub connected: bool,
    pub token_configured: bool,
}

/// 设置面板状态快照。secrets 读取是同步 IO，与 public_settings 一起包进
/// spawn_blocking（对齐现有 get_settings 的模式）。
#[tauri::command]
pub async fn remote_get_status(app: AppHandle) -> Result<RemoteStatus, String> {
    let gateway = app.state::<Arc<RemoteGateway>>();
    let service = app.state::<Arc<SettingsService>>();
    let service2 = service.inner().clone();
    let (settings, token_configured) = tokio::task::spawn_blocking(move || {
        let settings = public_settings(&service2)?;
        let token_configured = service2.secrets()
            .get("remote/token").map_err(|e| e.to_string())?.is_some();
        Ok::<_, String>((settings, token_configured))
    }).await.map_err(|e| e.to_string())??;
    Ok(RemoteStatus {
        enabled: settings.remote.enabled,
        relay_url: settings.remote.relay_url,
        device_id: settings.remote.device_id,
        pairing_code: gateway.pairing.lock().unwrap().current(),
        connected: gateway.is_connected(),
        token_configured,
    })
}

/// 开关远程控制：写设置 + 启停网关。
#[tauri::command]
pub async fn remote_set_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    let service = app.state::<Arc<SettingsService>>();
    let service2 = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        service2.mutate_scope_blocking(SettingsScope::User, None, |document| {
            let target = document.values.entry("settings".to_string())
                .or_insert_with(|| serde_json::json!({}));
            let target = target.as_object_mut().ok_or_else(|| {
                crate::settings::SettingsError::Validation("settings must be an object".to_string())
            })?;
            let remote = target.entry("remote".to_string())
                .or_insert_with(|| serde_json::json!({}));
            remote["enabled"] = serde_json::json!(enabled);
            Ok(())
        }).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())??;
    let gateway = app.state::<Arc<RemoteGateway>>();
    if enabled { gateway.start(); } else { gateway.stop(); }
    Ok(())
}

/// 刷新配对码（设置面板「刷新」按钮）。
#[tauri::command]
pub async fn remote_refresh_pairing_code(app: AppHandle) -> Result<String, String> {
    let gateway = app.state::<Arc<RemoteGateway>>();
    Ok(gateway.pairing.lock().unwrap().refresh())
}

/// 吊销所有远程设备（清 token）。
#[tauri::command]
pub async fn remote_revoke(app: AppHandle) -> Result<(), String> {
    let gateway = app.state::<Arc<RemoteGateway>>();
    gateway.tokens.revoke()
}
```

`src-tauri/src/lib.rs`：

1. `pub mod remote;` 已加（Task 4）。`commands/mod.rs` 加 `pub mod remote;`（参照 `pub mod settings;` 等现有声明）。
2. `invoke_handler` 的 `generate_handler![...]` 列表加：

```rust
            commands::remote::remote_get_status,
            commands::remote::remote_set_enabled,
            commands::remote::remote_refresh_pairing_code,
            commands::remote::remote_revoke,
```

- [x] **Step 3: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS——settings 内部测试（含 descriptors 目录校验）全绿，新增 remote 描述符无重复/无缺失。
再跑 `cargo build --manifest-path src-tauri/Cargo.toml` 确认编译通过。

- [x] **Step 4: Commit**

```bash
git add src-tauri/src/settings/descriptors.rs src-tauri/src/commands/remote.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(remote): 远程设置 descriptors + 4 个 Tauri 命令（状态/开关/配对码/吊销）"
```

---

### Task 6: 设置面板 UI（远程控制 tab）

**Files:**
- Modify: `src/types.ts`（AppSettings 加 remote 字段）
- Modify: `src/composables/useSettings.ts`（默认值）
- Modify: `src/api.ts`（4 个远程命令封装）
- Modify: `src/components/SettingsPanel.vue`（Tab union 加 "remote" + tab 内容）
- Test: `src/components/SettingsPanel.test.ts`（remote tab 渲染测试）

**Interfaces:**
- Consumes: Task 5 的 4 个 Tauri 命令 + `settings.remote.*` 设置
- Produces: 设置面板「远程控制」tab——开关、中继 URL、权限模式、配对码显示/刷新、吊销、连接状态

- [x] **Step 1: 写失败测试**

`src/components/SettingsPanel.test.ts` 改动（照抄该文件现有 mock 模式——`vi.mock` useSettings + api Proxy + `mountPanel` 辅助函数）：

1. 现有 `vi.mock("../composables/useSettings", ...)` 的 settings 对象加 remote 字段（**必须加**，否则 SettingsPanel.vue 的 script 访问 `settings.remote.enabled` 时现有测试全挂）：

```ts
      codegraphEmbedder: {
        apiKeyConfigured: false, backend: "fastembed", baseUrl: "",
        dim: 768, model: "", format: "ollama",
      },
      remote: { enabled: false, relayUrl: "", deviceId: "", permissionMode: "auto" },
```

2. `mountPanel` 辅助函数加 initialTab 参数（现有调用 `mountPanel()` 不传参，默认值保持 `"permissions"` 不变）：

```ts
function mountPanel(initialTab = "permissions") {
  wrapper = shallowMount(SettingsPanel, {
    props: { initialTab },
    attachTo: document.body,
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}
```

3. 追加测试：

```ts
it("places the Remote tab after Diagnostics (fixed order)", () => {
  mountPanel();
  const labels = Array.from(document.body.querySelectorAll(".nav-label")).map(
    (el) => el.textContent?.trim() ?? "",
  );
  expect(labels[labels.length - 2]).toBe("远程控制");
  expect(labels[labels.length - 1]).toBe("关于");
});

it("renders remote tab with pairing code and status", async () => {
  mountPanel("remote");
  const text = document.body.textContent ?? "";
  expect(text).toContain("中继 URL");
  expect(text).toContain("配对码");
  expect(text).toContain("未连接");
});
```

（api 的 Proxy mock 对 `remoteGetStatus` 等调用返回 `undefined`——`remoteStatus` 保持 null，UI 显示"未连接"与"—"，断言只查静态文案，不依赖 invoke 返回值。）

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/components/SettingsPanel.test.ts`
Expected: FAIL——"远程控制" tab 不存在。

- [x] **Step 3: 实现类型 + 命令封装 + UI**

`src/types.ts`（`codegraphEmbedder` 之后加）：

```ts
export interface RemoteSettings {
  enabled: boolean;
  relayUrl: string;
  deviceId: string;
  permissionMode: string;
}
```

`AppSettings` 加 `remote: RemoteSettings;`。

`src/composables/useSettings.ts` 默认值（`codegraphEmbedder` 默认值附近）：

```ts
remote: {
  enabled: false,
  relayUrl: "",
  deviceId: "",
  permissionMode: "auto",
},
```

`src/api.ts`（`setSettings` 附近加）：

```ts
async remoteGetStatus(): Promise<RemoteStatus> {
  return invoke("remote_get_status");
},
async remoteSetEnabled(enabled: boolean): Promise<void> {
  return invoke("remote_set_enabled", { enabled });
},
async remoteRefreshPairingCode(): Promise<string> {
  return invoke("remote_refresh_pairing_code");
},
async remoteRevoke(): Promise<void> {
  return invoke("remote_revoke");
},
```

`src/components/SettingsPanel.vue`：

1. Tab union 加 `"remote"`：

```ts
type Tab = "general" | "editor" | "providers" | "permissions" | "extensions" | "marketplace" | "codegraph" | "diagnostics" | "about" | "remote";
```

2. tab 列表加一项（参照现有 tab 按钮结构）：

```html
<button :class="tabClass('remote')" @click="activeTab = 'remote'">远程控制</button>
```

3. tab 内容（参照 codegraph tab 的布局与主题 token 用法——所有颜色/间距走 `var(--aide-*)`，禁止硬编码 hex）：

```html
<div v-if="activeTab === 'remote'" class="settings-section">
  <h3>远程控制</h3>
  <p class="settings-hint">手机 APP 通过自建中继远程控制本机 aide（发消息、看回复、看历史）。</p>

  <label class="settings-row">
    <span>启用远程控制</span>
    <input type="checkbox" :checked="remoteEnabled" @change="onRemoteEnabledChange" />
  </label>

  <label class="settings-row">
    <span>中继 URL</span>
    <input
      type="text"
      :value="remoteRelayUrl"
      placeholder="wss://relay.example.com"
      @change="onRemoteRelayUrlChange"
    />
  </label>

  <label class="settings-row">
    <span>远程会话权限模式</span>
    <select :value="remotePermissionMode" @change="onRemotePermissionModeChange">
      <option value="auto">自动模式（自动批准非危险工具）</option>
      <option value="acceptEdits">编辑模式（文件编辑自动批准）</option>
      <option value="default">手动模式（不推荐远程使用）</option>
    </select>
  </label>

  <div class="settings-row">
    <span>配对码（10 分钟有效）</span>
    <span class="remote-code">{{ remoteStatus?.pairingCode ?? "—" }}</span>
    <button @click="refreshPairingCode">刷新</button>
  </div>

  <div class="settings-row">
    <span>连接状态</span>
    <span>{{ remoteStatus?.connected ? "已连接" : "未连接" }}</span>
  </div>

  <div class="settings-row">
    <span>已配对设备</span>
    <span>{{ remoteStatus?.tokenConfigured ? "有（token 已签发）" : "无" }}</span>
    <button @click="revokeRemote">吊销所有设备</button>
  </div>
</div>
```

4. script 逻辑（参照现有 tab 的 settings 读写模式）：

```ts
const remoteEnabled = ref(settings.remote.enabled);
const remoteRelayUrl = ref(settings.remote.relayUrl);
const remotePermissionMode = ref(settings.remote.permissionMode);
const remoteStatus = ref<RemoteStatus | null>(null);

async function refreshRemoteStatus() {
  remoteStatus.value = await api.remoteGetStatus();
}
onMounted(() => { if (props.initialTab === "remote") refreshRemoteStatus(); });
watch(activeTab, (t) => { if (t === "remote") refreshRemoteStatus(); });

async function onRemoteEnabledChange(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked;
  remoteEnabled.value = enabled;
  await api.remoteSetEnabled(enabled);
  refreshRemoteStatus();
}
function onRemoteRelayUrlChange(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  remoteRelayUrl.value = v;
  update({ remote: { ...settings.remote, relayUrl: v } });
}
function onRemotePermissionModeChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  remotePermissionMode.value = v;
  update({ remote: { ...settings.remote, permissionMode: v } });
}
async function refreshPairingCode() {
  await api.remoteRefreshPairingCode();
  refreshRemoteStatus();
}
async function revokeRemote() {
  await api.remoteRevoke();
  refreshRemoteStatus();
}
```

（`RemoteStatus` 类型定义在 `src/types.ts`：`{ enabled: boolean; relayUrl: string; deviceId: string; pairingCode: string | null; connected: boolean; tokenConfigured: boolean }`。）

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/components/SettingsPanel.test.ts`
Expected: 全部 PASS（含新增 remote tab 测试）。

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/composables/useSettings.ts src/api.ts src/components/SettingsPanel.vue src/components/SettingsPanel.test.ts
git commit -m "feat(remote): 设置面板远程控制 tab——开关/中继 URL/权限模式/配对码/吊销"
```

---

## 部署说明（非实施任务）

中继服务器部署到 VPS（用户自建）：`RELAY_ADDR=0.0.0.0:8787` 跑 `aide-relay`，前面挂 Caddy 反代 `wss://relay.example.com/ws` → `127.0.0.1:8787`（自动证书）。桌面端设置里填 `wss://relay.example.com`。手机 PWA 填同一 URL + 配对码。systemd 服务文件与 Caddy 配置由用户部署时写，不在本计划内。

## 已知限制（v1 明确接受）

- 远程会话跨桌面 app 重启不 resume（sidecar worker 重建后按新会话处理；历史仍可 load_messages 查看）
- 一个桌面同时只服务一个手机连接（中继 devices 表单连接语义）
- 断线重连后事件缺口由手机端重新 load_messages 补齐（协议无回放）

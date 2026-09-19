# Agent LSP 工具 C1a（Rust 侧）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主进程具备响应 agent 语义查询的能力——收到 `lsp_query` 事件，就绪探测后在本进程的 `LspManager` 上执行，回 `lsp_result` 命令。

**Architecture:** 照 `codegraph_query` / `codegraph_result` 逐字同构加一对帧。与 codegraph 的唯一区别：查询本体**不跳 runner**——`LspManager` 就住在主进程，拦截点直接派发（对比 `runtime/browser_agent.rs` 的形态）。业务逻辑按 `runtime/mod.rs:343` 的既有约束**不内联进拦截点**（该文件有 1000 行拆分线）。

**Tech Stack:** Rust / Tauri v2 / tokio / serde_json / LSP over stdio（既有 `src-tauri/src/lsp/` 全部复用）

**Spec:** [docs/superpowers/specs/2026-09-19-agent-lsp-tool-design.md](../specs/2026-09-19-agent-lsp-tool-design.md)

**基线证据:** [docs/superpowers/spikes/2026-09-19-lsp-agent-tools/README.md](../spikes/2026-09-19-lsp-agent-tools/README.md)

## Global Constraints

- **红线：任何情况下不得用空数组冒充「没有引用」。** 要么 `status=ready` + 空（可信的"没有"），要么非 `ready` 状态 + 明确说明。
- **失败路径返回数据而非抛错**：`lsp_result` 的 `ok:false` 走错误字段，绝不 panic、绝不中断 sidecar。
- **语言无关**：新增代码不得出现 java/jdtls 专属判断（CLAUDE.md 红线：语言特有配置只准待在 `lsp/profiles/java.rs`）。
- **Windows 子进程必须带 `CREATE_NO_WINDOW`**（本计划不新增 spawn，若新增须遵守）。
- **同步命令禁止重 IO/CPU**（本计划新增命令一律 `async fn`）。
- 测试命令：`cd src-tauri && cargo test --lib`（避开杀软锁全量 target）。
- 本计划**不新增语言服务器进程**，全部复用既有 `LspManager`。

## 帧契约（C1b 按此实现，勿改）

sidecar → Rust（事件通道）：

```json
{ "type": "lsp_query", "request_id": "<uuid>", "tool": "symbols|references|definition|implementations",
  "args": { "name": "LspManager::get", "file": "/abs/path" }, "workspace_root": "/abs/path" }
```

`args` 两种形态二选一：`{"name": string, "file"?: string}` 或 `{"file": string, "line": number, "character": number}`

Rust → sidecar（命令通道）：

```json
{ "cmd": "lsp_result", "request_id": "<uuid>", "ok": true, "status": "ready",
  "results": [ /* QueryResult */ ], "candidates": 1 }
```

**状态词表（C1 全集，冻结）**：`ready` / `indexing` / `no_symbol` / `no_server` / `untrusted` / `timeout` / `gone` / `error`

---

### Task 1: 协议桥 `lsp/agent_bridge.rs`

**Files:**
- Create: `src-tauri/src/lsp/agent_bridge.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（加 `pub mod agent_bridge;`）
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `pub struct LspQueryRequest { pub request_id: String, pub tool: String, pub args: Value, pub workspace_root: String }`
  - `pub fn parse_lsp_query(event: &Value) -> Option<LspQueryRequest>`
  - `pub fn build_result_command(request_id: &str, payload: Value) -> Value`

照抄 `src-tauri/src/codegraph/agent_bridge.rs` 的形状（读它对照）。

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_result_command_tags_cmd_and_request_id() {
        let v = build_result_command("r1", json!({"ok": true, "status": "ready", "results": []}));
        assert_eq!(v["cmd"], "lsp_result");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["status"], "ready");
    }

    /// 回包 cmd 标不得串成 codegraph_result / browser_result——串了 sidecar
    /// 按 id 配对会失败，且**无任何提示**（codegraph/agent_bridge.rs 同类测试在案）。
    #[test]
    fn build_result_command_never_tags_as_another_bridge() {
        let v = build_result_command("r1", json!({"ok": true}));
        assert_ne!(v["cmd"], "codegraph_result");
        assert_ne!(v["cmd"], "browser_result");
    }

    #[test]
    fn parse_requires_request_id() {
        assert!(parse_lsp_query(
            &json!({"type":"lsp_query","tool":"symbols","args":{},"workspace_root":"/x"})
        )
        .is_none());
    }

    #[test]
    fn parse_ignores_other_event_types() {
        assert!(parse_lsp_query(&json!({"type":"text_delta"})).is_none());
        assert!(parse_lsp_query(&json!({"type":"codegraph_query","request_id":"r"})).is_none());
    }

    #[test]
    fn parse_extracts_all_fields() {
        let r = parse_lsp_query(&json!({
            "type":"lsp_query","request_id":"r1","tool":"references",
            "args":{"name":"LspManager::get"},"workspace_root":"/proj"
        }))
        .unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.tool, "references");
        assert_eq!(r.args["name"], "LspManager::get");
        assert_eq!(r.workspace_root, "/proj");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp::agent_bridge`
Expected: 编译失败（`parse_lsp_query` not found）

- [ ] **Step 3: 实现**

```rust
//! agent-sidecar ↔ LSP 的协议桥（主进程侧）。
//!
//! 与 `codegraph/agent_bridge.rs` 同构：`lsp_query` 事件进、`lsp_result` 命令出。
//! 唯一区别：查询本体**不跳 runner**——`LspManager` 就在主进程，拦截点直接派发。

use serde_json::Value;

/// One intercepted `lsp_query` event, validated.
pub struct LspQueryRequest {
    pub request_id: String,
    pub tool: String,
    pub args: Value,
    pub workspace_root: String,
}

/// Validate + extract an agent query event. None → not an lsp_query, or
/// malformed (missing request_id) — caller ignores it.
pub fn parse_lsp_query(event: &Value) -> Option<LspQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("lsp_query") {
        return None;
    }
    Some(LspQueryRequest {
        request_id: event.get("request_id")?.as_str()?.to_string(),
        tool: event.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        args: event.get("args").cloned().unwrap_or(Value::Null),
        workspace_root: event
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Assemble the stdin command line payload: base payload + request_id + cmd tag.
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("lsp_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp::agent_bridge`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lsp/agent_bridge.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): agent 查询协议桥——lsp_query 进 / lsp_result 出"
```

---

### Task 2: 状态词 `lsp/agent_status.rs`

**Files:**
- Create: `src-tauri/src/lsp/agent_status.rs`
- Modify: `src-tauri/src/lsp/mod.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::lsp::EnsureOutcome`（`lsp/mod.rs:24`，字段 `ok: bool` / `ready: bool` / `kind: Option<&'static str>` / `error: Option<String>`）
- Produces:
  - `pub enum AgentLspStatus { Ready, Indexing, NoSymbol, NoServer, Untrusted, Timeout, Gone, Error }`
  - `impl AgentLspStatus { pub fn as_str(&self) -> &'static str }`
  - `impl AgentLspStatus { pub fn from_ensure(o: &EnsureOutcome) -> Self }`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::EnsureOutcome;

    fn ensure(ok: bool, ready: bool, kind: Option<&'static str>) -> EnsureOutcome {
        EnsureOutcome { ok, ready, kind, error: None }
    }

    #[test]
    fn status_words_are_frozen() {
        // 这八个词是 C1b 文案表的键，改一个就得同步改 sidecar。
        assert_eq!(AgentLspStatus::Ready.as_str(), "ready");
        assert_eq!(AgentLspStatus::Indexing.as_str(), "indexing");
        assert_eq!(AgentLspStatus::NoSymbol.as_str(), "no_symbol");
        assert_eq!(AgentLspStatus::NoServer.as_str(), "no_server");
        assert_eq!(AgentLspStatus::Untrusted.as_str(), "untrusted");
        assert_eq!(AgentLspStatus::Timeout.as_str(), "timeout");
        assert_eq!(AgentLspStatus::Gone.as_str(), "gone");
        assert_eq!(AgentLspStatus::Error.as_str(), "error");
    }

    #[test]
    fn ensure_ok_ready_is_ready() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(true, true, None)).as_str(),
            "ready"
        );
    }

    /// Java 索引期：握手成功但 ready=false → indexing（不是 ready，也不是错误）。
    #[test]
    fn ensure_ok_not_ready_is_indexing() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(true, false, None)).as_str(),
            "indexing"
        );
    }

    #[test]
    fn ensure_kind_maps_to_status() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("server_not_found"))).as_str(),
            "no_server"
        );
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("untrusted"))).as_str(),
            "untrusted"
        );
    }

    /// spawn/handshake 失败是 error，不是 no_server——两者对用户的可操作性不同
    /// （no_server = 去装 server；error = 看日志）。
    #[test]
    fn ensure_spawn_and_handshake_failure_are_error() {
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("spawn_failed"))).as_str(),
            "error"
        );
        assert_eq!(
            AgentLspStatus::from_ensure(&ensure(false, false, Some("handshake_failed"))).as_str(),
            "error"
        );
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp::agent_status`
Expected: 编译失败（类型不存在）

- [ ] **Step 3: 实现**

```rust
//! agent 视角的 LSP 状态词——工具返回文案的键，也是「空 ≠ 没有」红线的落点。
//!
//! 与 `EnsureOutcome` 的映射是本模块唯一职责：`ok/ready` 两个布尔 +
//! `kind` 字符串的组合语义在这里收口，别散到调用点。

use crate::lsp::EnsureOutcome;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLspStatus {
    /// 可服务，结果可信（空结果 = 可信的「没有」）。
    Ready,
    /// 进程在、索引未完成。**空结果不代表没有**。
    Indexing,
    /// 按名字没找到符号（查询本身成功）。
    NoSymbol,
    /// 该语言未配置/未安装 server。
    NoServer,
    /// 工作区未信任，拒拉 server。
    Untrusted,
    Timeout,
    Gone,
    Error,
}

impl AgentLspStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Indexing => "indexing",
            Self::NoSymbol => "no_symbol",
            Self::NoServer => "no_server",
            Self::Untrusted => "untrusted",
            Self::Timeout => "timeout",
            Self::Gone => "gone",
            Self::Error => "error",
        }
    }

    /// `EnsureOutcome` → 状态词。注意 `ok=true, ready=false`（Java 索引期）
    /// 是 indexing，**不是** ready——这正是内置 LSP 工具缺失的那层区分。
    pub fn from_ensure(o: &EnsureOutcome) -> Self {
        if o.ok {
            return if o.ready { Self::Ready } else { Self::Indexing };
        }
        match o.kind {
            Some("server_not_found") => Self::NoServer,
            Some("untrusted") => Self::Untrusted,
            _ => Self::Error,
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp::agent_status`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lsp/agent_status.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): agent 状态词表——空结果与未就绪可区分"
```

---

### Task 3: 就绪探测 `lsp/agent_readiness.rs`

> **⚠️ 执行期修正（2026-09-19，commit ded920cc）——本节下面的代码块已过时，
> 以仓内实现为准：**
> 1. 签名改为 `await_ready(initial, probe, budget: ReadinessBudget)`。原设计是
>    `(…, budget: Duration, interval: Duration)`——两个 Duration 相邻同型，交换即
>    静默错位（变成「每 90 秒探一次、5 秒超时」）。打包成结构体消除该风险。
> 2. 测试的**间隔必须显著小于总预算**。原设计用生产常量 5s 间隔配 2s 预算，
>    第一次轮询就睡掉整个预算，「第 3 次才返回 true」的断言永远不可能成立。
>    测试改用 10ms 间隔（`fast(total_ms)` 辅助函数）。
> 3. `Ready` 不短路的理由已写进 `from_ensure`/`await_ready` 的文档注释。

**Files:**
- Create: `src-tauri/src/lsp/agent_readiness.rs`
- Modify: `src-tauri/src/lsp/mod.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `AgentLspStatus`（Task 2）
- Produces:
  - `pub const READINESS_BUDGET: Duration`（默认 90s）
  - `pub const READINESS_POLL_INTERVAL: Duration`（默认 5s）
  - `pub async fn await_ready<F, Fut>(initial: AgentLspStatus, probe: F, budget: Duration) -> AgentLspStatus`
    其中 `F: FnMut() -> Fut, Fut: Future<Output = bool>`——`probe` 返回 `true` 表示「语义层已可用」

**为什么需要它**：`EnsureOutcome.ready` 只在 Java 方向可信。注释写明「Java 索引期
ready=false；**其余语言握手成功即 ready=true**」——于是 rust-analyzer 在
`ready=true` 的那一刻索引根本没建好（实测 46–73 秒）。

> **⚠️ 实现时的关键点（计划初稿在这里是错的）**：绝**不能**对 `Ready` 短路返回。
> `Ready` 正是 rust-analyzer 在索引期间报的状态，对它短路等于完全不探测，把本设计
> 要消灭的 bug 原样复制一遍。**`Ready` 与 `Indexing` 一律探测**；只有硬失败态
> （NoServer / Untrusted / Error / NoSymbol / Timeout / Gone）才短路——那些重试也不会变好。
> 探测失败时 `Ready` 要**降级成 `Indexing`**：探测失败本身就是「不可用」的证据。

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 硬失败态短路：重试不会变好，且**不该白花一次探测**。
    #[tokio::test]
    async fn hard_failures_short_circuit_without_probing() {
        for s in [
            AgentLspStatus::NoServer,
            AgentLspStatus::Untrusted,
            AgentLspStatus::Error,
            AgentLspStatus::NoSymbol,
            AgentLspStatus::Timeout,
            AgentLspStatus::Gone,
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let c = calls.clone();
            let got = await_ready(
                s,
                move || {
                    c.fetch_add(1, Ordering::SeqCst);
                    async { true }
                },
                Duration::from_millis(50),
            )
            .await;
            assert_eq!(got, s, "{:?} 应原样返回", s);
            assert_eq!(calls.load(Ordering::SeqCst), 0, "{:?} 不该探测", s);
        }
    }

    /// **本任务的核心回归测试**：`Ready` 也不可信。
    /// rust-analyzer 握手即 ready=true 但索引还要几十秒——若这里短路，
    /// 就退回「空冒充没有」了。
    #[tokio::test]
    async fn ready_is_still_probed_and_downgrades_on_failure() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let got = await_ready(
            AgentLspStatus::Ready,
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                async { false }
            },
            Duration::from_millis(120),
        )
        .await;
        assert!(calls.load(Ordering::SeqCst) > 0, "Ready 必须被探测，不能短路");
        assert_eq!(got, AgentLspStatus::Indexing, "探测失败要降级，不能保持 Ready");
    }

    #[tokio::test]
    async fn ready_probe_success_stays_ready() {
        let got = await_ready(AgentLspStatus::Ready, || async { true }, Duration::from_millis(50)).await;
        assert_eq!(got, AgentLspStatus::Ready);
    }

    #[tokio::test]
    async fn indexing_becomes_ready_when_probe_succeeds() {
        let n = Arc::new(AtomicUsize::new(0));
        let c = n.clone();
        let got = await_ready(
            AgentLspStatus::Indexing,
            move || {
                let i = c.fetch_add(1, Ordering::SeqCst);
                async move { i >= 2 }
            },
            Duration::from_millis(2000),
        )
        .await;
        assert_eq!(got, AgentLspStatus::Ready);
        assert_eq!(n.load(Ordering::SeqCst), 3, "第 3 次才返回 true");
    }

    /// 预算耗尽仍没就绪 → 保持 indexing（**不是** timeout：进程还活着，只是慢）。
    #[tokio::test]
    async fn budget_exhausted_stays_indexing() {
        let got = await_ready(
            AgentLspStatus::Indexing,
            || async { false },
            Duration::from_millis(120),
        )
        .await;
        assert_eq!(got, AgentLspStatus::Indexing);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp::agent_readiness`
Expected: 编译失败

- [ ] **Step 3: 实现**

```rust
//! 就绪探测：把「进程在」升级成「语义层可用」。
//!
//! 存在的理由：`EnsureOutcome.ready` 只对 jdtls 有真实语义（见 lsp/mod.rs 注释），
//! rust-analyzer 握手即 ready=true 但索引还要几十秒。**调用方拿 ready 当闸门就是
//! 把「还没好」当成「没有」**——那正是内置 LSP 工具的失败模式。
//!
//! 判定手段与工具无关：轮询一个**廉价语义查询**（调用方注入，通常是
//! `documentSymbol`）直到非空。探测函数注入而非内联，是为了本模块可单测。
//!
//! 注意 `Ready` **也**要探测——状态词只表示「ensure 说它好了」，不表示索引建完了。
//! C1 不做探测结果缓存：每次查询多一次廉价往返，换「永不说谎」。缓存是后续优化。

use crate::lsp::agent_status::AgentLspStatus;
use std::future::Future;
use std::time::Duration;
use tokio::time::{sleep, Instant};

/// 探测总预算。90s 是拍的，标定依据：本仓库 rust-analyzer 实测 46–73s（jdtls 更长）。
pub const READINESS_BUDGET: Duration = Duration::from_secs(90);
pub const READINESS_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// `Ready` / `Indexing` 探测到成功为止；其余状态原样返回。
///
/// 预算耗尽一律返回 `Indexing`——**绝不返回 `Ready`**：没探测成功就没有
/// 「空结果可信」的资格。`Ready` 传入但探测失败时同样降级，理由同上。
pub async fn await_ready<F, Fut>(
    initial: AgentLspStatus,
    mut probe: F,
    budget: Duration,
) -> AgentLspStatus
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    if !matches!(initial, AgentLspStatus::Ready | AgentLspStatus::Indexing) {
        return initial;
    }
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if probe().await {
            return AgentLspStatus::Ready;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        sleep(READINESS_POLL_INTERVAL.min(left)).await;
    }
    AgentLspStatus::Indexing
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp::agent_readiness`
Expected: 5 passed

> 注：测试里用了 `tokio::test`。若本仓库 lib 测试未启 tokio 宏（先跑一次看是否报
> `cannot find attribute`），改用 `#[test]` + `tokio::runtime::Runtime::new().unwrap().block_on(...)`
> ——与 `lsp/manager.rs` 既有异步测试同形。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lsp/agent_readiness.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): 就绪探测——Ready 也不可信，探测失败一律降级 Indexing"
```

---

### Task 4: 新命令 `lsp_workspace_symbol`

**Files:**
- Create: `src-tauri/src/lsp/workspace_symbol.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（`pub mod workspace_symbol;` + 转发 `pub use`）
- Modify: `src-tauri/src/lib.rs:629`（**`generate_handler!` 登记**——紧邻 `lsp::lsp_document_symbol`）
- Test: 同文件 `#[cfg(test)] mod tests`（用 `lsp/mock_server.rs` 的 `MockLsp`）

**Interfaces:**
- Consumes: `LspState`、`crate::lsp::detector::LanguageId`、`crate::lsp::protocol::resolve_file_uri`
- Produces:
  - `pub struct LspSymbolSearchResult { pub status: JumpStatus, pub candidates: Vec<SymbolCandidate> }`
  - `pub struct SymbolCandidate { pub name: String, pub kind: u32, pub file_path: String, pub line: usize, pub column: usize, pub lang: String }`
  - `#[tauri::command] pub async fn lsp_workspace_symbol(workspace_root: String, query: String, lang: Option<String>, state: tauri::State<'_, Arc<LspState>>) -> Result<LspSymbolSearchResult, String>`

**语言参数定案**（spec）：`lang` 给了就只查该语言；缺省时对该工作区**已配置的全部语言**依次查询合并，每条候选带 `lang`。agent 只拿得到一个名字，没有扩展名可据以分派，逼它先猜语言等于把一个问题变成两个。

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// LSP `SymbolInformation`（扁平、带 location）与 `WorkspaceSymbol`（带 containerName）
    /// 两种形状都要能吃下——各 server 返回不同。
    #[test]
    fn parses_flat_symbol_information() {
        let v = json!([{
            "name": "LspManager",
            "kind": 5,
            "location": { "uri": "file:///c:/proj/src/a.rs",
                          "range": { "start": { "line": 111, "character": 11 } } }
        }]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "LspManager");
        assert_eq!(out[0].file_path, "/c/proj/src/a.rs");
        assert_eq!(out[0].line, 112, "LSP 0-based → 1-based");
        assert_eq!(out[0].column, 12);
        assert_eq!(out[0].lang, "rust");
    }

    #[test]
    fn parses_workspace_symbol_with_container() {
        let v = json!([{
            "name": "get", "kind": 6, "containerName": "LspManager",
            "location": { "uri": "file:///c:/proj/src/lsp/manager.rs",
                          "range": { "start": { "line": 215, "character": 17 } } }
        }]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out[0].name, "get");
        assert_eq!(out[0].line, 216);
    }

    /// 空结果 = 空候选，**不是错误**；调用方据 status==Ok 判定「可信的没有」。
    #[test]
    fn empty_result_is_ok_with_no_candidates() {
        assert!(parse_workspace_symbols(&json!([]), "rust").is_empty());
    }

    #[test]
    fn malformed_entries_are_skipped_not_panicking() {
        let v = json!([{"name":"ok","kind":1,"location":{"uri":"file:///c:/p/a.rs","range":{"start":{"line":0,"character":0}}}}, {"name":"no_location"}]);
        let out = parse_workspace_symbols(&v, "rust");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "ok");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp::workspace_symbol`
Expected: 编译失败

- [ ] **Step 3: 实现**

先读 `src-tauri/src/lsp/mod.rs` 的 `lsp_definition`（约 248 行）作为命令骨架、`lsp_document_symbol`（约 785 行）作为「返回符号列表」的返回形状参照，以及 `protocol.rs:230` 的 `location_to_query_result`。

```rust
//! `workspace/symbol`：按名字在整个工作区找符号。
//!
//! 编辑器此前只暴露了文件内符号（`lsp_document_symbol`），而 agent 的入口
//! 恰恰是名字——这是 agent 语义查询唯一需要新增的 LSP 方法。

use crate::lsp::detector::LanguageId;
use crate::lsp::protocol::resolve_file_uri;
use crate::lsp::{JumpStatus, LspState};
use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct SymbolCandidate {
    pub name: String,
    pub kind: u32,
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    pub lang: String,
}

#[derive(Debug, Serialize)]
pub struct LspSymbolSearchResult {
    pub status: JumpStatus,
    pub candidates: Vec<SymbolCandidate>,
}

/// 解析 `workspace/symbol` 的返回。两种形状都吃：扁平 `SymbolInformation`
/// （带 `location`）与 `WorkspaceSymbol`。缺 location 的条目跳过——不 panic。
///
/// 不带 `workspace_root`：`location.uri` 是绝对 URI，转本机路径用不着工作区根
/// （带进来会是个不产生行为的死参数）。
pub fn parse_workspace_symbols(value: &serde_json::Value, lang: &str) -> Vec<SymbolCandidate> {
    let Some(arr) = value.as_array() else {
        return vec![];
    };
    arr.iter()
        .filter_map(|it| {
            let name = it.get("name")?.as_str()?.to_string();
            let loc = it.get("location")?;
            let uri = loc.get("uri")?.as_str()?;
            let start = loc.get("range")?.get("start")?;
            let line = start.get("line")?.as_u64()? as usize + 1;
            let column = start.get("character")?.as_u64()? as usize + 1;
            Some(SymbolCandidate {
                name,
                kind: it.get("kind").and_then(|k| k.as_u64()).unwrap_or(0) as u32,
                file_path: uri_to_path(uri),
                line,
                column,
                lang: lang.to_string(),
            })
        })
        .collect()
}

/// `file:///c:/proj/a.rs` → `c:/proj/a.rs`（Windows 盘符形态）。剥不开就原样返回。
///
/// **动手前先搜一遍**：`crate::lsp::protocol` 与 `commands/filesystem` 里可能已有
/// URI→本机路径 的反向解析（前端展示引用列表时必然用过）。有就**直接用现成的、
/// 删掉这个函数**——不要留两份反向解析。
fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file:///").unwrap_or(uri).to_string()
}

#[tauri::command]
pub async fn lsp_workspace_symbol(
    workspace_root: String,
    query: String,
    lang: Option<String>,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<LspSymbolSearchResult, String> {
    let langs = match lang {
        Some(l) => vec![l],
        None => crate::lsp::detector::detect_languages(&workspace_root),
    };
    let mut candidates = Vec::new();
    let mut status = JumpStatus::NotReady;
    for l in langs {
        let Some(lang_id) = crate::lsp::lang_from_id_str(&l) else {
            continue;
        };
        let mgr = state.0.lock().await;
        let Some(h) = mgr.get(&workspace_root, lang_id).await else {
            continue;
        };
        let params = serde_json::json!({ "query": query });
        let outcome = h
            .request(
                "workspace/symbol",
                params,
                crate::lsp::manager::DEFINITION_TIMEOUT,
            )
            .await
            .map_err(|e| e.to_string())?;
        match outcome {
            crate::lsp::manager::RequestOutcome::Ok(v) => {
                status = JumpStatus::Ok;
                candidates.extend(parse_workspace_symbols(&v, &l));
            }
            crate::lsp::manager::RequestOutcome::Timeout => status = JumpStatus::Timeout,
            crate::lsp::manager::RequestOutcome::NotReady => status = JumpStatus::NotReady,
            crate::lsp::manager::RequestOutcome::ServerGone => status = JumpStatus::Gone,
        }
    }
    Ok(LspSymbolSearchResult { status, candidates })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp::workspace_symbol`
Expected: 4 passed

> **实现注意**（不要漏）：
> 1. `detect_languages` 的实际名字与签名以 `lsp/detector.rs` 为准（`lsp_detect_languages` 命令内已有调用，照它）。
> 2. `lang_from_id_str` 在 **`lsp/detector.rs:116`**（不是 `lsp/mod.rs`），且已是 `pub fn`——直接 `use crate::lsp::detector::lang_from_id_str;`。检测入口是 `detector::detect_languages(root: &Path) -> Vec<LanguageId>`。
> 3. `uri_to_path` 若仓库已有等价助手（搜 `file:///` 的反向解析），**直接用现成的、删掉这个临时实现**——不要留两份。
> 4. 每条候选的 `file_path` 必须是**绝对路径**（agent 后续要用它调 references）。

- [ ] **Step 5: 登记命令并提交**

在 `src-tauri/src/lib.rs` 的 `generate_handler![...]` 里 `lsp::lsp_document_symbol` 旁边加一行：

```rust
            lsp::lsp_workspace_symbol,
```

漏了这步的表现是：前端 `invoke("lsp_workspace_symbol")` 报 "command not found"，
而 Rust 侧编译**毫无警告**（`#[tauri::command]` 生成的外部符号没被引用不会报错）。

Run: `cd src-tauri && cargo build` 确认通过

```bash
git add src-tauri/src/lsp/workspace_symbol.rs src-tauri/src/lsp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): workspace/symbol 命令——agent 按名找符号的入口"
```

---

### Task 5: 服务层 `lsp/agent_query.rs`

**Files:**
- Create: `src-tauri/src/lsp/agent_query.rs`
- Modify: `src-tauri/src/lsp/mod.rs`
- Test: 同文件 `#[cfg(test)] mod tests`（纯函数部分）

**Interfaces:**
- Consumes: Task 2/3/4 的全部产出；既有 `lsp_references` / `lsp_definition` / `lsp_implementation` 的**请求逻辑**（本任务需把它们的公共部分抽成一个可复用 fn，见 Step 3 注意 1）
- Produces:
  - `pub struct Position { pub file: String, pub line: usize, pub character: usize }`
  - `pub struct AgentQueryOutcome { pub ok: bool, pub status: AgentLspStatus, pub payload: Value }`
  - `pub fn resolve_position(args: &Value) -> Option<Position>`（纯函数，可测）
  - `pub fn symbol_query_name(name: &str) -> &str`（纯函数，可测）
  - `pub async fn run_agent_query(app: &AppHandle, tool: &str, args: &Value, workspace_root: &str) -> AgentQueryOutcome`
  - `async fn lookup_symbol(app: &AppHandle, name: &str, workspace_root: &str) -> Result<Option<SymbolCandidate>, AgentLspStatus>`
  - `async fn run_jump(app: &AppHandle, tool: &str, pos: &Position, workspace_root: &str) -> AgentQueryOutcome`
    其中 `tool` ∈ `references` / `definition` / `implementations`，分别对应 LSP 的
    `textDocument/references` / `textDocument/definition` / `textDocument/implementation`

- [ ] **Step 1: 写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_position_wins() {
        let p = resolve_position(&json!({"file":"/a/b.rs","line":216,"character":19})).unwrap();
        assert_eq!(p.file, "/a/b.rs");
        assert_eq!(p.line, 216);
        assert_eq!(p.character, 19);
    }

    #[test]
    fn bare_name_is_not_a_position() {
        assert!(resolve_position(&json!({"name":"LspManager::get"})).is_none());
    }

    #[test]
    fn partial_position_is_rejected() {
        assert!(resolve_position(&json!({"file":"/a/b.rs","line":1})).is_none());
    }

    /// 名字里带 `::` 时取最后一段做 workspace/symbol 的 query——
    /// server 的符号索引按裸名建，`LspManager::get` 直接查会空。
    #[test]
    fn symbol_query_name_takes_last_segment() {
        assert_eq!(symbol_query_name("LspManager::get"), "get");
        assert_eq!(symbol_query_name("is_excluded"), "is_excluded");
        assert_eq!(symbol_query_name("a::b::c"), "c");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp::agent_query`
Expected: 编译失败

- [ ] **Step 3: 实现**

```rust
//! agent 查询服务层：把「工具名 + 参数」变成「一次 LSP 往返」。
//!
//! 三件事，顺序固定：
//!   1. 定性（trusted / 有没有 server）——不满足就早退，不白等探测
//!   2. 就绪探测（`await_ready`）——避免在索引窗口里返回空冒充「没有」
//!   3. 坐标解析（显式给坐标，或按名字查 workspace/symbol）
//! 任一步失败都返回**带状态的结果**，不返回空结果。

use crate::lsp::agent_readiness::{await_ready, READINESS_BUDGET};
use crate::lsp::agent_status::AgentLspStatus;
use crate::lsp::workspace_symbol::SymbolCandidate;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct Position {
    pub file: String,
    pub line: usize,
    pub character: usize,
}

pub struct AgentQueryOutcome {
    pub ok: bool,
    pub status: AgentLspStatus,
    pub payload: Value,
}

/// 显式坐标（三个字段齐全）才算数；只给名字不算。
pub fn resolve_position(args: &Value) -> Option<Position> {
    let file = args.get("file")?.as_str()?.to_string();
    let line = args.get("line")?.as_u64()? as usize;
    let character = args.get("character")?.as_u64()? as usize;
    Some(Position { file, line, character })
}

/// `LspManager::get` → `get`。server 的符号索引按裸名建，
/// 带限定路径直接查会返回空——**空会被误读成「没有」**，所以这里必须剥。
pub fn symbol_query_name(name: &str) -> &str {
    name.rsplit("::").next().unwrap_or(name)
}
```

`run_agent_query` 的主流程（照下面骨架实现，注意 `//!` 里那三步的顺序不能调换）：

```rust
pub async fn run_agent_query(
    app: &AppHandle,
    tool: &str,
    args: &Value,
    workspace_root: &str,
) -> AgentQueryOutcome {
    let Some(state) = app.try_state::<crate::lsp::LspState>() else {
        return fail(AgentLspStatus::NoServer, "lsp state unavailable");
    };
    // 1. 定性：未信任直接早退（既有信任门，不重复实现）
    if !crate::commands::workspace::is_path_trusted(workspace_root) {
        return fail(AgentLspStatus::Untrusted, "workspace not trusted");
    }
    // 2. 坐标：显式坐标优先；否则按名字查
    let pos = match resolve_position(args) {
        Some(p) => p,
        None => {
            let Some(name) = args.get("name").and_then(|v| v.as_str()) else {
                return fail(AgentLspStatus::NoSymbol, "missing name or position");
            };
            match lookup_symbol(app, symbol_query_name(name), workspace_root).await {
                Ok(Some(c)) => Position { file: c.file_path, line: c.line, character: c.column },
                Ok(None) => return fail(AgentLspStatus::NoSymbol, "symbol not found"),
                Err(s) => return fail(s, "symbol lookup failed"),
            }
        }
    };
    // 3. 执行（Task 5 的第二步：把 lsp_references/definition/implementation 的
    //    公共请求逻辑抽成 run_jump(app, method, pos, workspace_root) 后在这里分派）
    run_jump(app, tool, &pos, workspace_root).await
}

fn fail(status: AgentLspStatus, msg: &str) -> AgentQueryOutcome {
    AgentQueryOutcome {
        ok: false,
        status,
        payload: json!({ "ok": false, "status": status.as_str(), "error": msg }),
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp::agent_query`
Expected: 3 passed

> **实现注意**：
> 1. `lsp_references` / `lsp_definition` / `lsp_implementation` 三个命令的函数体高度重复（取 mgr → 组 params → request → 映射 status）。本步要把公共部分抽成 `run_jump(app, tool, pos, workspace_root)`，**三个既有命令改为调用它**——不允许复制第三份（CLAUDE.md「能力单一事实源」）。抽取后三个命令的既有测试必须仍绿。
> 2. `lookup_symbol` 内部要复用 Task 4 的 `parse_workspace_symbols`，并在内部做 `await_ready` 探测——探测失败返回 `Err(AgentLspStatus::Indexing)`，**不要**退化成 `Ok(None)`（那会变成「查不到」）。
> 3. `workspace/symbol` 返回多个候选时 `candidates > 1`：本层返回全部候选 + `status=ready`，由 sidecar 决定怎么向模型表述（spec：要求先 Read 消歧，不假装唯一）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lsp/agent_query.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): agent 查询服务层——定性/探测/坐标解析三步"
```

---

### Task 6: 按需 didOpen + 与编辑器的文档隔离

**Files:**
- Modify: `src-tauri/src/lsp/docs.rs`（`OpenDocs` 加来源标记）
- Modify: `src-tauri/src/lsp/mod.rs`（新增 agent 专用打开路径）
- Modify: `src-tauri/src/lsp/agent_query.rs`（执行前确保文档已打开）
- Test: `src-tauri/src/lsp/docs.rs` 的 `#[cfg(test)]`

**Interfaces:**
- Consumes: 既有 `lsp_did_open` 的底层逻辑（`lsp/mod.rs:141`）
- Produces:
  - `pub enum DocOrigin { Editor, Agent }`
  - `pub async fn ensure_doc_open(state: &LspState, workspace_root: &str, file_path: &str, lang: LanguageId) -> Result<(), String>`
  - `impl OpenDocs { pub fn origin_of(&self, uri: &str) -> Option<DocOrigin> }`

**为什么单独一个任务**：spec 把「`OpenDocs` 串扰」列为 **C1 前置条件**。agent 查的文件编辑器多半没打开过；若 server 对未 `didOpen` 的文档不答引用，**整条查询路径就是空的**——那正是本设计要消灭的「空冒充没有」。而一旦我们补上 `didOpen`，agent 打开的文档就进了编辑器的命名空间，其诊断/通知会漏到 UI。

- [ ] **Step 1: 先实测「server 要不要 didOpen」（结论决定后面的量级）**

用 spike 的探针（它默认会 `didOpen`）跑一次已知答案的查询：`LspManager::get`（`src-tauri/src/lsp/manager.rs:216:19`，应得 15 个调用点）。再跑一次跳过 `didOpen` 的变体。

给 `probe.mjs` 加一个 `--no-did-open` 开关（跳过 `textDocument/didOpen` 通知），两次对比：

```bash
node probe.mjs --server rust-analyzer --root <repo>   --file src-tauri/src/lsp/manager.rs --line 216 --col 19 --op references
node probe.mjs --server rust-analyzer --root <repo> --no-did-open   --file src-tauri/src/lsp/manager.rs --line 216 --col 19 --op references
```

**把两次结果写进 plan 末尾的「实测记录」**。判据：
- 两次都返回 15 → **rust-analyzer 不需要 didOpen**。此时本任务降级为「只做隔离，不做按需打开」，Step 2 跳过，Step 3 仍需做（因为未来别的 server 可能需要，且用户从编辑器侧打开的文档也会进 `OpenDocs`——但那种情况下不需要隔离）。
- 只有 didOpen 那次返回 15 → 按需打开是**必需**的，Step 2 与 Step 3 都要做。

> 这个实测是**必做**的：不做就不知道要写多少代码，也不知道不改会不会导致整条路径失效。

- [ ] **Step 2: 实现按需打开（Step 1 判定为必需时）**

在 `agent_query.rs` 的 `run_jump` 之前调用 `ensure_doc_open`。它复用既有 didOpen 的组装逻辑，但**打上 `DocOrigin::Agent` 标记**：

```rust
/// 确保 agent 要查的文档已对 server 打开。
///
/// 与编辑器路径共用同一份 didOpen 组装（不复制第二份），唯一区别是标记来源——
/// 标记用于把 agent 打开的文档产生的诊断/通知**挡在编辑器 UI 之外**。
pub async fn ensure_doc_open(
    state: &LspState,
    workspace_root: &str,
    file_path: &str,
    lang: LanguageId,
) -> Result<(), String> {
    let mgr = state.0.lock().await;
    let h = mgr
        .get(workspace_root, lang)
        .await
        .ok_or_else(|| "server not running".to_string())?;
    let uri = crate::lsp::protocol::resolve_file_uri(workspace_root, file_path);
    if h.docs.lock().await.origin_of(&uri).is_some() {
        return Ok(()); // 已打开（编辑器的或 agent 的）——不重复 didOpen
    }
    let text = std::fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    crate::lsp::did_open_marked(&h, &uri, lang, &text, DocOrigin::Agent).await
}
```

- [ ] **Step 3: 串扰隔离（无论 Step 1 结论如何都要做）**

`OpenDocs` 的条目加 `origin: DocOrigin`（默认 `Editor`——既有调用点语义不变，零迁移）。然后**找到通知推送路径**并过滤：

1. 搜 `lsp/manager.rs` 里 server → 前端 的通知转发（`start_reader` 附近，`publish`/`emit` 到前端的那一处）。
2. 若推送点能拿到 uri → 按 `origin_of(uri) == Agent` 丢弃该通知。
3. **拿不到就退到方案 ②**（spec 风险 1 的退路）：agent 用独立的 `OpenDocs` 实例，与编辑器不共享。此时在 plan 末尾记录这次偏离及原因。

- [ ] **Step 4: 跑测试**

```rust
#[test]
fn origin_defaults_to_editor_and_agent_docs_are_marked() {
    let mut d = OpenDocs::new();
    d.open("file:///c:/p/a.rs".into(), "rust".into(), "x".into());
    assert_eq!(d.origin_of("file:///c:/p/a.rs"), Some(DocOrigin::Editor));
    d.open_marked("file:///c:/p/b.rs".into(), "rust".into(), "y".into(), DocOrigin::Agent);
    assert_eq!(d.origin_of("file:///c:/p/b.rs"), Some(DocOrigin::Agent));
}

#[test]
fn unknown_uri_has_no_origin() {
    assert_eq!(OpenDocs::new().origin_of("file:///nope.rs"), None);
}
```

Run: `cd src-tauri && cargo test --lib lsp::docs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/lsp/docs.rs src-tauri/src/lsp/mod.rs src-tauri/src/lsp/agent_query.rs
git commit -m "feat(lsp): agent 按需 didOpen + 与编辑器的文档来源隔离"
```

---

### Task 7: runtime 派发 `runtime/lsp_agent.rs` + 拦截

**Files:**
- Create: `src-tauri/src/runtime/lsp_agent.rs`
- Modify: `src-tauri/src/runtime/mod.rs`（在 codegraph 拦截块之后、browser 之前加一段）
- Test: `runtime/mod.rs` 的既有测试风格（若无，本任务只做编译期验证 + Task 7 的端到端）

**Interfaces:**
- Consumes: `crate::lsp::agent_bridge::{LspQueryRequest, build_result_command}`、`crate::lsp::agent_query::run_agent_query`
- Produces: `pub async fn handle(app: AppHandle, stdin: Arc<TokioMutex<ChildStdin>>, req: LspQueryRequest)`

照 `src-tauri/src/runtime/browser_agent.rs:27` 的 `handle` 形态（读它对照）。

- [ ] **Step 1: 实现 `handle`**

```rust
//! agent LSP 查询的执行体。拦截点在 runtime/mod.rs，业务不内联——
//! 该文件有 1000 行拆分线（同 browser_agent.rs 的既有理由）。

use crate::lsp::agent_bridge::{build_result_command, LspQueryRequest};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as TokioMutex;
use tokio::process::ChildStdin;

pub async fn handle(app: AppHandle, stdin: Arc<TokioMutex<ChildStdin>>, req: LspQueryRequest) {
    let outcome = crate::lsp::agent_query::run_agent_query(
        &app,
        &req.tool,
        &req.args,
        &req.workspace_root,
    )
    .await;
    let payload = build_result_command(&req.request_id, outcome.payload);
    if let Ok(mut line) = serde_json::to_string(&payload) {
        line.push('\n');
        let mut g = stdin.lock().await;
        let _ = g.write_all(line.as_bytes()).await;
    }
}
```

- [ ] **Step 2: 在 `runtime/mod.rs` 加拦截**

在 codegraph 的 `continue;` 之后、browser 拦截之前插入（保持与既有块并列）：

```rust
// agent LSP 查询：同 codegraph，是 Rust ↔ Runtime 内部 request/response，
// 不转发 Vue。与 codegraph 的区别：查询本体不跳 runner——LspManager 就在
// 本进程，直接派发。业务在 runtime/lsp_agent.rs（本文件不内联，见 1000 行线）。
if let Some(req) = crate::lsp::agent_bridge::parse_lsp_query(&event) {
    let app2 = app.clone();
    let stdin2 = stdin_for_agent.clone();
    tokio::spawn(async move {
        crate::runtime::lsp_agent::handle(app2, stdin2, req).await;
    });
    continue;
}
```

- [ ] **Step 3: 编译 + 全量单测**

Run: `cd src-tauri && cargo test --lib`
Expected: 全绿（新代码不应破坏任何既有测试）

- [ ] **Step 4: 手工冒烟（Rust 侧闭环）**

用 Task 4 的 `MockLsp` 写一个最小集成测试：起 mock server → 构造 `lsp_query` 事件 → 断言回包 `cmd == "lsp_result"` 且 `request_id` 一致。放在 `runtime/lsp_agent.rs` 的 `#[cfg(test)]`。

Run: `cd src-tauri && cargo test --lib lsp_agent`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/runtime/lsp_agent.rs src-tauri/src/runtime/mod.rs
git commit -m "feat(lsp): runtime 派发——lsp_query 事件接进 LspManager"
```

---

### Task 8: 挂载闸门的数据源

**Files:**
- Modify: `src-tauri/src/commands/workspace/mod.rs`（新增函数，紧邻既有的 `is_codegraph_enabled_for_path`）
- Modify: `src-tauri/src/automation/scheduler.rs`（`codegraph_enabled` 下发的两处，并列加 `lsp_languages`）
- Test: `src-tauri/src/commands/workspace/mod.rs` 的 `#[cfg(test)]`

**Interfaces:**
- Produces: `pub fn lsp_languages_for_path(workspace_root: &str) -> Vec<String>`

**用途**：C1b 的挂载闸门第三档——「该工作区至少一种语言有已配置的 server」。现在是 session-worker 的新参数 `lspLanguages`。

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn lsp_languages_unknown_path_is_empty() {
    // 不存在的路径不该 panic，也不该假装有语言。
    assert!(crate::commands::workspace::lsp_languages_for_path("C:/definitely/not/here")
        .is_empty());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib lsp_languages_unknown_path`
Expected: 编译失败

- [ ] **Step 3: 实现**

```rust
```rust
/// 该工作区有哪几种语言**配得上语言服务器**（用于 agent LSP 工具的挂载闸门）。
///
/// 「配得上」= detector 探到了该语言 + `registry::resolve` 能解析出 server 来源
/// （用户覆盖 > 捆绑 > PATH，三级优先级由 resolve 内部处理，这里不重造）。
/// 两者缺一，工具挂了也只会返回 no_server——那就干脆别挂，省下每轮重发的工具 schema。
///
/// 与 `is_codegraph_enabled_for_path` 并列：都是「主进程算好、下发给 sidecar」的政策值
/// （见 scheduler.rs 的 trusted/codegraph_enabled 同款处理）。
pub fn lsp_languages_for_path(app: &tauri::AppHandle, workspace_root: &str) -> Vec<String> {
    use tauri::Manager;
    let Ok(settings) = app
        .try_state::<std::sync::Arc<crate::settings::SettingsService>>()
        .map(|s| crate::commands::settings::public_settings(s.inner()))
        .unwrap_or(Ok(crate::commands::settings::AppSettings::default()))
    else {
        return vec![];
    };
    crate::lsp::detector::detect_languages(std::path::Path::new(workspace_root))
        .into_iter()
        .filter(|lang| crate::lsp::registry::resolve(*lang, &settings, app).is_some())
        .map(|lang| lang.id_str().to_string())
        .collect()
}
```

**签名带 `app`**：`registry::resolve(lang, settings, app)` 需要它解析捆绑资源路径。无 app 就查不了捆绑 server，**不许**静默退化成「只查 PATH」——那会把一批用户判成「没有 LSP」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib lsp_languages`
Expected: 1 passed

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/workspace/mod.rs src-tauri/src/automation/scheduler.rs
git commit -m "feat(lsp): 挂载闸门数据源——该工作区配得上 LSP 的语言"
```

---

## 验收（C1a 完成时）

- [ ] `cd src-tauri && cargo test --lib` 全绿
- [ ] `cd src-tauri && cargo fmt --check` 无 diff
- [ ] 「无空冒充没有」红线可证：`grep -rn 'results: vec!\[\]' src-tauri/src/lsp/agent_*.rs` 的每一处，其 `status` 都不是 `Ready`

## 实测记录（执行时填写，勿删）

执行者填这一节——**结论决定 Task 6 的量级，不填等于没做那个任务**。

### didOpen 是否必需（Task 6 Step 1）

| 变体 | 结果 | 调用点数 | 耗时 |
|---|---|---|---|
| 带 didOpen | ok | **19** | 73.1s |
| `--no-did-open` | ok | **19** | 62.8s |

> 19 而非上次的 16：差值 3 恰是 C1a 自己新增的 `mgr.get()` 调用点
> （`agent_query.rs` 的 `lookup_symbol` / `server_for` 等）。**LSP 把本次改动
> 自己算了进去**——算是一次意外的交叉验证。

**结论：不需要。** 两次的候选点逐条相同（`D1.json` / `D2.json`），rust-analyzer 对
**未 didOpen 的文件**照样回答 `references`——它的工程图来自 `cargo metadata`，
不依赖文档同步。

⇒ **Task 6 Step 2（按需 didOpen）判定为不实施**，Step 3（串扰隔离）随之也不需要：
agent 路径从不 `didOpen`，就没有「agent 打开的文档」需要挡在编辑器 UI 之外。
Task 6 整体结案为「前提被实测否证，不实施」。

**但这引出一条必须写下来的降级性质**：若将来换成确实需要 didOpen 的 server
（jdtls / tsserver 的某些操作），`probe_ready` 会跟着失败 → 返回 `indexing`
而不是假装 `ready`。也就是说**最坏情况是「LSP 不可用、退回 Grep」，绝不会是
「拿空冒充没有」**。这正是本设计要保证的性质。届时实施按需 didOpen 的触发条件 =
「在某个语言上观察到 references 恒为空且 probe 恒失败」。

### 串扰隔离落在哪个方案（Task 6 Step 3）

- 推送路径能否拿到 uri：待填
- 采用方案：待填（①打标过滤 / ②独立命名空间）
- 若偏离方案 ①，原因：待填

## 交付给 C1b 的接口（冻结）

- 帧：`lsp_query` / `lsp_result`（见文首「帧契约」）
- 状态词八个：`ready` / `indexing` / `no_symbol` / `no_server` / `untrusted` / `timeout` / `gone` / `error`
- 工具名四个：`symbols` / `references` / `definition` / `implementations`
- 挂载闸门数据源：`lsp_languages_for_path(app, workspace_root) -> Vec<String>`

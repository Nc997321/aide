# agent 自建 tab + parking 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把内置浏览器的"不显示"从**内核级隐藏**改成 **parking（挪出可见区）**，让非活动 tab 继续合成/接收输入/可截图，并给 agent 补上 tab 级能力（open / close / navigate / back / forward / focus）。

**Architecture:** 引擎端口 `set_visible` → `set_displayed`，parking 实现藏在 WebView2 适配器（"隐藏会杀死引擎"是引擎知识）。领域加 `label` / `origin`；facade 在 create/close 时广播 `browser-view` 生命周期事件、并提供 `request_focus` 广播 `browser-focus` 请求。**显示权仍在面板**（方案 A）：agent 的 focus 只是请求，由 UI 执行。sidecar 侧新增**一个** `browser_tab` 工具（六个 action），能力只落 `agent-sidecar/src/extensions/`。

**Tech Stack:** Tauri v2（Rust 后端）+ Vue 3 + TypeScript；sidecar 是 Node/TS（MCP 工具层）；引擎是 wry 0.55.1 / WebView2。

**Spec:** `docs/superpowers/specs/2026-09-21-agent-tabs-and-parking-design.md`（**执行前先读**：本文档的实现细节都以它为准；探针实测数据在它的「实测记录」节）

## Global Constraints

- **能力只进 `agent-sidecar/src/extensions/`**（用户明确要求）。`packages/aide-sdk` 唯一允许的改动是 `useCustomizations.ts` 里的一句**文案镜像**。
- **命令层一律 `async fn`**：引擎调用内部 `run_on_main_thread` + 阻塞 `recv`，从主线程调会自锁（`adapter/webview2/mod.rs:106-111` 的文件头有完整线程契约）。新增命令不埋 `trace_command`（那只对同步命令有意义）。
- **UI 状态只认事件通道**，不做乐观更新（CLAUDE.md 红线）。新增/关闭视图、focus 请求都必须广播。
- **广播一律经 `spawn_blocking`**（`AppHandle::emit` 的投递终点是 `Webview::eval`，在主线程调就是主线程等自己）。
- **parking 时绝不调 `ICoreWebView2Controller::SetIsVisible(false)`**，也不调 `hide()`——那是内核级制动（不合成、rAF 停摆、截图挂到超时），本特性的全部理由就是绕开它。
- 前端颜色/圆角/间距一律走 `var(--aide-*)` 语义 token，**禁止硬编码**。
- 函数 ≤40 行、嵌套 ≤3 层、单函数输入 ≤4（超了按职责拆函数，不是塞 options 对象）。
- 每个任务结束时 `cargo test --lib`（在 `src-tauri/`）与 `pnpm test`（仓库根）必须全绿。
- 本特性**不新增子进程**，故不涉及 `CREATE_NO_WINDOW`。

## 文件结构

| 层 | 文件 | 职责 |
|---|---|---|
| 引擎端口 | `src-tauri/src/browser/port/types.rs` | `BrowserView` 领域状态：`displayed` / `label` / `origin` |
| | `src-tauri/src/browser/port/engine.rs` | `BrowserEngine` trait + `CreateCfg`（不变量：适配器只管画，不管策略） |
| 适配器 | `src-tauri/src/browser/adapter/webview2/mod.rs` | **parking 的唯一实现点** |
| 门面 | `src-tauri/src/browser/facade.rs` | 编排 + 广播（`browser-nav` / `browser-view` / `browser-focus`） |
| 边界 | `src-tauri/src/browser/dto.rs` | 跨 IPC 形状（扁平、无业务方法） |
| 桥 | `src-tauri/src/browser/agent_bridge.rs` | sidecar op 的解析（纯函数，无 IO） |
| 执行体 | `src-tauri/src/runtime/browser_agent.rs` | op → 门面调用 + **策略**（view_id 解析、默认视口） |
| 命令 | `src-tauri/src/commands/browser.rs` + `lib.rs` | UI 薄壳 + 注册 |
| 前端 | `src/composables/browser/*.ts` | 浏览器专属 composable（本次归一到这个目录） |
| | `src/components/Browser/BrowserPanel.vue` | 标签模型、可见性总闸、事件消费 |
| sidecar | `agent-sidecar/src/extensions/browser/tab.ts`（新） | `browser_tab` 六个 action 的编排与文案 |
| | `agent-sidecar/src/extensions/browserTools.ts` | 工具表（一个工具一行） |
| | `agent-sidecar/src/extensions/browserMcp.ts` / `browserSkill.ts` | 放行规则 / 说明 / reference |

---

### Task 1: 领域与端口改名 `visible` → `displayed`（机械改名，行为不变）

**Files:**
- Modify: `src-tauri/src/browser/port/types.rs`（`BrowserView.visible` 字段、`new()` 初始化、`visible()`/`set_visible()` 方法）
- Modify: `src-tauri/src/browser/port/types_test.rs:83,333,335`
- Modify: `src-tauri/src/browser/port/engine.rs:134`（trait 方法签名）
- Modify: `src-tauri/src/browser/adapter/webview2/mod.rs:149-158`（impl 改名；**实现仍是 `show()`/`hide()`，parking 在 Task 2**）
- Modify: `src-tauri/src/browser/adapter/unsupported.rs:39`
- Modify: `src-tauri/src/browser/facade.rs:193-200`
- Modify: `src-tauri/src/browser/dto.rs:86,97` + `dto_test.rs:139`
- Modify: `src-tauri/src/runtime/browser_agent.rs:134,159`（只改字段名，**规则不动**）
- Modify: `src-tauri/src/commands/browser.rs:53-56` + `src-tauri/src/lib.rs:345`
- Modify: `src/components/Browser/BrowserPanel.vue`（`setVisible` 两处调用）+ `Browser/BrowserPanel.test.ts`
- Modify: `agent-sidecar/src/extensions/browser/format.ts:137`
- Move: `src/composables/useEmbeddedBrowser.ts` → `src/composables/browser/useEmbeddedBrowser.ts`
- Move: `src/composables/useBrowserBookmarks.ts` → `src/composables/browser/useBrowserBookmarks.ts`（顺带归一目录，见 Task 7 的 import 清单）
- Modify: `scripts/check-tauri-imports.mjs:27-28`（白名单按字面路径登记）

**Interfaces:**
- Produces: `BrowserEngine::set_displayed(&self, id: &BrowserViewId, displayed: bool) -> Result<(), EngineError>`；`BrowserView::displayed(&self) -> bool` / `set_displayed(&mut self, bool)`；`BrowserViewDto.displayed: bool`；前端 `setDisplayed(id: string, displayed: boolean): Promise<void>`（命令名 `browser_set_displayed`）

- [ ] **Step 1: 先跑一遍基线测试**

```bash
cd src-tauri && cargo test --lib browser:: 2>&1 | tail -5
cd .. && pnpm test -- --run 2>&1 | tail -5
```
Expected: 全绿（这是"改动前"的基线）。

- [ ] **Step 2: 改名（Rust 侧）**

`port/types.rs`：字段 `visible: bool` → `displayed: bool`；`new()` 里 `visible: true` → `displayed: true`；方法
```rust
    /// 是否露在面板上（**不是**"引擎是否可用"——parked 的视图引擎照样活着）。
    pub fn displayed(&self) -> bool {
        self.displayed
    }
    pub fn set_displayed(&mut self, displayed: bool) {
        self.displayed = displayed;
    }
```
`port/engine.rs` / 两个 adapter / `facade.rs` / `commands/browser.rs` / `lib.rs` / `dto.rs` / `browser_agent.rs` / `types_test.rs` / `dto_test.rs` 同步改（`visible` → `displayed`、`set_visible` → `set_displayed`、命令名 `browser_set_visible` → `browser_set_displayed`）。

- [ ] **Step 3: 改名（前端 + sidecar）**

移动两个 composable 到 `src/composables/browser/`，改 import 路径（`BrowserPanel.vue`、`BookmarkFolderMenu.test.ts`、`useBrowserBookmarks.test.ts`），并把 `useEmbeddedBrowser.ts` 里的 `BrowserViewDto.visible` → `displayed`、`setVisible` → `setDisplayed`。`scripts/check-tauri-imports.mjs:27-28` 的两条路径跟着搬。`format.ts:137` 的 `view["visible"]` → `view["displayed"]`。

```bash
git mv src/composables/useEmbeddedBrowser.ts src/composables/browser/useEmbeddedBrowser.ts
git mv src/composables/useBrowserBookmarks.ts src/composables/browser/useBrowserBookmarks.ts
grep -rn "useEmbeddedBrowser\|useBrowserBookmarks" src/ scripts/ packages/ | grep -v node_modules
```

- [ ] **Step 4: 验证**

```bash
cd src-tauri && cargo test --lib browser:: 2>&1 | tail -5
cd .. && pnpm build && pnpm check:tauri-imports && pnpm test -- --run 2>&1 | tail -5
```
Expected: 全绿；`pnpm build` 里的 `vue-tsc --noEmit` 是改名遗漏的兜底。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(browser): visible → displayed（语义=露在面板上，不是引擎可用）"
```

---

### Task 2: 适配器 parking（行为变更点）

**Files:**
- Modify: `src-tauri/src/browser/port/engine.rs:47-60`（`CreateCfg` 加 `displayed: bool`）
- Modify: `src-tauri/src/browser/adapter/webview2/mod.rs:64-158`（`set_displayed` + `create` 的落点）
- Modify: `src-tauri/src/browser/facade.rs:114-120`（`create` 传 `displayed`）
- Modify: `src-tauri/src/browser/dto.rs:169-173`（`CreateBrowserDto` 加 `displayed: Option<bool>`）

**Interfaces:**
- Consumes: Task 1 的 `set_displayed`
- Produces: `CreateCfg { …, displayed: bool }`；`CreateBrowserDto { url, bounds, label: Option<String>, origin: Option<String>, displayed: Option<bool> }`（`label`/`origin` 字段在 Task 3 落地，此处先把 `displayed` 加上，缺省 `true`）

- [ ] **Step 1: 写失败的测试（`CreateCfg` 的形状契约）**

`port/engine.rs` 的测试模块里加：

```rust
    /// 新视图的初始显示状态是**显式**的：agent 开的 tab 必须能"建了但不露头"，
    /// 否则会先在面板上闪一帧（旧路径 create 可见 → 随即被 hide）。
    #[test]
    fn create_cfg_carries_explicit_displayed() {
        let cfg = CreateCfg {
            initial_url: url::Url::parse("https://example.com/").unwrap(),
            bounds: crate::browser::port::types::Bounds::new(
                crate::browser::port::types::Position::new(0.0, 0.0),
                crate::browser::port::types::Size::try_new(10.0, 10.0).unwrap(),
            ),
            user_agent: None,
            devtools: false,
            displayed: false,
            on_page_load: None,
        };
        assert!(!cfg.displayed);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib browser::port::engine` → Expected: 编译失败 `missing field displayed`。

- [ ] **Step 3: 实现 parking**

`adapter/webview2/mod.rs` 顶部常量：

```rust
/// 停靠点：远超任何真实客户区的固定逻辑坐标。子窗口被父窗口裁剪 ⇒ 用户看不见；
/// 而 HWND 保持 WS_VISIBLE、`IsVisible` **不动** ⇒ 引擎照常合成。
/// 2026-09-21 探针实测：parked 视图的 rAF / `Page.captureScreenshot` / CDP 真实点击
/// 与前台视图**逐项等价**（对照组 `set_visible(false)` 三项全灭）。
const PARK_X: f64 = 20000.0;
const PARK_Y: f64 = 20000.0;
```

`set_displayed` 的实现：

```rust
    fn set_displayed(&self, id: &BrowserViewId, displayed: bool) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        if displayed {
            return wv
                .show()
                .map_err(|e| EngineError::Internal(format!("show: {e}")));
        }
        // 只挪位置：**不调 `hide()`**（`SetIsVisible(false)` 是内核级制动，见文件头 PARK 常量注释）。
        wv.set_position(LogicalPosition::new(PARK_X, PARK_Y))
            .map_err(|e| EngineError::Internal(format!("park: {e}")))
    }
```

`create` 里把 `pos` 改成按 `cfg.displayed` 选落点（**建的时候就在停靠点，避免闪帧**）：

```rust
        let pos = if cfg.displayed {
            LogicalPosition::new(cfg.bounds.position().x(), cfg.bounds.position().y())
        } else {
            LogicalPosition::new(PARK_X, PARK_Y)
        };
        let size = LogicalSize::new(cfg.bounds.size().w(), cfg.bounds.size().h());
```

`facade.rs` 的 `create`：`displayed: dto.displayed.unwrap_or(true)`（面板路径不传 = true；agent 路径显式 false）。

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo test --lib browser::` → Expected: PASS。
**真机验证放到 Task 11**（parking 的效果没有单测能覆盖——它要真 WebView2；探针已经把机制证过了，这一步只是接线）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): 不显示改为 parking（挪出可见区，不调 SetIsVisible）"
```

---

### Task 3: `label` / `origin` 字段 + `browser-view` 生命周期事件

**Files:**
- Modify: `src-tauri/src/browser/port/types.rs`（`BrowserView` 加 `label: Option<String>` / `origin: BrowserOrigin`）
- Modify: `src-tauri/src/browser/port/engine.rs`（`CreateCfg` 加 `label` / `origin`）
- Modify: `src-tauri/src/browser/dto.rs`（`BrowserViewDto` 加 `label` / `origin`；`CreateBrowserDto` 加两个可选字段；新增 `ViewEventDto` / `ViewEventKind`）
- Modify: `src-tauri/src/browser/facade.rs`（`create` 落 label/origin + 广播 created；`close` 广播 closed）
- Test: `src-tauri/src/browser/port/types_test.rs`、`dto_test.rs`

**Interfaces:**
- Produces:
  - `pub enum BrowserOrigin { User, Agent }`（`Serialize + Deserialize`，snake_case → `"user"` / `"agent"`；创建入参也用它）
  - `BrowserView::label() -> Option<&str>` / `set_label(Option<String>)`、`origin() -> BrowserOrigin`
  - `BrowserViewDto { …, label: Option<String>, origin: BrowserOrigin }`
  - `pub const VIEW_EVENT: &str = "browser-view";`
  - `ViewEventDto { id: String, kind: ViewEventKind, label: Option<String>, origin: BrowserOrigin, displayed: bool }`
  - `pub const FOCUS_EVENT: &str = "browser-focus";`（Task 5 用）

- [ ] **Step 1: 写失败的测试**

`port/types_test.rs`：

```rust
    /// label/origin 是**视图自持属性**（跟着视图走，不是面板的标签页状态）。
    #[test]
    fn view_keeps_label_and_origin() {
        let mut v = BrowserView::new(
            BrowserViewId::try_new("browser-1").unwrap(),
            bounds(),
        );
        assert!(v.label().is_none(), "默认没有 label：页面标题够用时不该有假名字");
        assert_eq!(v.origin(), BrowserOrigin::User);

        v.set_label(Some("vue-admin dev".into()));
        v.set_origin(BrowserOrigin::Agent);
        assert_eq!(v.label(), Some("vue-admin dev"));
        assert_eq!(v.origin(), BrowserOrigin::Agent);
    }
```

`dto_test.rs`：

```rust
    /// 生命周期事件的载荷形状：前端靠 `kind` 增删标签页，缺字段就是静默不更新。
    #[test]
    fn view_event_dto_carries_identity_and_kind() {
        let mut v = BrowserView::new(BrowserViewId::try_new("browser-7").unwrap(), bounds());
        v.set_label(Some("dev".into()));
        v.set_origin(BrowserOrigin::Agent);

        let created = ViewEventDto::of(&v, ViewEventKind::Created);
        assert_eq!(created.id, "browser-7");
        assert_eq!(created.kind, ViewEventKind::Created);
        assert_eq!(created.label.as_deref(), Some("dev"));
        assert_eq!(created.origin, BrowserOrigin::Agent);
        assert!(created.displayed);

        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::json!({
                "id": "browser-7", "kind": "created", "label": "dev",
                "origin": "agent", "displayed": true
            })
        );
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib browser::` → Expected: 编译失败（无 `label` / `BrowserOrigin` / `ViewEventDto`）。

- [ ] **Step 3: 实现**

`port/types.rs`：

```rust
/// 视图是谁开的。**用户自己在标签条上一眼要能分**（三个 agent 各一个 tab 时尤其）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserOrigin {
    User,
    Agent,
}
```
`BrowserView` 加两个字段 + 四个访问器；`BrowserView::new(id, bounds)` 默认 `label: None` / `origin: User`（保持既有调用点不改签名，label/origin 走 setter）。

`dto.rs`：

```rust
/// 视图生命周期事件（`browser-view`）：**标签页集合是 UI 状态**，agent 开关视图必须让面板知道
/// （CLAUDE.md 红线：改变状态的操作一律走广播，不做乐观更新）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewEventKind {
    Created,
    Closed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ViewEventDto {
    pub id: String,
    pub kind: ViewEventKind,
    pub label: Option<String>,
    pub origin: BrowserOrigin,
    pub displayed: bool,
}

impl ViewEventDto {
    pub fn of(view: &BrowserView, kind: ViewEventKind) -> Self {
        Self {
            id: view.id().as_str().to_string(),
            kind,
            label: view.label().map(str::to_string),
            origin: view.origin(),
            displayed: view.displayed(),
        }
    }
}
```

`facade.rs`：`create` 成功后（拿快照前）广播 created；`close` 在引擎销毁前先取快照、销毁后广播 closed：

```rust
pub const VIEW_EVENT: &str = "browser-view";

/// 广播视图生命周期（跑在 worker：emit 的投递终点是 `Webview::eval`，见 `apply_page_load` 的注释）。
fn broadcast_view(app: &AppHandle, event: ViewEventDto) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _ = app.emit(VIEW_EVENT, event);
    });
}
```

`close` 里注意顺序：**先** `let snapshot = {reg.get(&id)...}`，**再**引擎销毁 + 注册表移除，**最后**广播 `Closed`（带着 label/origin 的快照，前端才能把标签关对）。

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo test --lib browser::` → Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): 视图加 label/origin + browser-view 生命周期事件"
```

---

### Task 4: `browser_views_list` 命令（面板挂载对账用）

**Files:**
- Modify: `src-tauri/src/commands/browser.rs`（新增命令）
- Modify: `src-tauri/src/lib.rs`（注册）
- Modify: `src/composables/browser/useEmbeddedBrowser.ts`（`listViews()`）

**Interfaces:**
- Consumes: `BrowserFacade::list_views()`（已存在，`facade.rs:213`）
- Produces: 命令 `browser_views_list() -> Vec<BrowserViewDto>`；前端 `listViews(): Promise<BrowserViewDto[]>`

- [ ] **Step 1: 实现命令**

```rust
/// 列出全部视图（面板挂载时对账用）。**与 agent 的 `list_views` 同一个门面方法**——
/// 两条消费路径不能各查一份状态（那是"面板看不见 agent 开的 tab"的来源）。
#[tauri::command]
pub async fn browser_views_list(app: AppHandle) -> CmdResult<Vec<BrowserViewDto>> {
    BrowserFacade::new(&app)
        .list_views()
        .map_err(|e| e.to_string())
}
```

`lib.rs` 的 `invoke_handler` 里在 `commands::browser::browser_set_displayed` 旁加一行。

- [ ] **Step 2: 实现前端封装**

```ts
    /** 面板挂载时的对账来源：视图可能**先于面板**被创建（agent 先开 tab、用户还没点开面板）。 */
    listViews(): Promise<BrowserViewDto[]> {
      return invoke<BrowserViewDto[]>("browser_views_list");
    },
```

- [ ] **Step 3: 验证**

Run: `cd src-tauri && cargo test --lib browser:: && cd .. && pnpm build` → Expected: 通过（命令层是薄壳，真正的行为由 Task 7 的面板测试覆盖）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(browser): browser_views_list 命令（面板挂载对账）"
```

---

### Task 5: focus 请求（事件，不改状态）

**Files:**
- Modify: `src-tauri/src/browser/facade.rs`（`request_focus`）
- Modify: `src-tauri/src/browser/agent_bridge.rs`（`Focus` op + 解析 + op_name）
- Modify: `src-tauri/src/runtime/browser_agent.rs`（执行分支）
- Test: `src-tauri/src/browser/agent_bridge.rs` 的 `mod tests`

**Interfaces:**
- Consumes: `FOCUS_EVENT`（Task 3 定义）、`resolve_view`（Task 6 收紧后的规则）
- Produces: `BrowserFacade::request_focus(&self, id_raw: &str) -> Result<(), FacadeError>`；`BrowserQuery::Focus { view_id: Option<String> }`；事件 `browser-focus` 载荷 `{ "id": "browser-1" }`

- [ ] **Step 1: 写失败的测试**

```rust
    /// focus 是**请求**（显示权在面板）：桥只认识这一个 op，不做任何状态迁移。
    #[test]
    fn parses_focus_op() {
        let req = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r1", "op": "focus", "view_id": "browser-2"
        }))
        .expect("是本桥事件");
        assert_eq!(
            req.query,
            BrowserQuery::Focus { view_id: Some("browser-2".into()) }
        );
        assert_eq!(req.query.op_name(), "focus");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib browser::agent_bridge` → Expected: 编译失败（无 `Focus` 变体）。

- [ ] **Step 3: 实现**

`agent_bridge.rs`：枚举加 `Focus { view_id: Option<String> }`（注释写清"只是请求"）、`op_name` → `"focus"`、`parse_query` 加分支。

`facade.rs`：

```rust
    /// **请求**把某个视图露到面板上。只校验 id 存在 + 广播，**不改任何状态**——
    /// 显示权在面板（空标签没有视图、还有宽度档/浮层让位这些纯 UI 状态，领域不该被卷进来）。
    pub fn request_focus(&self, id_raw: &str) -> Result<(), FacadeError> {
        let id = self.parse_id(id_raw)?;
        if self.lock()?.get(&id).is_none() {
            return Err(FacadeError::ViewNotFound(id_raw.to_string()));
        }
        let app = self.app.clone();
        let payload = serde_json::json!({ "id": id.as_str() });
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = app.emit(FOCUS_EVENT, payload);
        });
        Ok(())
    }
```

`runtime/browser_agent.rs`：`BrowserQuery::Focus { view_id }` 分支 → `resolve_view` → `facade.request_focus(&id)` → `ok_payload(json!({ "view_id": id, "requested": true }))`。

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo test --lib browser::` → Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): focus 请求事件 + agent_bridge 的 focus op"
```

---

### Task 6: agent 的 open / close / navigate / back / forward + `resolve_view` 收紧

**Files:**
- Modify: `src-tauri/src/browser/agent_bridge.rs`（五个 op + 解析 + 测试）
- Modify: `src-tauri/src/runtime/browser_agent.rs`（执行分支、默认视口常量、`resolve_view` 规则收紧、`summarise` 带 label/parked）

**Interfaces:**
- Consumes: `BrowserFacade::{create, close, navigate, go_back, go_forward}`（均已存在）
- Produces:
  - `BrowserQuery::Open { url: String, label: Option<String> }` / `Close { view_id: Option<String> }` / `Navigate { view_id: Option<String>, url: String }` / `Back { view_id: Option<String> }` / `Forward { view_id: Option<String> }`
  - `const DEFAULT_VIEW_W: f64 = 1280.0;` / `const DEFAULT_VIEW_H: f64 = 800.0;`（策略层：门面不参与）
  - `resolve_view` 新规则（缺省只在"全库恰好一个视图"时命中）

- [ ] **Step 1: 写失败的测试**

`agent_bridge.rs`：

```rust
    #[test]
    fn parses_tab_lifecycle_ops() {
        let open = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r", "op": "open",
            "url": "http://localhost:5173/", "label": "vue-admin dev"
        }))
        .unwrap();
        assert_eq!(
            open.query,
            BrowserQuery::Open {
                url: "http://localhost:5173/".into(),
                label: Some("vue-admin dev".into())
            }
        );

        let nav = parse_browser_query(&json!({
            "type": "browser_query", "request_id": "r", "op": "navigate",
            "view_id": "browser-1", "url": "http://localhost:5173/x"
        }))
        .unwrap();
        assert_eq!(
            nav.query,
            BrowserQuery::Navigate {
                view_id: Some("browser-1".into()),
                url: "http://localhost:5173/x".into()
            }
        );

        // 缺 url 一律 Malformed（不静默丢弃）
        assert!(matches!(
            parse_browser_query(&json!({"type": "browser_query", "request_id": "r", "op": "open"}))
                .unwrap()
                .query,
            BrowserQuery::Malformed(_)
        ));
    }
```

`runtime/browser_agent.rs` 的 `mod tests`（现有 `view()` 夹具要同步加 `label`/`origin`/`displayed` 字段）：

```rust
    /// 收紧后的缺省解析：**多视图一律要求显式 `view_id`**。
    /// 旧规则"缺省 + 恰一个可见视图 → 用它"在多 agent 下会让 A 的调用落到用户正看的那个 tab。
    #[test]
    fn default_view_resolution_requires_a_single_view() {
        // 三视图（一个 displayed、两个 parked）→ 缺省必须报错，不能猜
        assert!(resolve_from(vec![
            view("browser-1", true, Some("http://a/")),
            view("browser-2", false, Some("http://a/")),
            view("browser-3", false, Some("http://a/")),
        ], None)
        .is_err());

        // 恰好一个视图 → 用它（面板收起时的常见情形）
        assert_eq!(
            resolve_from(vec![view("browser-1", false, Some("http://a/"))], None).unwrap(),
            "browser-1"
        );
    }
```

（`resolve_from` 是给测试用的薄包装：把 `resolve_view` 的"取列表"依赖抽成参数——实现时把 `resolve_view` 拆成 `resolve_from(views: &[BrowserViewDto], want: Option<&str>)` + 取列表的外壳，**函数 ≤40 行**的要求顺带满足。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib browser::runtime` → 注：`runtime::browser_agent` 的测试在 `src-tauri/src/runtime/browser_agent.rs` 内，用 `cargo test --lib runtime::browser_agent` → Expected: 编译失败。

- [ ] **Step 3: 实现**

`agent_bridge.rs`：五个变体 + `op_name` + 解析（`open` 必填 `url`；`navigate` 必填 `url`；`close`/`back`/`forward` 只要可选 `view_id`）。

`runtime/browser_agent.rs`：

```rust
/// agent 建视图的默认视口（**策略**：门面不认识"默认多大"）。
/// parked 期间页面按这个宽度布局；用户切过去看时会响应式重排一次（spec 已记为已知代价）。
const DEFAULT_VIEW_W: f64 = 1280.0;
const DEFAULT_VIEW_H: f64 = 800.0;
```

`Open` 分支：

```rust
        BrowserQuery::Open { url, label } => {
            let dto = CreateBrowserDto {
                url,
                bounds: BoundsDto {
                    x: 0.0,
                    y: 0.0,
                    w: DEFAULT_VIEW_W,
                    h: DEFAULT_VIEW_H,
                },
                label,
                origin: Some(BrowserOrigin::Agent),
                displayed: Some(false), // parked：不抢用户的前台
            };
            match facade.create(&dto) {
                Ok(view) => ok_payload(serde_json::json!({
                    "view_id": view.id,
                    "url": url_of(&view),
                    "displayed": view.displayed,
                })),
                Err(e) => err_payload(format!("cannot open a browser view: {e}")),
            }
        }
```

（`facade.create` 现有签名是 `create(&self, url_raw: &str, bounds: BoundsDto)`——**改成 `create(&self, dto: &CreateBrowserDto)`**，命令层 `browser_create` 与桥共用同一条路径，避免两份编排。`BrowserOrigin` 要 `Serialize + Deserialize`，创建入参用它而不是裸字符串——否则 `"agent"` 这类字面量会散到调用点。）

`resolve_view` 新规则（写进文档注释）：显式 id 必须存在 → 否则"全库恰好一个视图"才用它 → 其余报错 + 清单。`summarise` 每行带上 label 与状态：`browser-2 "vue-admin dev" http://localhost:5173 (parked)`。

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo test --lib` → Expected: PASS（全量，含未动的模块）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): agent 的 open/close/navigate/back/forward + 缺省 view_id 不猜"
```

---

### Task 7: 前端消费（useBrowserViews + 面板生命周期对账）

**Files:**
- Create: `src/composables/browser/useBrowserViews.ts`
- Modify: `src/composables/useRightPanel.ts`（`ensureBrowserShown()`）
- Modify: `src/composables/browser/useEmbeddedBrowser.ts`（`onBrowserView` / `onBrowserFocus`）
- Modify: `src/components/Browser/BrowserPanel.vue`（事件消费、快照对账、label/归属、pending focus）
- Modify: `src/App.vue`（挂一次 `useBrowserViews()`）
- Test: `src/composables/browser/useBrowserViews.test.ts`（新）、`src/composables/useRightPanel.test.ts`、`src/components/Browser/BrowserPanel.test.ts`

**Interfaces:**
- Consumes: Task 3/4/5 的事件与命令
- Produces:
  - `useRightPanel().ensureBrowserShown(): void`（幂等展开）
  - `useBrowserViews()`：模块级单例；导出 `pendingFocusViewId`（`Ref<string | null>`）与 `consumePendingFocus(viewId): boolean`
  - `useEmbeddedBrowser().onBrowserView(cb)` / `.onBrowserFocus(cb)`

- [ ] **Step 1: 写失败的测试**

`src/composables/useRightPanel.test.ts`：

```ts
  it("ensureBrowserShown 幂等：用户正看着浏览器时不会把面板收起来", () => {
    const p = useRightPanel();
    p.select("browser"); // 打开
    expect(p.collapsed.value).toBe(false);
    p.ensureBrowserShown();
    p.ensureBrowserShown();
    expect(p.collapsed.value).toBe(false); // select() 会 toggle 收起，ensureBrowserShown 不许
    expect(p.tab.value).toBe("browser");
  });

  it("ensureBrowserShown 会从别的 tab 切回浏览器", () => {
    const p = useRightPanel();
    p.select("files");
    p.ensureBrowserShown();
    expect(p.tab.value).toBe("browser");
    expect(p.collapsed.value).toBe(false);
  });
```

`src/composables/browser/useBrowserViews.test.ts`：

```ts
  it("focus 请求：先落地 pending，面板挂载后消费一次", () => {
    const v = useBrowserViews();
    v.__handleFocusForTest({ id: "browser-9" });
    expect(v.pendingFocusViewId.value).toBe("browser-9");
    expect(v.consumePendingFocus("browser-9")).toBe(true);
    expect(v.pendingFocusViewId.value).toBeNull(); // 消费即清
    expect(v.consumePendingFocus("browser-9")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/composables/useRightPanel.test.ts` → Expected: FAIL（`ensureBrowserShown is not a function`）。

- [ ] **Step 3: 实现**

`useRightPanel.ts`：

```ts
/**
 * 幂等展开浏览器面板。**不能用 `select('browser')`**：那是 toggle，用户正看着浏览器时会把它收起来
 * ——agent 的 focus 请求会变成"把用户的面板关掉"。
 */
function ensureBrowserShown() {
  browserEverActive.value = true;
  tab.value = "browser";
  collapsed.value = false;
}
```

`useEmbeddedBrowser.ts` 加两个订阅（照 `onBrowserNav` 的形状）：

```ts
export function onBrowserView(cb: (e: ViewEventDto) => void): Promise<UnlistenFn> {
  return listen<ViewEventDto>("browser-view", (ev) => cb(ev.payload));
}
export function onBrowserFocus(cb: (e: { id: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("browser-focus", (ev) => cb(ev.payload));
}
```

`useBrowserViews.ts`（常驻；App 挂一次）：

```ts
// 浏览器视图的**常驻订阅层**：面板是懒挂载的（第一次点开才挂），而 agent 可能在那之前就开了 tab、
// 甚至请求 focus——这些事件必须有人接住，否则"agent 开了 tab 但面板里什么都没有"。
import { ref } from "vue";
import { onBrowserView, onBrowserFocus } from "./useEmbeddedBrowser";
import { useRightPanel } from "../useRightPanel";
import type { ViewEventDto } from "./useEmbeddedBrowser";

/** 面板挂载后要切过去的视图（focus 请求先到、面板后到）。模块级：单例，与 useRightPanel 同范式。 */
const pendingFocusViewId = ref<string | null>(null);
/** 面板未挂载期间收到的生命周期事件（挂载时回放，避免丢增量）。 */
const buffered = ref<ViewEventDto[]>([]);
let installed = false;

function handleView(e: ViewEventDto): void {
  buffered.value.push(e); // 面板消费后自行清空（见 consumeViewEvents）
  if (e.kind === "closed" && pendingFocusViewId.value === e.id) pendingFocusViewId.value = null;
}

function handleFocus(e: { id: string }): void {
  useRightPanel().ensureBrowserShown(); // 幂等展开：面板没挂过就挂，挂着就别动
  pendingFocusViewId.value = e.id;
}

/** 常驻安装（幂等）：App.vue 挂一次，之后不再摘。 */
export function useBrowserViews() {
  if (!installed) {
    installed = true;
    void onBrowserView(handleView);
    void onBrowserFocus(handleFocus);
  }
  return {
    pendingFocusViewId,
    /** 面板挂载/渲染时取走增量（取走即清空）。 */
    takeViewEvents(): ViewEventDto[] {
      const out = buffered.value;
      buffered.value = [];
      return out;
    },
    consumePendingFocus(viewId: string): boolean {
      if (pendingFocusViewId.value !== viewId) return false;
      pendingFocusViewId.value = null;
      return true;
    },
    /** 仅供测试：直接投递一次 focus 载荷（免起事件桥）。 */
    __handleFocusForTest: handleFocus,
  };
}
```
职责三条：① 订阅 `browser-view`（**全部进缓冲**，见下）；② 订阅 `browser-focus` → `ensureBrowserShown()` + 记 `pendingFocusViewId`；③ 暴露 `consumePendingFocus` / `takeViewEvents`。

**面板只用这一条通道**（不要在面板里再 `onBrowserView` 订阅一次）：事件一律进 `buffered`，面板 `watch(() => buffered.value.length)` → `takeViewEvents()` 取走并清空 → 应用到标签。这样①挂载前的事件不会丢，②同一事件不会被 live 订阅与缓冲各应用一次。

`BrowserPanel.vue`：
- `onMounted` 里 `await browser.listViews()` 对账：库里有的视图而 `tabs` 里没有 → 补一个标签（`origin`/`label` 从 DTO 取）；`tabs` 里有而库里没有 → 去掉。
- 消费 `browser-view`：`created` → 补标签；`closed` → 若关的是活动标签，按现有 `closeTab` 的选择逻辑切一个（**视图已经没了，不能再调 `browser.close`**——直接删标签）。
- 消费 focus：`consumePendingFocus(id)` → 找到对应标签 → `activeId = t.id`。
- 标签条渲染 `label`（页面标题为空时）与归属标记（`origin === "agent"` 时给一个小标记 + tooltip），颜色走 `var(--aide-*)`。

- [ ] **Step 4: 验证**

Run: `pnpm vitest run src/composables src/components/Browser && pnpm build` → Expected: PASS。
（`onMounted` 里注册 window 级监听的组件测试必须 `enableAutoUnmount`，否则残留监听吞键——仓库既有约定。）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): 面板消费视图生命周期与 focus 请求（挂载对账 + 幂等展开）"
```

---

### Task 8: sidecar `browser_tab` 工具

**Files:**
- Create: `agent-sidecar/src/extensions/browser/tab.ts`
- Modify: `agent-sidecar/src/extensions/browserClient.ts`（op 联合类型）
- Modify: `agent-sidecar/src/extensions/browserTools.ts`（`buildBrowserTabTool` + 表里一行）
- Modify: `agent-sidecar/src/extensions/browserMcp.ts`（放行规则 + instructions 一节）
- Modify: `agent-sidecar/src/extensions/browserSkill.ts`（reference）
- Modify: `agent-sidecar/src/extensions/browser/format.ts`（`formatTabs` 显示 label 与 displayed/parked）
- Test: `agent-sidecar/src/extensions/browser/tab.test.ts`（新）、`browserTools.test.ts`、`browserMcp.test.ts`（快照 `-u`）

**Interfaces:**
- Consumes: Rust 的 `open` / `close` / `navigate` / `back` / `forward` / `focus` op；`list_views`（既有）
- Produces: `performTabAction(action: TabAction, args: { url?: string; label?: string; viewId?: string }, emit): Promise<string>`；`export type TabAction = "open" | "close" | "navigate" | "back" | "forward" | "focus"`

- [ ] **Step 1: 写失败的测试（纯函数：action → op 载荷 + 文案）**

```ts
describe("browser_tab 的 action → op 映射", () => {
  it("open 带上 url 与 label，且**不**带 view_id", () => {
    expect(buildTabCall("open", { url: "http://localhost:5173/", label: "dev" })).toEqual({
      op: "open",
      url: "http://localhost:5173/",
      label: "dev",
    });
  });

  it("close/navigate/back/forward/focus 都带 view_id", () => {
    expect(buildTabCall("back", { viewId: "browser-2" })).toEqual({
      op: "back",
      view_id: "browser-2",
    });
  });

  it("缺 url 的 open / 缺 view_id 的导航类动作在**本地**就失败，不发桥", () => {
    expect(() => buildTabCall("open", {})).toThrow(/needs a url/);
    expect(() => buildTabCall("navigate", { url: "http://x/" })).toThrow(/needs a view_id/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npm run test -- --run src/extensions/browser/tab.test.ts` → Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`browserClient.ts` 的 `BrowserOp` 联合加六个 op：

```ts
export type BrowserOp =
  | "list_views"
  | "eval"
  | "call_cdp"
  | "open"
  | "close"
  | "navigate"
  | "back"
  | "forward"
  | "focus";
```

`tab.ts`：`buildTabCall`（纯函数，可单测）+ `performTabAction`（发桥 + 文案）。文案要点：

- `open` 成功：`Opened view browser-3 "dev" at http://localhost:5173/ — it is parked (not displayed to the user); pass view_id "browser-3" to the other browser tools.`
- `focus`：`Asked the panel to show browser-3. The UI performs the switch — it is a request, not a guarantee.`
- `close`：`Closed view browser-3.`
- `navigate`：回包里 URL 与目标相同 → 明说这是**重载**（与门面语义一致）。
- 桥失败一律 `formatBridgeFailure(resp)`（既有函数），不静默。

`browserTools.ts`：新增 `buildBrowserTabTool`（zod schema：`action` 枚举 + `url` / `label` / `view_id` 可选），加进 `buildBrowserTools` 的表（`browserTools.ts:406-413`）——**表加一行即可，编排在 `tab.ts`**。

`browserMcp.ts`：`BROWSER_ALLOW_RULES` 加 `browser_tab`；`BROWSER_INSTRUCTIONS` 加一节"多视图纪律"（自己开 tab、显式传 `view_id`、focus 会打扰用户只在需要他看时用）。

- [ ] **Step 4: 验证**

```bash
cd agent-sidecar && npm run test -- --run && npm run typecheck
```
Expected: PASS；`browserMcp.test.ts` 的两道断言（放行规则精确数组 + 每条规则的工具名出现在 instructions 里）**必然**要求同步改，快照用 `-u` 更新。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(browser): browser_tab 工具（open/close/navigate/back/forward/focus）"
```

---

### Task 9: 可见性告警收编（删死代码 + 省一次往返）

**Files:**
- Delete: `agent-sidecar/src/extensions/browser/visibility.ts`
- Modify: `agent-sidecar/src/extensions/browser/runEval.ts`（删 `probeVisibility` / `EvalProbe.visibility` / 包装器里的 visibility）
- Modify: `agent-sidecar/src/extensions/browser/act.ts` / `format.ts` / `screenshot.ts` / `wait.ts` / `projection.ts` / `actions.ts`
- Test: `runEval.test.ts`、`format.test.ts`、`browserTools.test.ts`（凡断言 probe/visibility 的用例）

**Interfaces:**
- Consumes: 无（纯删除）
- Produces: `runEval` 不再每次求值多发一次 `Runtime.evaluate("document.visibilityState")`；`EvalProbe` 只剩 `pending`

- [ ] **Step 1: 先删测试里的期望（让测试失败）**

把 `runEval.test.ts:32-37` 的 probe 夹具与 `format.test.ts` 的 visibility 断言删掉，跑一次确认**失败**（证明这些断言确实绑在被删的能力上）：

Run: `cd agent-sidecar && npm run test -- --run src/extensions/browser/runEval.test.ts` → Expected: FAIL。

- [ ] **Step 2: 实现删除**

- `runEval.ts`：删 `probeVisibility`、`EvalProbe.visibility`、`opts.probe` 分支、`wrapForExecuteScript` 里的 `__aideProbe.visibility`；`runEval` 直接返回 `{ ok: true, value, via, probe: { pending } }`。
- `act.ts` / `format.ts` / `screenshot.ts` / `wait.ts`：删 `withHidden` / `appendHiddenNote` / `HIDDEN_CONSEQUENCE` / HIDDEN 闸 / 超时诊断里的 hidden 分支。
- `projection.ts` / `actions.ts`：信封里的 `visibility` 字段删掉（无消费方＝死数据）。
- `screenshot.ts` 的 `ScreenshotOutcome.visibility` 一并删；**注释里"隐藏视图截图会挂"的说明改成"parking 后视图始终可用；若将来重新引入真隐藏，这条闸要回来"**（留下为什么删的痕迹）。

- [ ] **Step 3: 验证**

```bash
cd agent-sidecar && npm run test -- --run && npm run typecheck
```
Expected: PASS。**顺带确认**：`grep -rn "visibility" agent-sidecar/src/extensions/` 只剩注释。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(browser): 删可见性告警机器（parking 后恒 visible，顺带省一次 CDP 往返）"
```

---

### Task 10: 镜像文案（唯一一处 SDK 触点）

**Files:**
- Modify: `packages/aide-sdk/src/composables/useCustomizations.ts:78`
- Modify: `scripts/diag/measure-builtin-mcp.ts:39`

**Interfaces:** 无（纯文案，不是能力）

- [ ] **Step 1: 改文案**

`useCustomizations.ts:78` 的 `purpose` 字符串：`六个工具都自动放行` → `七个工具都自动放行`，并在 `browser_screenshot 截图` 后插入：

```
browser_tab 自己开/关标签页、导航、把某个 tab 推到前台（agent 可以拥有自己的后台 tab，不抢你的面板）
```

`measure-builtin-mcp.ts` 的工具清单加一项 `browser_tab`（该脚本按工具名逐个量 schema 体积）。

- [ ] **Step 2: 验证**

Run: `pnpm test -- --run && node scripts/diag/measure-builtin-mcp.ts 2>&1 | head -5` → Expected: PASS / 脚本列出七个工具。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore(browser): 内置插件文案镜像补 browser_tab（第七个工具）"
```

---

### Task 11: 真机验收（人工，必须做）

**前提**：`pnpm build:sidecar && pnpm tauri build`（或 dev 实例）后**确认对话跑在哪个实例**——安装版用 `AppData\Local\Aide\agent-runtime\aide-agent.exe`，改 `dist` 只影响 dev（v2 spec 的「未决问题 4」踩过）。

- [ ] **1. 后台干活（正面判据）**：三个 tab 挂同一个 dev server（或探针页 `http://127.0.0.1:8777/`，起法见 spec），让 agent 在**非活动** tab 上 `browser_wait` + `browser_screenshot` + `browser_act` 各一次。Expected: 三者全部正常，页面**没有被切到前台**。
- [ ] **2. 不抢前台 / focus 才抢**：agent `browser_tab {action:"open"}` 时面板**不切走**用户当前视图；`{action:"focus"}` 时切过去。
- [ ] **3. 收起面板 + 托盘**：把右栏收起、Aide 隐藏到托盘，agent 仍能完成 1 里的三个动作（探针已证机制，这里复核真机）。
- [ ] **4. 回归**：切标签、浮层让位（开设置/权限弹窗时内置视图让位且**不再冻结**）、关面板保活这三条现有行为不变。
- [ ] **5. 复跑探针对照**（可选但推荐）：`%TEMP%\wry-park-probe` 的五个视图判据仍是「parked ≡ displayed、hidden 全灭」。

**Expected**：1–4 全通过。任何一条不过，按 `superpowers:systematic-debugging` 走，不要先改代码。

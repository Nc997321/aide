# Aide × AllInKit 打通 — 设计

日期：2026-06-30

## 背景与动机

两个独立产品：

- **Aide**（本仓）：Claude Code CLI 的 Tauri v2 桌面壳，核心是终端 / 文件树 / git / 会话管理。Aide 现有的「市场」面板装的是 **Claude Code 定制物**（`agent` / `skill` / `instruction` / `hook` / `mcp_server`），本质是 markdown / JSON 配置文件，装进 `~/.claude/` 给 CLI 消费——**不是可执行运行时插件**，无代码加载、无能力管控、无签名。
- **AllInKit**（`C:\document\owner\allinkit`）：Rust + Tauri 的插件化万能工具箱，有真正的插件**运行时**——cdylib 动态库 + FFI vtable + CapabilityGate（default-deny）+ ed25519 启动期验签 + TOFU 公钥钉住 + 宿主能力（`http` / `kv` / `clipboard` / `notify` / `dialog` / `fs`）+ panic 隔离 + 插件自带 UI（`ui/index.js` 导出 `mount(root)`，用 `window.aik.call(...)` 回调宿主）。

**目标**：Aide 多一个「工具」入口，能装并运行 AllInKit 插件，运行时引擎来自 AllInKit。Aide 定位不变（仍是 Claude Code 桌面壳），AllInKit 借代码进 Aide；两个产品仍各自独立存在、各自演进。

## 非目标

- 不合并两个产品，不让 Aide 变成 AllInKit 的壳。
- 不动 Aide 现有 Claude Code 定制物市场（`customizations` / `marketplace` 代码原样保留，与新工具面板并存且不共享组件）。
- 不由本仓实现 AllInKit 侧改造——AllInKit 团队根据本文档「子工程1 需求」自行落地。本仓只做 Aide 侧（子工程2）。
- 不在 Phase 1 做市场目录浏览（延到 Phase 2）。

## 关键决策（已与产品负责人确认）

| 维度 | 决策 | 理由 |
|---|---|---|
| 打通形态 | Aide 内嵌 AllInKit 运行时，长一个「工具」入口 | 保留两产品各自定位，风险可控 |
| 两类插件 | 并存两个独立面板，不合并 | 配置文件 vs 可执行运行时，本质不同，合并混淆安装路径 |
| 宿主后端 | 方案B：先把 AllInKit 改成可注入，Aide 注入 clipboard/fs/notify/dialog，http/kv 用默认 | 单一实现、行为统一；改造让 AllInKit 可被任意宿主嵌入，两产品都受益 |
| 插件 UI | 隔离 iframe / 子 webview（`sandbox="allow-scripts"`，不给 `allow-same-origin`） | 插件 JS 是第三方代码，须关进沙箱，只留 postMessage 通道 |
| 入口 | 侧栏「工具」→ 主区列表 + iframe | 与 Aide 现有三栏布局一致 |
| 安装来源 | Phase 1 本地 `.aikpkg` / URL；Phase 2 加市场目录浏览 | 先可用，再补体验 |

## 范围拆分

- **子工程1（AllInKit 侧）**：把 `HostServices` 改成 trait 可注入。独立、可测、独立受益，是子工程2 的前置。**本文档只给需求，不给实现**——AllInKit 团队自行落地。
- **子工程2（Aide 侧）**：嵌入 `aik-host`、注入 Aide 后端、加「工具」面板、做隔离 iframe + postMessage 桥、安装 / 验签 / TOFU / registry 流程。**本仓细做计划并实现**，下文展开到文件级。

---

## 子工程1：AllInKit 后端可注入改造（需求，不实现）

### 现状（Explore agent 已核实）

- `crates/aik-host/src/services.rs:47-76`：`HostServices` 持有 `reqwest::blocking::Client`、`arboard::Clipboard`、`notify-rust`、`rfd::FileDialog`、`std::fs` 等**具体实现**，无 trait 抽象。
- 唯一入口 `HostServices::new(gate, kv_root).install()`，装进 `OnceLock` 全局单例；`aik-tauri` 外壳也是这么调，**未注入自己的实现**。
- 解耦干净的部分：`CapabilityGate`、`Dispatcher`、`PluginRegistry`、`PluginLoader`、ed25519 验签（`aik-capability/src/verify.rs`）、TOFU / `registry.json`（`store.rs`）。换后端不应动到这些。
- 内核 crate `publish = false`，只能本地 path 依赖。

### 对 AllInKit 的需求（Aide 视角的契约）

1. **能力后端可注入**：`clipboard` / `fs` / `notify` / `dialog` / `http` / `kv` 六个能力的执行后端，外部宿主能用自己的实现替换默认实现。具体 trait 形状、是否聚合为一个 trait 还是六个独立 trait，由 AllInKit 自决。
2. **builder 构造**：提供类似 `HostServices::builder(gate, kv_root).with_clipback(impl).with_fs(impl)...build().install()` 的构造路径；未传入的能力回退默认实现。
3. **默认实现不破坏现有行为**：`aik-tauri` 外壳用全默认实现时，现有 e2e（`base64-tool` / `kv-tool` dogfood）行为完全不变。
4. **公开 API**：在 `crates/aik-host/src/lib.rs` 导出各后端 trait + 默认实现 + builder，供外部宿主依赖。
5. **契约稳定**：trait 方法签名覆盖现有各能力方法的能力（参数 / 返回 `AikResult<Value>` / 错误码），不在子工程2 实施期间频繁变动；如有变动，同步本文档。

### 验收（AllInKit 侧）

- 现有全量测试 + e2e 全绿（默认实现 behavior 不变）。
- 新增「注入 mock backend」单测通过，证明后端可换。
- `aik-host` 可作为 path 依赖被外部 Tauri 应用引入并注入自定义后端。

> 估算（仅参考）：约 20+ 文件，AllInKit 内部架构改造。实际由 AllInKit 团队评估。

---

## 子工程2：Aide 嵌入运行时 + 工具面板（本仓细做并实现）

### 架构总览

```
Aide (Tauri v2)
├── 现有功能（终端/文件树/git/会话/Claude Code 定制物市场）—— 不动
└── 新增「工具」子系统
    ├── Rust 侧
    │   ├── 依赖 aik-host（path）
    │   ├── 启动时 builder 注入 Aide 后端 → install()
    │   ├── aik_backends.rs：AideClipboardBackend / AideFsBackend / AideNotifyBackend / AideDialogBackend
    │   ├── commands/aik.rs：aik_plugin_call / list / install / uninstall / asset
    │   └── 自定义协议 aik-plugin:// 提供插件 ui 文件
    └── 前端侧
        ├── 侧栏「工具」入口
        ├── PluginPanel.vue：已装列表 + iframe 宿主
        ├── postMessage 桥：iframe ↔ 主 frame ↔ Tauri invoke ↔ Dispatcher
        ├── composables/useAikPlugins.ts：状态 + 动作
        └── api/aik.ts + types/aik.ts：类型安全封装
```

### Rust 侧详细计划

#### 1. 依赖与启动集成

**`src-tauri/Cargo.toml`**：新增 path 依赖

```toml
[dependencies]
aik-host = { path = "../../allinkit/crates/aik-host" }
# 以及 AllInKit 要求的传递依赖（aik-capability 等），按 aik-host 的公开 API 需要
```

> ⚠️ Windows 必读：AllInKit 内部若有 `Command::new(...)` spawn 外部进程，须确认其带 `CREATE_NO_WINDOW (0x08000000)`；Aide 侧新增的任何 spawn 也必须带（见 CLAUDE.md 坑点）。

**`src-tauri/src/lib.rs`**：在 Tauri Builder 的 `setup` 钩子初始化运行时

```rust
let plugins_dir = app.path().app_data_dir()?.join("aik-plugins");
let registry = PluginRegistry::new();
let gate = CapabilityGate::new(registry.clone());
HostServices::builder(gate, plugins_dir.join("kv"))
    .with_clipboard(AideClipboardBackend)
    .with_fs(AideFsBackend)
    .with_notify(AideNotifyBackend)
    .with_dialog(AideDialogBackend)
    // http / kv 用 AllInKit 默认
    .build()
    .install();
```

环境变量 `AIK_PLUGINS_DIR` 指向 `app_data_dir/aik-plugins`；开发期 `AIK_DEV_TRUST=1` 放行未签名插件。

#### 2. 后端注入实现

**新文件 `src-tauri/src/aik_backends.rs`**：四个 trait impl，内部**直接调 Aide 现有 Rust 函数**（同进程，不走 invoke）。

| Backend | 复用 Aide 现有实现 | 注意点 |
|---|---|---|
| `AideClipboardBackend` | `commands/clipboard.rs` 的剪贴板读写函数 | 对齐 AllInKit trait 的方法语义 |
| `AideFsBackend` | `commands/filesystem.rs` | **路径越界检查必须对齐** AllInKit fs 能力的安全语义，不能因复用 Aide 的workspace 边界而放宽插件 fs 沙箱 |
| `AideNotifyBackend` | `notify_send` 命令逻辑 | 强制 `app_id("com.aide.app")`（绕过 tauri-plugin-notification bug，见 CLAUDE.md） |
| `AideDialogBackend` | Aide 现有弹窗能力 | 对齐 trait 的 dialog 方法集 |

`http` / `kv` 不注入，用 AllInKit 默认（Aide 无此能力；kv 是每插件沙箱）。

#### 3. Tauri 命令

**新文件 `src-tauri/src/commands/aik.rs`**，在 `commands/mod.rs` 注册，在 `lib.rs` `invoke_handler` 列出：

- `aik_list_installed() -> Vec<InstalledPlugin>`：调内核 `PluginRegistry` / `store` 列已装插件（id / 名称 / 描述 / 启用 / 已授权能力）。
- `aik_plugin_call(plugin_id: String, service: String, method: String, args: Value) -> AikResult<Value>`：走内核 `Dispatcher.dispatch(plugin_id, service, method, &args)`，经 `CapabilityGate`。
- `aik_install_from_path(path: String) -> Result<InstalledPlugin>`：本地 `.aikpkg` → AllInKit 安装管线（解包 / META.sig 验签 / TOFU / 写 registry.json）。
- `aik_install_from_url(url: String) -> Result<InstalledPlugin>`：URL 安装，同管线。
- `aik_uninstall(plugin_id: String) -> Result<()>`：标 `pending=Uninstall`，下次启动真删（沿用 AllInKit 语义）。
- `aik_plugin_toggle(plugin_id: String, enabled: bool) -> Result<()>`：启用/禁用。
- `aik_plugin_asset(plugin_id: String, rel_path: String) -> Result<Vec<u8>>`：读插件 `ui/` 下文件，供自定义协议用（仅允许 `ui/` 子树，防穿越）。

> Aide 现有命令按领域命名（`clipboard_*` / `git_*` / `filesystem_*`），无统一前缀。为把 AllInKit 相关命令聚成一个清晰命名空间、避免与 Aide 自有概念混淆，新增命令统一用 `aik_` 前缀。

#### 4. 自定义协议：`aik-plugin://`

在 Tauri Builder 用 `register_uri_scheme_protocol` 注册 `aik-plugin`：

- URL 形如 `aik-plugin://<plugin-id>/index.html` 或 `aik-plugin://<plugin-id>/assets/foo.js`。
- 后端解析 `plugin_id` + `rel_path` → 调 `aik_plugin_asset` 逻辑读磁盘（验签过的插件 `ui/` 目录）→ 返回字节 + 正确 MIME。
- 路径穿越防护：`rel_path` 规范化后必须仍在该插件 `ui/` 子树内。

iframe 的 `src` 指向 `aik-plugin://<plugin-id>/index.html`。

### 前端侧详细计划

#### 1. 入口与布局

**`src/components/SidebarLeft.vue`**：功能区新增「工具」项（图标 + 文案），点击后在主区切换到 `PluginPanel.vue`。沿用现有侧栏功能区的交互模式与样式（Catppuccin 暗色、三角箭头 14px）。

**`src/App.vue`**：主区视图状态新增 `tools` 视图，路由到 `PluginPanel`。与终端 / 文件查看器等现有主区视图并列，互斥切换。

#### 2. 工具面板

**新文件 `src/components/PluginPanel.vue`**：

- 左子区：已装插件列表（名称 / 描述 / 启用状态 / 已授权能力徽章），「安装」按钮（弹窗输入本地路径或 URL），右键菜单（卸载 / 启用-禁用）。
- 右子区：选中插件后渲染 `PluginIframe`；未选中时显示空态引导。
- 复用 `ContextMenu.vue` / `ModalDialog.vue` 现有组件做右键菜单和安装弹窗。

**新文件 `src/components/PluginIframe.vue`**：

```html
<iframe
  :src="`aik-plugin://${pluginId}/index.html`"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
  @load="onLoad"
/>
```

- `sandbox="allow-scripts"`，**不给 `allow-same-origin`**：插件 JS 拿不到主上下文与主 DOM。
- 监听 `window` 的 `message` 事件，过滤 `origin`/`source` 为该 iframe 的、`data.type === 'aik-call'` 的消息：
  - 取 `{ id, service, method, args }` → `invoke('aik_plugin_call', { plugin_id, service, method, args })` → 拿结果 → `iframe.contentWindow.postMessage({ type: 'aik-call-result', id, result }, '*')`。
  - 错误同样回传 `{ type:'aik-call-result', id, error }`。
- 卸载时移除 message 监听，避免泄漏。

#### 3. 插件侧 `window.aik` 桥

iframe 内的 `window.aik.call(service, method, args)` 不是 Aide 实现的——它是**插件 UI 自己的引导脚本**负责定义（postMessage 到 parent，等结果回传 resolve Promise）。

> 这里有两种取舍，**待 AllInKit 确认**：`window.aik` 的引导脚本是由 AllInKit 的插件 UI 约定自带，还是由宿主在 iframe 加载时注入。如果是后者，Aide 需要在 `aik-plugin://` 协议返回 `index.html` 时注入一段 bootstrap 脚本。本设计默认采用「宿主注入 bootstrap」以减少插件作者负担，但需与 AllInKit 对齐 `window.aik` 协议（消息格式 / Promise 语义 / 错误码）。

#### 4. 状态层与 API 封装

**新文件 `src/composables/useAikPlugins.ts`**：模块级 reactive 单例（对齐 Aide 现有 `useSettings` / `useGit` 模式）。状态：`installed: Ref<InstalledPlugin[]>`、`activePluginId`。动作：`loadInstalled()`、`installFromPath()`、`installFromUrl()`、`uninstall()`、`toggle()`、`call()`（封装 invoke）。

**新文件 `src/api/aik.ts`**：`api.ts` 风格的类型安全 invoke 封装，对应上列 Rust 命令。

**新文件 `src/types/aik.ts`**：`InstalledPlugin` / `AikCallResult` / 能力枚举等，与 AllInKit 的 `serde` 类型对齐（字段对齐 `InstalledPlugin` 现有定义 + 启用/能力扩展）。

#### 5. 右键菜单与弹窗

- 右键插件项 → `ContextMenu.vue`：卸载 / 启用-禁用 / 复制插件 id。配置进 `menus/contextMenus.ts`（工厂函数风格）。
- 安装弹窗 → `ModalDialog.vue`：单选来源（本地路径 / URL）+ 输入框 + 安装进度 / 结果。

### 数据流（一次插件调用）

```
插件 ui/index.js  window.aik.call("kv","get",["k"])
  → iframe postMessage({type:'aik-call', id, service:'kv', method:'get', args})
  → Aide 主 frame PluginIframe onMessage
  → invoke('aik_plugin_call', {plugin_id, service:'kv', method:'get', args})
  → Rust aik_plugin_call → Dispatcher.dispatch(plugin_id, 'kv', 'get', &args)
  → CapabilityGate 检查 plugin.toml 是否声明 kv
  → KvBackend（AllInKit 默认）执行 → AikResult<Value>
  → invoke 返回 → postMessage({type:'aik-call-result', id, result}) 回 iframe
  → window.aik.call 的 Promise resolve
```

### 错误处理

- 沿用 AllInKit 统一错误协议（`AikResult<Value>`）。能力被拒 / 路径越界 / 验签失败 → 明确错误码 → iframe 侧 / 面板侧展示。
- 插件 panic → AllInKit panic 隔离捕获 → Aide 工具面板显示「插件崩溃，已隔离」，Aide 主功能（终端 / git / 文件树）不受影响。
- iframe 加载失败 / 协议读不到文件 / 资源 404 → 面板显示错误态，不白屏。
- 后端注入异常（如 Aide fs 越界拒绝）→ 返回 AllInKit 错误码，不 panic、不殃及 Aide 主进程。
- postMessage 桥超时：`aik_plugin_call` 长时间无返回 → iframe 侧 Promise 超时拒绝（默认 30s，可调）。

### 安全模型

全部从 AllInKit 继承，不削弱：

- 能力 `plugin.toml` default-deny + ctx 反查 plugin_id 防身份伪造。
- ed25519 启动期验签（重算 SHA-256 验 `plugin.sig`，官方公钥内置）。
- TOFU 钉公钥防换包。
- panic 隔离。
- **Aide 侧新增一层**：iframe `sandbox="allow-scripts"` 无 `allow-same-origin`，插件 JS 物理隔离于主 webview；仅 postMessage 通道，且主 frame 仅响应 `type==='aik-call'` 的消息并强校验 `source` 为已知 iframe。

### 测试策略

**Rust 侧**：
- `aik_plugin_call` 命令单测：mock `Dispatcher`，验证 service/method/args 透传与错误码回传。
- 注入后端单测：`AideClipboardBackend` / `AideFsBackend` / `AideNotifyBackend` / `AideDialogBackend` 各自 trait 行为；`AideFsBackend` 路径穿越用例。
- 自定义协议单测：`aik-plugin://<id>/index.html` 正常返回；`../` 穿越 → 拒绝。

**前端侧**：
- `useAikPlugins` 状态单测（mock invoke）：loadInstalled / install / uninstall / toggle。
- postMessage 桥单测：mock `invoke`，验证 `aik-call` → result 回传、错误回传、超时拒绝。
- 非法 message（错误 type / 未知 source）被忽略。

**e2e（Aide 内）**：
- 装 `base64-tool`（无能力）→ iframe 渲染 → 调用 → 返回，全链路。
- 装 `kv-tool`（声明 `kv`）→ `host_kv` 走默认后端 → 每插件沙箱；未声明能力者调用被拒。
- 安全用例：未签名插件 default-deny（除非 `AIK_DEV_TRUST=1`）；篡改 dll → 验签失败；插件 panic → Aide 主功能不崩；iframe 无 `allow-same-origin` → 插件 JS 访问主 DOM 失败。

### 关键文件清单（Aide 侧新增 / 改动）

**新增**：
- `src-tauri/src/aik_backends.rs`
- `src-tauri/src/commands/aik.rs`
- `src/components/PluginPanel.vue`
- `src/components/PluginIframe.vue`
- `src/composables/useAikPlugins.ts`
- `src/api/aik.ts`
- `src/types/aik.ts`

**改动**：
- `src-tauri/Cargo.toml`（path 依赖）
- `src-tauri/src/lib.rs`（setup 初始化 + invoke_handler 注册 + 自定义协议）
- `src-tauri/src/commands/mod.rs`（注册 aik 模块）
- `src/components/SidebarLeft.vue`（「工具」入口）
- `src/App.vue`（主区 `tools` 视图路由）
- `src/menus/contextMenus.ts`（插件右键菜单）
- `CLAUDE.md` / `docs/ARCHITECTURE.md`（新增「工具」子系统说明、`aik_` 命名空间约定、iframe 沙箱坑点）

### 分阶段路线图

- **Phase 1**（子工程1 完成 + 子工程2 最小切片）：AllInKit trait 改造交付 → Aide 嵌入 + 注入后端 + 侧栏「工具」入口 + 主区列表 + 隔离 iframe + 本地/URL 安装 + 验签/TOFU。能装 `base64-tool` 与 `kv-tool` 跑通。
- **Phase 2**：市场目录浏览 + 一键安装；评估更多宿主能力打通；插件 UI 引导脚本协议与 AllInKit 对齐固化。

### 对接依赖（阻塞项）

1. **子工程1 交付**：AllInKit 提供 builder + 后端 trait + 默认实现，`aik-host` 可 path 依赖。子工程2 Phase 1 无法在子工程1 交付前开工。
2. **`window.aik` 协议对齐**：与 AllInKit 确认 postMessage 消息格式 / Promise 语义 / 错误码 / 引导脚本由谁注入。
3. **后端 trait 方法集对齐**：与 AllInKit 确认 clipboard/fs/notify/dialog trait 的方法签名，Aide 注入实现才能填对。

> 这三项需 AllInKit 团队确认后，本文档相应章节再细化。
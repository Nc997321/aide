# Aide 内置插件实现计划

> 目标：帮助用户开箱即用，内置插件自动安装并带图标展示。

---

## 一、总体思路

**"内置清单驱动自动安装 + aIDE 图标覆盖 + 手动精选推荐"**

Aide 维护一个内置插件清单（Rust 代码硬编码或 JSON 配置），记录：
- 内置哪些插件（从哪个源、哪个插件名）
- Aide 提供的图标路径
- 是否精选推荐、默认是否启用

启动时自动检查并安装，用户开箱即用。Marketplace UI 展示时给内置插件挂上 Aide 图标。

---

## 二、数据模型扩展

### 2.1 Rust `PluginEntry`（`marketplace/mod.rs`）

```rust
pub struct PluginEntry {
    // ... 现有字段 ...
    pub icon: Option<String>,      // Aide 提供的图标路径（resources 内相对路径）
    pub is_featured: bool,         // 是否精选推荐
}
```

### 2.2 前端 `PluginEntry`（`src/types/marketplace.ts`）

```ts
export interface PluginEntry {
  // ... 现有字段 ...
  icon?: string;
  isFeatured: boolean;
}
```

---

## 三、内置插件清单模块（新建）

**文件：`src-tauri/src/commands/marketplace/bundled.rs`**

```rust
/// 内置插件定义
pub struct BundledPlugin {
    pub name: String,
    pub source_id: String,           // "claude-plugins-official" | "claude-community"
    pub icon: Option<String>,        // resources 内相对路径，如 "builtin-icons/superpowers.png"
    pub is_featured: bool,
    pub default_enabled: bool,
}

/// 内置插件清单（硬编码，后续发版时更新）
pub fn bundled_plugins() -> Vec<BundledPlugin> { ... }

/// 启动时自动安装所有未安装的内置插件
pub fn ensure_bundled_plugins_installed(service: &SettingsService) { ... }
```

### 3.1 图标资源目录

```
src-tauri/resources/builtin-icons/
  superpowers.png
  github.png
  ...
```

---

## 四、启动时自动安装（`lib.rs` setup）

在 `setup()` 中 marketplace 初始化之后调用：

```
应用启动
  └─ setup()
       ├─ 加载 settings
       ├─ 初始化 marketplace 源
       ├─ ensure_bundled_plugins_installed()  ← 新增
       │     ├─ 遍历 bundled_plugins()
       │     ├─ 检查 cache 目录是否已存在
       │     ├─ 未安装 → 调用 install_plugin() 从 GitHub 安装
       │     └─ 安装失败 → 记录日志，跳过，不阻塞启动
       └─ 启动 sidecar
```

---

## 五、Marketplace 数据增强

`fetch_marketplace` 返回结果后，新增一个后处理步骤：

```rust
/// 给 marketplace 条目合并内置插件的图标、精选推荐标记
fn merge_bundled_metadata(entries: &mut Vec<PluginEntry>) {
    let bundled = bundled_plugins_map(); // name -> BundledPlugin
    for entry in entries {
        if let Some(b) = bundled.get(&entry.name) {
            entry.icon = b.icon.clone();
            entry.is_featured = b.is_featured;
        }
    }
}
```

这样前端拿到 marketplace 数据时，内置插件已经有图标和推荐标记。

---

## 六、前端展示

### 6.1 图标组件逻辑

```
if (plugin.icon) {
  // 从 Tauri resource 协议加载图标图片
  <img :src="convertResourcePath(plugin.icon)" />
} else {
  // 无图标 → 取 name 第一个英文字母
  <div class="icon-placeholder">{{ firstLetter(plugin.name) }}</div>
}
```

### 6.2 精选推荐区块（Marketplace 页面新增）

```vue
<!-- 精选推荐 -->
<section v-if="featuredPlugins.length">
  <h3>精选推荐</h3>
  <div class="featured-grid">
    <PluginCard v-for="p in featuredPlugins" :key="p.name" :plugin="p" />
  </div>
</section>

<!-- 全部插件 -->
<section>
  <h3>全部</h3>
  ...
</section>
```

---

## 七、文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `marketplace/mod.rs` | 修改 | `PluginEntry` 加 `icon`、`is_featured` |
| `marketplace/sources.rs` | 修改 | `parse_entry` 解析图标字段（为后续 marketplace.json 支持图标预留） |
| `marketplace/bundled.rs` | **新建** | 内置清单、自动安装逻辑、图标映射 |
| `marketplace/install.rs` | 修改 | `install_plugin` 保持现有逻辑即可，`bundled.rs` 调用它 |
| `lib.rs` | 修改 | setup 里接入 `ensure_bundled_plugins_installed()` |
| `src/types/marketplace.ts` | 修改 | `PluginEntry` 类型加 `icon`、`isFeatured` |
| `src/composables/useMarketplace.ts` | 修改 | 增加 `featuredPlugins` computed |
| `src/components/marketplace/` | 修改/新建 | 卡片组件显示图标、精选推荐区块 |
| `src-tauri/resources/builtin-icons/` | **新建目录** | 放 Aide 提供的图标 |

---

## 八、风险与决策

### 8.1 风险：首次启动需要网络

从 GitHub 源安装内置插件需要网络。用户首次打开 Aide 时如果离线，内置插件装不上。

**缓解方案（待决策）：**
- **A. 接受风险**：离线首次启动不装内置插件，有网后下次启动再装
- **B. 打包 fallback**：把内置插件本体也放进 `resources/builtin-plugins/`，GitHub 安装失败时从本地 copy

### 8.2 风险：内置插件更新

Aide 新版本更新了内置清单（换了版本或加了新插件），已安装的旧版本如何处理？

**方案（推荐）：**
- 启动时比对内置清单的 `version_id` 与已安装的 `version_id`
- 不一致时自动调用 `update_plugin()` 更新

---

## 九、时序图

```
┌─────────────┐     ┌────────────────────┐     ┌─────────────────┐
│   用户打开   │────▶│   lib.rs setup()   │────▶│  ensure_bundled │
│    Aide     │     │                    │     │  _plugins_installed
└─────────────┘     └────────────────────┘     └─────────────────┘
                                                          │
                              ┌──────────────────────────┘
                              ▼
                    ┌─────────────────┐
                    │ 遍历 bundled_plugins()
                    │ 检查 cache 是否存在
                    │ 不存在 → install_plugin()
                    │ 存在但版本旧 → update_plugin()
                    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ 重写 enabled-plugins.json
                    │ 启动 sidecar
                    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ 前端 fetchMarketplace()
                    │ merge_bundled_metadata()
                    │ 内置插件显示 Aide 图标
                    └─────────────────┘
```

---

## 十、待确认问题

1. **离线 fallback 做不做？**（风险 1）
2. **内置清单放在代码里还是 JSON 配置文件里？** 代码硬编码简单，JSON 配置文件方便热更新
3. **首批内置插件有哪些？** 需要具体名单才能写 `bundled_plugins()` 的初始数据

---

## 十一、实施记录（2026-09-03，已完成）

**待确认问题的实际决策：**

1. **离线 fallback**：选方案 A（接受风险）。源克隆/安装失败只记 `tracing::warn` 跳过，
   不阻塞启动；下次有网启动自动重试。不打包含插件本体的 fallback 包。
2. **清单位置**：代码硬编码（`bundled.rs` 的 `static BUNDLED`），与 `sources.rs`
   `FIXED_SOURCES` 同风格，发版时更新。
3. **首批名单**：
   - 自动安装 + 精选（无需外部账号）：`superpowers`、`commit-commands`、
     `pr-review-toolkit`、`security-guidance`（均来自 `claude-plugins-official`）
   - 精选但不自动安装（需凭证）：`github`、`playwright`
   - 仅挂图标：`hookify`、`frontend-design`、`agent-sdk-dev`、`plugin-dev`、
     `typescript-lsp`、`pyright-lsp`

**与计划的偏差：**

- **图标不走 Tauri resource 协议**。项目未开启 asset protocol，且 dev/release 路径
  行为有差异；改为 `include_bytes!` 把 PNG 内嵌进二进制，`PluginEntry.icon` 直接
  携带 `data:image/png;base64` URL，桌面与 remote-pwa 行为一致，前端 `<img :src>`
  零适配。图标生成脚本：`scripts/gen_builtin_icons.py`。
- **前端类型真实位置在 `packages/aide-sdk/src/types/marketplace.ts`**，
  `src/types/marketplace.ts` 只是 re-export 兼容壳。
- **新增「卸载墓碑」机制**（计划未覆盖）：用户显式卸载内置插件后，卸载时把
  `{name}@{market}` 写入 settings 的 `uninstalledBundledPlugins`，启动安装跳过；
  手动重装时清除。否则用户永远无法摆脱内置插件。
- **更新路径不动 enabled 状态**：版本落后时只重装版本目录 + 重写
  enabled-plugins.json，用户手动禁用优先。
- **前端 UI 按设计稿实现**：「推荐」伪分类（默认首屏）+ Hero 横幅 + 精选推荐
  自适应网格卡（`variant="featured"`）+ 右侧栏「热门标签」（真实分类计数）。
  设计稿中的下载量/开发者/本周热门因无真实数据源，未实现（不编造数据）。

**验证**：`cargo test marketplace` 15 通过（新增 4）；前端 vitest 167 文件
1858 全过（市场相关新增 9）；`vue-tsc --noEmit` 干净；`cargo clippy` 新增代码零告警。

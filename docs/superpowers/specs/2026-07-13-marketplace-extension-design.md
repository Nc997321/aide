# 插件市场扩展设计

> 日期：2026-07-13
> 状态：设计已与用户逐节确认，待实现
> 范围：为 Aide 增加「安装官方/社区市场插件并在会话中加载」的完整能力，替换当前只能拉单一第三方社区源、且装了也不生效的市场功能。

## 1. 背景与问题

当前 Aide 的插件市场（`src/composables/useMarketplace.ts` + `src-tauri/src/commands/marketplace.rs`）有四处缺口，导致用户「想装官方插件」的诉求无法满足：

1. **源写死为社区市场**：`DEFAULT_MARKETPLACE_URL = "https://github.com/anthropics/claude-plugins-community"`。这是 Anthropic 策展的**第三方**插件集，所以列表里全是第三方。官方市场 `claude-plugins-official`（Anthropic 自产插件：github / security-guidance / commit-commands / 各 LSP 等）从未接入。
2. **`marketplace.json` 解析不全**：`RawSource` 只认 `url` / `git-subdir` / 字符串相对路径三种，缺官方规格里的 `github` 源（`{source:"github", repo, ref?, sha?}`），也不处理 `metadata.pluginRoot`。真实官方市场 255 个插件大量用 `git-subdir`/`url`/`github`/相对路径——`github` 源会解析失败。
3. **安装路径与扫描路径错配**：`install_plugin` 克隆到扁平 `~/.claude/plugins/<name>/`，而 skill 扫描器（`skills.rs`）只认 CLI 的 cache 三级树 `~/.claude/plugins/cache/*/*/*/skills/*/SKILL.md`。结果：**市场装的插件 skills 根本没被加载**（latent bug）。
4. **sidecar 没把插件传给 SDK**：`agent-sidecar/src/index.ts` 只传 `skills:"all"`，没传 `options.plugins`。SDK 文档明确插件可带 skills/agents/hooks/MCP，而 `skills:"all"` 只覆盖 skills 的自动发现——agents/hooks/MCP 全没加载。

## 2. 设计原则

- **不要求用户另装 Claude Code CLI**。Aide 自己完成取源、安装、启用、加载。文件落在 CLI 兼容的 cache 目录树里，仅作为「碰巧也装了 CLI 时不冲突、不重复」的副产品，不读写 CLI 的 `~/.claude/settings.json`。
- **provider-agnostic**：市场/插件概念对所有 provider 通用，不引入 Claude 专属类型（遵循架构红线）。
- **走主题 token**：实现一律用 `src/themes/` 的 `--aide-*` 变量，禁止硬编码 hex（遵循 CLAUDE.md 主题系统红线）。

## 3. 产品行为（用户视角）

### 3.1 市场标签页布局

设置 → 市场 tab：

- **顶栏源开关条**（signature 元素）：固定两条源芯片
  - 「Anthropic 官方」（source_id=`claude-plugins-official`，仓 `anthropics/claude-plugins-official`）
  - 「社区」（source_id=`claude-community`，仓 `anthropics/claude-plugins-community`）
  - 每条芯片含：状态圆点、源名、插件计数、刷新按钮（⟳）、开/关开关。
  - 默认两条都开。关掉后该源插件从列表消失；重开即恢复。
  - **不可自加源**（无 add 对话框）；只能开关/刷新固定源。
- **搜索框**：按插件名/描述过滤。
- **类别筛选标签**：全部 / 外部集成 / 代码智能 / 开发工作流 / 安全 / 输出样式（按源条目里的 `category` 聚合）。
- **插件卡片列表**：每卡显示 名称、版本、来源徽标（官方/社区）、类别、一句话描述、状态 + 操作按钮。
  - 未安装 → **安装**
  - 已安装已启用 → **禁用** + **卸载**
  - 已安装已禁用 → **启用** + **卸载**
  - 有更新 → 额外显示「有更新」徽标 + **更新** 按钮
- **底部状态条**：「N 已安装 · M 已启用 · 启用变更在下一次消息往返生效」。

### 3.2 安装与启用语义

- **安装** = 取插件源（git clone / 稀疏克隆 / 从源 cache 拷贝）到 `~/.claude-code-desktop/claude-agent-sdk/plugins/cache/<市场>/<插件>/<版本>/`（Claude 专属产物收拢在 `claude-agent-sdk/` 命名空间下，不蹭 CLI 的 `~/.claude/plugins/`）。安装后的启用状态尊重 `defaultEnabled`（优先级：marketplace 条目 > 插件 `plugin.json`，默认 true）——官方有些插件声明 `defaultEnabled:false`，装上即为「已禁用」，由用户主动启用，避免无谓的上下文成本。
- **启用/禁用** = 文件留在磁盘，只切是否加载（**省上下文成本**，对应官方 `defaultEnabled:false` 语义）。变更在**下一次消息往返**生效，不打断当前对话（v1 有意简化）。
- **卸载** = 删 cache 目录 + 清启用键。
- 安装官方插件（用户原始诉求）的落点：进市场页，「Anthropic 官方」默认就开，直接看到官方插件，点安装即可——无需 CLI、无需自加源。

### 3.3 安装前信任确认

- **社区源**：点安装时弹确认「此插件将执行代码，请确认信任来源」。
- **官方源**：默认信任，不弹。
- **更新**：不重新弹确认（安装时已信任）。

### 3.4 不可用插件的处理（基于真仓数据核实）

> 数据来源：2026-07-13 拉取的真实 `marketplace.json`——官方 255 插件、社区 2248 插件、npm 源 0 个、源类型仅 `git-subdir`/`url`/`github`/相对路径四种。

SDK 通过 `options.plugins` 能加载的组件：**skills / agents / hooks / MCP**。SDK **不加载**：LSP / 输出样式 / 主题 / monitors（这些是 CLI 专属）。

判断规则（基于 `marketplace.json` 条目**内联的组件字段**，不靠脆弱的 category 猜测）：

| 条目内联情况 | 列表行为 |
|---|---|
| 只内联了不可用组件（lspServers/outputStyles/themes/monitors），无可用组件 | **隐藏**（精确命中官方 12 个 LSP 插件：clangd-lsp … typescript-lsp） |
| 内联了「可用 + 不可用」混合 | 显示，挂琥珀色 caveat 标注不可用部分 |
| 不内联任何组件字段（组件在各自仓库的 plugin.json 里，列表阶段不可知，占绝大多数） | 正常显示，**不打"不可用"标签**（避免 2484 个卡上挂假警告） |

- **隐藏但透明**：列表区显示「已隐藏 N 个 Aide 不可用的插件」，可点开查看（灰显 + "在 Aide 中不可用"标签）。
- **详情阶段做实判断**：点开任意插件详情 → 按需拉那一个插件仓库的 `plugin.json` → 准确列出「将安装」的组件，逐项标 可用 / 在 Aide 中不可用；若全部不可用则详情提示并禁用安装按钮。

### 3.5 更新机制

两层：

- **市场目录更新**：源芯片的「⟳ 刷新」= git pull 源 cache，拉完新插件出现。
- **已装插件版本更新**：刷新源后，Aide 把每个已装插件的版本（`plugin.json.version` 或安装时记录的 git SHA）与源条目解析出的最新版本比对，不一致则卡片显示「有更新」+「更新」按钮。点更新 → 拉新版到新 cache 版本目录、启用指针切到新路径、旧版本目录保留 7 天后回收（CLI 同款策略）。生效时机同启用/禁用：下一次消息往返。

**启动后台静默检查（方案 B）**：

- Aide 启动后在后台（非阻塞）逐个刷新已启用源、比对已装插件版本。
- 成功且有更新 → 用 `notify_send` 推通知「N 个插件有更新」（点击跳转市场页）。
- 拉取失败（无网/代理不通）→ 通知「市场更新拉取失败」。
- **绝不自动应用**——只通知，用户去市场页逐个点「更新」。

## 4. 架构与模块

四层改动，遵循 Aide 分层与模块组织红线（组织文件在上层、子实现同名子目录）。

### 4.1 Rust 层：`commands/marketplace.rs` → `commands/marketplace/` 模块

```
commands/marketplace/
├── mod.rs       // 组织层：Tauri 命令 + 公开类型（PluginEntry/InstalledPlugin/SourceInfo）+ 路径 helpers
├── sources.rs   // marketplace.json 全 schema 解析（RawSource 五分支 + metadata.pluginRoot + 固定源目录 const）
├── install.rs   // 按 source 类型解析 clone 目标 → 落 cache 三级目录；版本解析；卸载；更新；7 天 GC
└── manifest.rs  // plugin.json 读取（组件清单用于 UI「将安装」展示 + 可用性判断）
```

- `marketplace-cache` 由单目录改为按源名分目录 `~/.claude-code-desktop/claude-agent-sdk/marketplace-cache/<source-id>/`（支持多源并存）。
- 插件落 `~/.claude-code-desktop/claude-agent-sdk/plugins/cache/<market-name>/<plugin>/<version>/`（`market-name` 取自 `marketplace.json.name`；与 CLI 的 `~/.claude/plugins/` 物理隔离，避免双加载）。
- 所有 `git` spawn 保留 `CREATE_NO_WINDOW (0x08000000)` + 代理检测（`commands/proxy.rs`）。
- 重 IO 命令改 **async + spawn_blocking**（遵循 CLAUDE.md「重 IO 一律 async」红线）：`fetch_marketplace` / `refresh_marketplace` / `install_plugin` / `update_plugin` / `uninstall_plugin` / `list_installed_plugins`。`State` 注册成 `Arc<T>`，闭包内 `state.inner().clone()`。纯设置/内存命令（`list_marketplace_sources` / `set_marketplace_enabled` / `set_plugin_enabled`）保持同步。async 命令不埋 `trace_command`（按 CLAUDE.md 规矩）。

**固定源目录（代码 const，不进设置）**：

| source_id | 仓 (owner/repo) | market name | 默认启用 |
|---|---|---|---|
| `claude-plugins-official` | `anthropics/claude-plugins-official` | `claude-plugins-official` | 是 |
| `claude-community` | `anthropics/claude-plugins-community` | `claude-community` | 是 |

> `source_id` 用于开关/刷新；`market-name` 用于 cache 路径与 `plugin@market` 键。两者可能不同（社区: source_id=`claude-community`，仓 repo=`claude-plugins-community`，market name=`claude-community`）。

**marketplace.json 解析结构（补全官方 schema）**：

- `RawSource` 五分支：`Relative(String)` / `Github{repo,ref?,sha?}` / `Url{url,ref?,sha?}` / `GitSubdir{url,path,ref?,sha?}` / `Npm{package,version?}`（解析出但安装报不支持）。
- `RawPluginEntry`：`name` + `source` + 元数据（`displayName/description/version/author/homepage/repository/category/tags/defaultEnabled`）+ 内联组件字段（`skills/commands/agents/hooks/mcpServers/lspServers/outputStyles/themes/monitors`，用于可用性判断与详情展示）。
- `MarketplaceManifest`：`name/owner/plugins/metadata{pluginRoot}`。相对源解析时拼 `metadata.pluginRoot` 前缀。
- `renames` 字段 v1 忽略（Aide 无历史安装，仅未来迁移用，记为后续）。

**安装目标解析**：

| RawSource | 安装动作 | 落盘 |
|---|---|---|
| Relative | 从该源 marketplace-cache 子目录**拷贝**到 plugin cache | `cache/<market>/<plugin>/<ver>/` |
| Github | `git clone --depth 1 [repo] [--branch ref]` | 同上 |
| Url | `git clone --depth 1 <url>` | 同上 |
| GitSubdir | 稀疏克隆 `--filter=blob:none --sparse --cone` 取 `path` | 同上 |
| Npm | 不执行，返回 `NPM_UNSUPPORTED` 错误 | — |

版本解析顺序：`plugin.json.version` → `marketplace entry.version` → git 短 SHA。SHA 作版本时 cache 目录名用 SHA，避免每次 commit 都重装。

### 4.2 设置层：`settings.rs` 的 `AppSettings` 加两字段

- `enabled_marketplaces: Vec<String>` — 哪些固定源开启
- `enabled_plugins: BTreeMap<String,bool>` — key = `"<plugin>@<market>"`，是否启用

走现有 `get_settings` / `set_settings` + `with_config_mut` 原子写。"已安装" = cache 目录存在；"已启用" = `enabled_plugins` 里 key 为 true。

### 4.3 sidecar 桥接

- Rust 维护 `~/.claude-code-desktop/claude-agent-sdk/enabled-plugins.json`（内容：`[{name, marketplace, path}]`），在任意 enable/disable/install/uninstall/update 后**原子重写**。spawn sidecar 时设 env `AIDE_ENABLED_PLUGINS_FILE` 指向它。
- `agent-sidecar/src/index.ts` 每次 `query()` 构造前读该文件 → `fs.existsSync(path)` 过滤失效项 → 构建 `options.plugins: [{type:"local", path}]` 传给 SDK。
- 保留 `skills:"all"`（负责非插件的 user/project skills）。
- **实现期需验证**：`skills:"all"` 与 `options.plugins` 是否对插件 skills 双重计数；若重复，调整（二选一或依赖 SDK 去重）。

### 4.4 前端层

- `useMarketplace.ts` 重写为多源：按 `enabled_marketplaces` 逐源 `fetch_marketplace(sourceId)`，结果带 source 标签合并；新增 `setEnabled` / `refreshSource` / `updatePlugin`。
- `MarketplaceTab.vue`：顶栏源开关条 + 搜索 + 类别筛选 + 卡片列表 + 「已隐藏 N 个不可用插件」行（可展开）。把 `errors.ts` 里没接线的 `go-marketplace-settings` 动作接到顶栏。
- `MarketplacePluginCard.vue`：扩展显示 displayName/category/version/更新徽标；按钮按状态切换（安装/启用/禁用/卸载/更新）；不可用项灰显。
- 插件详情视图：按需拉 `plugin.json`、列「将安装」组件 + 逐项可用性、全部不可用则禁用安装。
- 启动后台检查逻辑（前端触发 `refresh_marketplace` + 比对 → 调 `notify_send`）。

### 4.5 视觉基准

UI 实现**严格遵循** `docs/superpowers/specs/2026-07-13-marketplace-mockup.html`（同目录的原型）：源开关条形态、卡片布局与信息密度、状态点/徽标/caveat 样式、按钮状态切换、底部状态条。原型里的色值是独立 HTML 渲染用的硬编码 hex，实现时**逐个映射到对应的 `--aide-*` token**（不硬编码 hex，遵循主题系统红线）。原型可双击打开预览，作为实现期视觉对齐的唯一基准。

## 5. 数据流

**浏览**：前端 `fetchPlugins()` → 逐已启用源 `fetch_marketplace(sourceId)` → Rust git pull 源 cache → 解析 `marketplace.json` → 返回带 source 标签 + 可用性标记的 `PluginEntry[]` → 前端合并渲染（隐藏 only-不可用 项）。

**安装**：卡片「安装」→（社区源弹确认）→ `install_plugin(sourceId, pluginName)` → Rust 解析 source → clone/拷贝到 cache 三级目录 → 校验 `plugin.json` 存在 → 默认置 enabled → 原子重写桥接清单。

**启用→SDK 加载**：用户点「启用」→ `set_plugin_enabled` 改 AppSettings + 重写桥接清单 → 下次 `query()` 构造时 sidecar 读清单 → `options.plugins` 传入 → SDK 加载该插件的 skills/agents/hooks/MCP。

**更新**：刷新源 → 比对版本 → 卡片「有更新」→ 点「更新」→ `update_plugin` 拉新版到新 cache 目录、切换启用指针、旧版 7 天 GC → 重写桥接清单。

**启动检查**：前端 app ready → 后台逐源 `refresh_marketplace` → 比对已装版本 → 有更新/失败均走 `notify_send` 通知。

## 6. 错误处理

- 复用现有 `git_err` 分类（NETWORK_FAILURE / REPO_NOT_FOUND / TIMEOUT / UNKNOWN_ERROR）+ `errors.ts` 前端映射。
- 新增错误码：`NPM_UNSUPPORTED`（npm 源安装）、`SOURCE_TYPE_UNSUPPORTED`（未知 source 类型）。
- 启动后台检查的拉取失败**不阻塞 UI**，仅通知；市场页内手动刷新失败仍走现有错误条。
- 桥接清单里 path 已不存在（用户手动删了 cache 目录）→ sidecar 静默过滤，不崩；`list_installed_plugins` 以 cache 目录实际存在为准（启用表里有键但目录没了 = 未安装）。

## 7. 测试

- Rust 单测（仿现有 `app_settings_round_trips_camel_case`）：
  - `marketplace.json` 解析：五分支 source、`metadata.pluginRoot` 拼接、缺字段默认值、内联组件字段识别。
  - 安装目标解析：各 source 类型 → 正确 clone 目标 + cache 三级路径。
  - 版本解析顺序。
  - `enabled_plugins` / `enabled_marketplaces` round-trip + 旧 config.json 缺字段回填默认。
  - 可用性判断：only-不可用 → 隐藏；混合 → caveat；无内联 → 不标。
  - 7 天 GC：超过 7 天的旧版本目录被清。
- 手测：装一个官方插件（如 `commit-commands@claude-plugins-official`）→ 验证 `/` 下拉出现其 skill、SDK 自主调用、卸载后消失。装一个社区插件走信任确认。断网下启动 → 收到「市场更新拉取失败」通知。

## 8. 不在本次范围（记为后续）

- **npm 源安装**：两市场均无 npm 插件，v1 仅识别并报「暂不支持」。出现即优先补。
- **LSP / 输出样式 / 主题 / monitors 组件加载**：SDK 不加载，属 CLI 专属。Aide 未来若要支持需自行实现 LSP 接入（Aide 已有独立 LSP 工具，但插件 LSP 是另一条链路）。
- **`renames` 迁移**：Aide 无历史安装，v1 忽略。
- **用户自加任意市场源 / user-project-local scope / 团队 git 共享**：用户已明确选「固定源、不可自加、扁平 enabled」，这些不做。
- **CLI `enabledPlugins` 互通**：不读写 CLI 的 `~/.claude/settings.json`。

## 9. 实现期需验证的风险

1. `skills:"all"` × `options.plugins` 是否对插件 skills 双重计数 → 实测，必要时二选一或靠 SDK 去重。
2. 真实官方/社区源条目的 `category` 字段值分布 → 决定类别筛选标签是固定枚举还是动态聚合。
3. GitSubdir 稀疏克隆在 Windows + 代理下的稳定性 → 验证 `--filter=blob:none --sparse --cone` 行为，必要时退化为全 clone + 取子目录。
4. 启动后台检查的并发：与用户同时手动刷新同一源 → 复用按 source_id 串行或加锁。
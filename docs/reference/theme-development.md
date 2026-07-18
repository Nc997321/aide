# Aide 主题开发指南

给主题作者（人类开发者或未来的 Claude）的**封闭契约**。

> 视觉基准：`docs/superpowers/design-previews/2026-07-18-component-gallery.html`
> （组件陈列页，顶部三主题按钮：暖色精修 / 靛蓝换肤验证 / 玻璃后门验证）
> 设计依据：`docs/superpowers/specs/2026-07-18-ui-polish-design.md`

## 1. 核心契约：主题 = 一份 token 文件，仅此而已

**一个主题能做的一切**：新建一个实现 `ThemeTokens` 的 `.ts` 文件（`src/themes/`），在 `src/themes/index.ts` 的 `themes` 注册表加一个 key。完了。

**主题不能做的事（红线）**：

1. ❌ **主题不允许自带组件**——不在主题文件里写 DOM/组件/模板，不允许"只在某主题下渲染"的结构。
2. ❌ **组件里不允许 `if theme === 'xxx'` 分支**——组件对主题无感知，只读 `--aide-*` 变量。
3. ❌ **不允许硬编码颜色/阴影/圆角/间距**——全部 `var(--aide-*)`（项目既有红线）。
4. ❌ **不允许为主题发明"专属质感手法"**——想要新的视觉效果（新的光、新的材质），先往 `ThemeTokens` 加槽位、给**每个**主题文件补默认值，再在组件层消费。手法进组件，参数进 token。
5. ❌ **不允许新增"某主题专属组件"**——组件清单是全应用共享的封闭集（§3）。确实缺组件时，走组件层：在 `src/ui/` 新增全局组件，样式只引用 token，所有主题自动获得它。

一句话：**组件是"实现"，主题是"参数"。** 换主题 = 换参数，永远不换实现。

## 2. Token 槽位全表

`src/themes/tokens.ts` 的 `ThemeTokens` 是唯一配色来源。新增主题必须给**全部**槽位赋值（TypeScript 强制，漏了编译不过）。

### 2.1 基础槽位（既有）

| 槽位 | 语义 |
|---|---|
| `colorScheme` | `"dark"` / `"light"`，决定原生控件明暗（apply.ts 特判，不是 `--aide-*` 变量） |
| `bgDeep / bgBase / bgRaised / bgOverlay` | 四层底色：深井（输入框/代码井）→ 应用底 → 浮起面 → 遮罩 |
| `surfaceDefault / surfaceHover / surfaceActive` | 交互表面三态 |
| `textPrimary / textSecondary / textMuted / textOnAccent` | 文字四级 |
| `accent / accentHover / accentSubtle` | 强调色三态 |
| `success / warning / danger / info` | 功能色 |
| `border / borderSubtle` | 边框两档 |
| `shadowSm / shadowMd / shadowLg` | 阴影三档 |
| `radiusSm / radiusMd / radiusLg` | 圆角三档 |
| `spaceUnit` | 间距单位 |
| `stalled / syntaxKeyword / syntaxNumber` | 停滞警示色 / 语法高亮两色 |

### 2.2 质感槽位（2026-07-18 扩展）

| 槽位 | 语义 | 暖色精修示例 | 玻璃主题示例 |
|---|---|---|---|
| `highlightInset` | 浮起表面顶部 1px 受光 | `inset 0 1px 0 rgba(255,235,210,.07)` | `inset 0 1px 0 rgba(255,255,255,.12)` |
| `accentGradient` | 主按钮/开关/选中条渐变 | `linear-gradient(180deg,#e6bd8e,#cf9c66)` | `linear-gradient(180deg,rgba(160,180,255,.42),rgba(130,150,255,.3))` |
| `accentGlow` | 强调辉光投影 | `0 6px 20px rgba(212,165,116,.28)` | `0 4px 18px rgba(140,160,255,.38)` |
| `accentRing` | 输入框/焦点环 | `0 0 0 2.5px rgba(217,171,120,.32)` | `0 0 0 2.5px rgba(150,170,255,.42)` |
| `ambientGlow` | 对话区顶部环境光晕 | 暖色 radial-gradient | 冷色 radial-gradient |
| `borderStrong` | 悬停/浮层第三档边框 | `rgba(255,220,175,.16)` | `rgba(255,255,255,.17)` |
| `ease` / `easeT` | 动效曲线 / 时长+曲线 | `cubic-bezier(.2,.8,.2,1)` / `.16s …` | 同左（也可换性格） |
| `surfaceBlur`（后门） | 面板背景模糊 | `"none"` | `"blur(20px) saturate(150%)"` |
| `ambientScene`（后门） | 应用根层环境场景图 | `"none"` | 极光渐变组 |

**玻璃主题配方**（后门已内建，组件零改动）：surface 系颜色给 alpha → `surfaceBlur` 给模糊值 → `ambientScene` 给极光渐变 → `bgDeep` 保持深实底（代码编辑器/终端/diff 等编辑区豁免透明，可读性优先）→ `colorScheme: "dark"`。参照陈列页第三个主题按钮的完整 token 值。

## 3. 主题组件清单（封闭集）

以下是主题**能实现**的全部组件——主题作者不需要也不应该超出这个清单。每件都已在组件层封装好质感手法，主题只负责给 token 值。

### 3.1 基础控件（`src/ui/`，11 件）

| 组件 | 主题要验收的态 |
|---|---|
| `AButton` | default/hover/active/disabled × primary/默认/幽灵/危险 × 中/小 |
| `AInput` | default/focus（accentRing）/error/disabled、带图标 |
| `ADropdown` + `ThemedSelect`（`src/components/`） | 关闭/hover/展开菜单、选中勾、快捷键提示 |
| `ATabBar` | 常态/hover/active（渐变指示条）/脏点/关闭钮 |
| `ABadge` | accent/green/amber/grey 四调 |
| `AStatusDot` | running（呼吸+辉光）/attention/waiting/stopped |
| `ACard` | 常态/hover 上浮、 glow 变体 |
| `AToolbar` | 图标按钮常态/hover/active、分隔条 |
| `ATreeItem` | 常态/hover/选中（accent 内条）、展开箭头旋转 |
| `AToast` | 成功/失败/信息三态（左色条+微光） |
| `ACommandPalette` | 输入行、分组大写标签、active 项、kbd 键帽 |

### 3.2 反馈与容器（`src/components/`）

`ModalDialog`（遮罩+浮起对话框） · `v-tooltip` 指令卡片 · `NotificationBanner`（info/warn 渐变条） · `ContextMenu`（含危险项） · 空状态（图标盘+标题+引导按钮） · 滚动条（8px 胶囊） · 开关/设置行

### 3.3 聊天域

消息气泡（用户/助手） · 模型徽标 · `TurnUsageBadge`（tabular-nums） · `ToolCallBlock` / `ToolCallGroup`（折叠/展开/diff） · `SubagentCallBlock`（嵌套缩进线） · `BashOutputBlock`（ANSI 色） · `PermissionDialog`（warning 氛围框） · `ChatSendButton`（分裂按钮+下拉） · **思考状态行**（`AppLogo` 流光动画 + 计时 + 中断按钮） · `BtwDrawer` 浮层

### 3.4 数据展示

`FileTree` / `TreeNodeItem`（墨线箭头 + 描边文件夹 + 语言色文件字形 + git 状态字母） · `TaskListPanel`（勾选态） · `ChangeLogPanel` / `GitPanel`（分支胶囊 + +/− 统计） · `CustomizationList`（启停徽标）

### 3.5 编辑器与终端

`CodeEditor`（**含 CodeMirror 搜索面板/补全/goto-line——类名以 dist 源码为准，主题化坑点见组件内注释**） · `WorkbenchTerminal`（xterm 深底 + ANSI 色，样式必须非 scoped） · `DiffViewer`（并排/单栏，统一 diff 行语言：2px 左色条 + 8%/7% 底 + hunk info 行）

### 3.6 壳层

`TitleBar`（logo + 会话 chips + `NotificationBell` 角标 + `WindowControls`） · `SidebarLeft`（会话行四态） · `PaneSplit`（hover accent 发光线） / `PaneTabBar` · `SettingsPanel`（左 nav + 内容区） · 各 Dialog（`OpenFolderDialog` / `RemoveWorkspaceDialog` / `RunConfigsDialog`，均 ModalDialog 模式） · 市场页（`MarketplaceTab` / `MarketplacePluginCard`，ACard 模式）

### 3.7 品牌

`AppLogo`：四条 3D 弯曲缎带商标（源文件为准）。静态用于标题栏/关于页；**「流光」动画**（conic-gradient + 带形 mask，2.6s/圈，工具执行 1.1s）用于思考状态行。`prefers-reduced-motion` 下静止。

## 4. 新主题开发流程

1. 复制 `src/themes/warm-dark.ts` 为新文件，逐个槽位改值（**全部必填**，TypeScript 会拦）。
2. `src/themes/index.ts` 的 `themes` 注册表加 key。
3. 对照陈列页逐件核对（陈列页三主题按钮即「换 token 不换组件」的活证明）。
4. 验收清单：
   - 设置里切换到新主题，**整窗全部重配色**——哪块没变就是哪里漏了硬编码（去修组件，不是修主题）；
   - hover / focus / active / disabled 各态；
   - diff 三处（聊天 Edit diff / DiffViewer 并排+单栏 / FileViewer 文本 diff）一致；
   - 终端 ANSI 色、CM 搜索面板、tooltip、Toast、模态遮罩；
   - `prefers-reduced-motion` 下动效全部静止；
   - `colorScheme` 与底色明暗匹配（暗色主题给 `"dark"`）。

## 5. 常见问题

- **"我想让某主题有个特别的效果"** → 先判断：能表达为 token 值吗（颜色/透明度/模糊/渐变/阴影/圆角/动效曲线）？能，直接填；不能，回 §1 红线 4——加槽位（所有主题给默认值）+ 组件层消费，永远不写主题分支。
- **"我需要一个新组件"** → 它属于全局组件层，不属于主题。在 `src/ui/` 新建，样式只引用 `--aide-*`，并在陈列页补一档展示卡。主题文件里出现组件 = 违规。
- **"玻璃主题文字看不清"** → 编辑区用深实底 `bgDeep`（豁免透明），面板 alpha 别低于 0.45，文字保持不透明。

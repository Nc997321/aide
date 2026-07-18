# UI 质感精修设计 · 2026-07-18

状态：待评审
预览基准：`docs/superpowers/design-previews/2026-07-18-component-gallery.html`（组件陈列页，三主题按钮）
方向对比稿（历史存档）：`docs/superpowers/design-previews/2026-07-18-ui-directions.html`

## 1. 背景与目标

问题：整体 UI 有「廉价感」，集中在两点——**质感**（平面、无层次、无光影）与**字体/排版**（系统默认 Segoe UI 13px，无字阶）。

目标（与用户对齐的决策）：

1. **方向 = 暖色精修**：保留现有 warm-dark 琥珀血统做质感升级，不推翻信息架构与布局。
2. **质感封装进组件层**：高级感手法（顶光、辉光、渐变、阴影、动效）写进 `src/ui/A*` 与领域组件的实现，颜色与强度全部走 token。**新写主题 = 写一份 token 文件，组件自动把它"实现"成有质感的样子**——主题作者不需要懂质感技巧。
3. **质感强度也走 token**（用户确认）：顶光/辉光/渐变/模糊都是 `ThemeTokens` 槽位，主题可调性格。
4. **为未来「毛玻璃」主题留干净后门**（见 §4）。
5. 字体替换为陈列页同款字体系统（§6）。

非目标：不改布局/信息架构；不做 OS 级窗口透明（mica/acrylic）；不重写组件结构（只改样式与少量渲染辅助）；不动 sidecar/Rust 逻辑。

## 2. 核心架构：主题是 token，组件是实现

### 2.1 ThemeTokens 扩展

在现有约 26 个槽位基础上新增（`src/themes/tokens.ts`，`apply.ts` 的 camelCase→kebab 写入规则不变）：

| 槽位 | 作用 | warm-dark 精修值（示例） |
|---|---|---|
| `highlightInset` | 浮起表面顶部 1px 受光（按钮/卡片/菜单/模态共用） | `inset 0 1px 0 rgba(255,235,210,.07)` |
| `accentGradient` | 主按钮/开关/选中条的渐变强调 | `linear-gradient(180deg,#e6bd8e,#cf9c66)` |
| `accentGlow` | 主按钮与关键焦点的彩色辉光投影 | `0 6px 20px rgba(212,165,116,.28)` |
| `accentRing` | 输入框/焦点环 | `0 0 0 2.5px rgba(217,171,120,.32)` |
| `ambientGlow` | 对话区顶部环境光晕（空间主光源） | `radial-gradient(700px 240px at 50% -60px, rgba(224,181,132,.09), transparent 70%)` |
| `borderStrong` | 悬停/浮层用第三档边框（现有 border/borderSubtle 之外） | `rgba(255,220,175,.16)` |
| `ease` / `easeT` | 统一动效：`ease` 为曲线本身，`easeT` 为「时长+曲线」快捷写法 | `cubic-bezier(.2,.8,.2,1)` / `.16s cubic-bezier(.2,.8,.2,1)` |
| `surfaceBlur`（后门） | 面板背景模糊，默认 `"none"` | `"none"` |
| `ambientScene`（后门） | 应用根层环境场景图，默认 `"none"` | `"none"` |

同时精修既有槽位（暖色方向）：底色加深一档、边框改暖色（`rgba(255,214,160,.09)`）、圆角放大为 6/9/13px、阴影加深分层。

### 2.2 组件层纪律

- 所有颜色/边框/阴影/圆角/动效只引用 `--aide-*` token（既有红线不变）。
- 面板容器统一带 `backdrop-filter: var(--aide-surface-blur, none)`（§4 后门本体）。
- 应用根层（`body`）背景 = `var(--aide-ambient-scene, var(--aide-bg-deep))`。
- 旧主题文件（warm-dark / catppuccin）补齐新槽位默认值；warm-dark 直接升级为「暖色精修」值。

## 3. 组件精修手法（陈列页为验收基准）

- 每个浮起表面带 `highlightInset` 顶光——光从上往下照，扁平与立体的分水岭。
- 主按钮 = `accentGradient` + `accentGlow` + 内顶光，不再纯色块。
- hover 统一 1px 上浮 + 边框增亮（borderStrong）+ 阴影升档，全部走 `easeT`。
- 输入框/代码井用内凹阴影（嵌进去）与面板浮起（凸出来）形成纵深对比。
- 覆盖范围（陈列页逐一对应）：`src/ui/` 全部 11 件 + 领域件（ToolCallBlock/Group、SubagentCallBlock、BashOutputBlock、PermissionDialog、ChatSendButton、TaskListPanel、ChangeLogPanel、GitPanel、FileTree/TreeNodeItem、CustomizationList、ContextMenu、NotificationBanner、TurnUsageBadge、CodeEditor 含 CM 搜索面板、WorkbenchTerminal、DiffViewer、TitleBar/NotificationBell、SidebarLeft、PaneSplit、BtwDrawer、SettingsPanel、ModalDialog 系、AToast、tooltip、空状态、滚动条）。
- 文件树图标沿用现行实现（墨线三角箭头 + 描边文件夹 + 语言色字形），仅随主题 token 重新着色。

## 4. 毛玻璃后门（用户确认要留）

- 两个惰性槽位 `surfaceBlur` / `ambientScene`，现有主题给 `"none"`——零效果、零运行时成本。
- 未来玻璃主题 = 纯新增一个 token 文件：surface 系颜色带 alpha + `surfaceBlur: "blur(20px) saturate(150%)"` + `ambientScene` 极光渐变。**组件零改动**（陈列页「玻璃 · 后门验证」按钮即证明）。
- 编辑区豁免：CodeEditor / 终端 / diff 视图用深实底 token，不走透明（可读性优先）。
- 明确不做 OS 级透明（mica/acrylic/transparent window）；应用内极光是唯一 sanctioned 路径。

## 5. 统一 diff 行语言

一处定义、三处应用（用户明确要求聊天 Edit diff 与 DiffViewer 一致）：

- 删除行 = `--aide-danger` 8% 底 + 85% 混色文字 + 左侧 2px 色条；新增行 = `--aide-success` 7% 底同款；hunk 行 = `--aide-info` 5% 底；上下文行 muted 无底色。
- **一律不出现 +/− 符号**（用户确认）：查看器给 34px 真实行号列；聊天内联（无原始文件）只有着色行——增删全靠 2px 色条+底色表达，与 DiffView 视觉一致。
- 全部 mono 字体、同字号行高。
- 实施落点：
  1. `global.css` 的 `.aide-diff-add/del/hunk/meta/ctx` 升级为该语言（聊天 Edit diff 与 FileViewer 文本 diff 共用，一改两处自动一致）；
  2. `utils/editDiff.ts` 去掉行文本的 +/− 前缀（`buildEditDiffLines` 输出无前缀纯文本）；FileViewer 的 git 文本 diff 若带行首 +/− 前缀同样去除（行类型已由 cls 表达）；
  3. `DiffViewer.vue` 的 CM merge 主题（`.cm-changedLine` 等）对齐同款透明度/色条。

## 6. 字体系统

- **本地打包**，不走 CDN：`@fontsource-variable/inter` + `@fontsource/noto-sans-sc` + `@fontsource/jetbrains-mono`（Noto Sans SC 按 unicode-range 分包，只加载用到的字片）。
- 字阶：正文 13px/1.65（Inter + Noto Sans SC）；强调标题 600/-0.01em；微型标签 10.5px/600/大写/0.12em；代码 JetBrains Mono 11.5px/1.7；数字 `tabular-nums`（用量/计时不跳动）。
- 落点：`global.css` body 字体栈替换；等宽场景（代码井/diff/终端/用量行）统一 JetBrains Mono；编辑器默认 `settings.fontFamily` 改 JetBrains Mono 栈（用户已自定义的不动）。

## 7. 品牌系统

- 商标 = 四条 3D 弯曲缎带（圆角弧带 + 沿弧渐变 + 内缘高光）。**以用户提供的商标源文件为准**（SVG/高清 PNG，实施时交付）；陈列页内为按截图的近似重建。
- 新组件 `AppLogo.vue`：props = 尺寸 / 动效变体 / 转速；`prefers-reduced-motion` 下静止。标题栏、思考状态行、设置关于页共用；`.ico` 应用图标后续由源文件生成（独立小任务）。
- **「思考中」动效 = 变体 B「流光」**（用户选定）：缎带静止，`conic-gradient` 在带形 mask 下 2.6s/圈流转；工具执行中加速至 1.1s。mask 由商标剪影生成。纯 CSS 合成线程动画（`@property` 角度动画 + transform/opacity），零 JS、不碰主线程（符合黑匣子红线）。
- `.chat-thinking` 状态行改造：AppLogo（流光）+ 文案 + `tabular-nums` 计时 + 描边「中断」小按钮（常态 32% 红边，hover 出 12% 红底+微光），替换现行裸文本+裸红字。

## 8. 验证

- 设置里切 warm-dark ↔ catppuccin，整窗全部重配色（既有红线验收）。
- 新增玻璃 token 主题（标记 experimental，长期保留——后门本就是为它留的），切换后组件零改动呈现毛玻璃。
- 对照陈列页逐组件验收视觉；动效在 `prefers-reduced-motion` 下全部静止。
- 性能验收：无 JS 驱动动画；`backdrop-filter` 在现有主题下为 `none`（合成器零开销）；字体子集按需加载，首屏不阻塞。
- 黑匣子回归：精修后长会话流式渲染无新增冻结（动画全在合成线程）。

## 9. 现行实现锚点（实施时对照）

`src/themes/tokens.ts`（槽位）、`src/themes/apply.ts`（写入）、`src/styles/global.css`（body 栈 / `.aide-diff-*` / 滚动条）、`src/utils/editDiff.ts`（符号列拆分）、`src/components/fileviewer/DiffViewer.vue`（CM merge 主题）、`src/components/ChatPanel.vue`（`.chat-thinking` / `.chat-interrupt-btn`）、`src/components/TreeNodeItem.vue`（树图标）、`src/utils/icons.ts`（铜线图标系统）、`src/ui/*`（11 件基础组件）。

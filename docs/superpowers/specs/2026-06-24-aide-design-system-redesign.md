# Aide 视觉重设计 — 完整设计系统（方案 C）

> 日期: 2026-06-24
> 状态: 待实施
> Mockup: `scratchpad/aide-design-preview.html`（温暖暗色调 + 卡片化 + 命令面板预览）

## 1. 设计目标

将 Aide 从"Catppuccin 暗色三栏 IDE 壳"升级为有独特辨识度的工匠质感桌面应用。

**核心原则：**
- 工匠质感（Raycast / Arc 参考）：微妙渐变、精致圆角、多层阴影、温暖色调
- 不大众：拒绝标准 IDE 模板外观，追求产品独特性
- 围绕核心价值设计：多会话管理 + 状态感知 + 桌面通知

**不做的事：**
- 不重写业务逻辑（composables、Rust commands、PTY 管理不动）
- 不改变数据流架构（polling 模式、会话状态机不变）
- 不引入新的前端框架或构建工具

## 2. 主题架构

### 2.1 目录结构

```
src/
  themes/
    tokens.ts          # ThemeTokens 接口定义
    warm-dark.ts       # 默认主题：温暖暗色调
    catppuccin.ts      # 兼容主题：迁移现有 Catppuccin 配色
    apply.ts           # applyTheme(tokens) → 注入 CSS 变量到 :root
```

### 2.2 Token 接口

```ts
export interface ThemeTokens {
  // ── 背景层次（从深到浅） ──
  bgDeep: string;        // 最深层：标题栏、侧栏底色
  bgBase: string;        // 主背景：终端区域
  bgRaised: string;      // 浮起层：卡片、下拉菜单
  bgOverlay: string;     // 遮罩层：弹窗背景（带透明度）

  // ── 表面（交互元素） ──
  surfaceDefault: string;
  surfaceHover: string;
  surfaceActive: string;

  // ── 文字 ──
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnAccent: string;

  // ── 强调色 ──
  accent: string;
  accentHover: string;
  accentSubtle: string;   // accent 的 ~12% 透明度

  // ── 语义色 ──
  success: string;
  warning: string;
  danger: string;
  info: string;

  // ── 边框 ──
  border: string;
  borderSubtle: string;

  // ── 阴影 ──
  shadowSm: string;       // 卡片微阴影
  shadowMd: string;       // 浮起面板
  shadowLg: string;       // 弹窗 / 命令面板

  // ── 圆角 ──
  radiusSm: string;       // 4px — 按钮、badge
  radiusMd: string;       // 8px — 卡片、输入框
  radiusLg: string;       // 12px — 面板、弹窗

  // ── 间距基础单位 ──
  spaceUnit: string;      // 4px，所有间距是它的倍数
}
```

### 2.3 Warm Dark 配色

| Token | 值 | 说明 |
|-------|-----|------|
| bgDeep | `#1a1a22` | 带微紫的炭灰 |
| bgBase | `#22222e` | 暖灰紫底 |
| bgRaised | `#2a2a38` | 卡片背景 |
| bgOverlay | `rgba(10, 10, 15, 0.75)` | 弹窗遮罩 |
| surfaceDefault | `#32323f` | 交互元素默认 |
| surfaceHover | `#3a3a4a` | hover 态 |
| surfaceActive | `#44445a` | active/pressed |
| textPrimary | `#d8d4cf` | 暖白 |
| textSecondary | `#a8a4a0` | 次要文字 |
| textMuted | `#6b6762` | 辅助文字 |
| textOnAccent | `#1a1a22` | accent 背景上的文字 |
| accent | `#d4a574` | 琥珀/焦糖 |
| accentHover | `#e0b584` | accent hover |
| accentSubtle | `rgba(212, 165, 116, 0.12)` | accent 微光 |
| success | `#8bc48a` | 运行中 / 成功 |
| warning | `#e8c374` | 需要注意 |
| danger | `#e87070` | 错误 / 停止 |
| info | `#7eb8d8` | 信息 / 工具调用 |
| border | `rgba(255, 255, 255, 0.06)` | 主边框 |
| borderSubtle | `rgba(255, 255, 255, 0.03)` | 微边框 |
| shadowSm | `0 1px 3px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)` | 卡片 |
| shadowMd | `0 4px 12px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2)` | 面板 |
| shadowLg | `0 12px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.25)` | 弹窗 |
| radiusSm | `4px` | 按钮、badge |
| radiusMd | `8px` | 卡片、输入框 |
| radiusLg | `12px` | 面板、弹窗 |
| spaceUnit | `4px` | 间距基础单位 |

### 2.4 applyTheme 机制

```ts
// apply.ts
export function applyTheme(tokens: ThemeTokens) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(tokens)) {
    // camelCase → kebab-case: bgDeep → --aide-bg-deep
    const cssVar = `--aide-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
    root.style.setProperty(cssVar, value);
  }
}
```

在 `App.vue` 的 `onMounted` 中调用。主题选择持久化到 `AppSettings.theme`，`useSettings` 加载时读取。

### 2.5 CSS 变量命名规范

所有 CSS 变量统一前缀 `--aide-`。`global.css` 中现有的 `--bg-primary` 等变量全部替换：

| 旧变量 | 新变量 |
|--------|--------|
| `--bg-primary` | `--aide-bg-base` |
| `--bg-secondary` | `--aide-bg-deep` |
| `--bg-tertiary` | `--aide-bg-deep`（同层） |
| `--surface` | `--aide-surface-default` |
| `--surface-hover` | `--aide-surface-hover` |
| `--text-primary` | `--aide-text-primary` |
| `--text-secondary` | `--aide-text-secondary` |
| `--text-muted` | `--aide-text-muted` |
| `--accent` | `--aide-accent` |
| `--accent-green` | `--aide-success` |
| `--accent-yellow` | `--aide-warning` |
| `--accent-red` | `--aide-danger` |

### 2.6 Catppuccin 兼容主题

`catppuccin.ts` 导出一个 `ThemeTokens` 对象，值与现有 `global.css` 中的硬编码色值一一对应。用户切换到此主题时，视觉效果与改版前一致。

## 3. 原子组件库

### 3.1 目录结构

```
src/
  ui/
    AButton.vue
    ABadge.vue
    ACard.vue
    ATabBar.vue
    AToolbar.vue
    APanel.vue
    AInput.vue
    ADropdown.vue
    AStatusDot.vue
    ACommandPalette.vue
    ATreeItem.vue
    index.ts
```

### 3.2 设计原则

1. **零业务逻辑**：`ui/` 下组件不 import `api`、不 import `composables`，纯 props/emits/slots
2. **所有颜色来自 CSS 变量**：组件内不写任何硬编码色值
3. **粒度适中**：不做 AText、ADivider 等过细原子，只抽有复用价值的组件

### 3.3 组件规格

#### AButton

| Prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| variant | `'primary' \| 'ghost' \| 'danger'` | `'ghost'` | 视觉风格 |
| size | `'sm' \| 'md'` | `'md'` | 尺寸 |
| disabled | `boolean` | `false` | 禁用态 |

- `primary`: accent 背景 + textOnAccent 文字 + shadowSm
- `ghost`: 透明背景 + surfaceHover on hover + border
- `danger`: 透明 + danger 边框 + danger 文字

#### ABadge

| Prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| value | `number \| string` | — | 显示内容 |
| color | `'accent' \| 'success' \| 'warning' \| 'danger'` | `'accent'` | 颜色 |

- 圆角 8px，min-width 16px，font-size 10px，font-weight 700

#### ACard

| Prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| active | `boolean` | `false` | 激活态 |
| hoverable | `boolean` | `true` | 是否有 hover 效果 |
| glowColor | `string \| undefined` | — | 左边缘发光色（用于 running 脉冲） |

| Slot | 说明 |
|------|------|
| default | 卡片内容 |

- 默认: bgRaised + border + radiusMd
- hover: shadowSm + surfaceHover 背景
- active: accent 渐变微光边框 + shadowSm
- glowColor 存在时: 左边缘 2px 带脉冲动画

#### ATabBar

| Prop | 类型 | 说明 |
|------|------|------|
| tabs | `Array<{id: string, label: string, icon?: string, badge?: number}>` | Tab 定义 |
| modelValue | `string` | 当前选中 tab id |

| Emit | 说明 |
|------|------|
| update:modelValue | tab 切换 |

- 底部 2px accent 指示线，transition 滑动
- badge 用 ABadge 渲染
- 键盘 ←→ 切换

#### AToolbar

| Slot | 说明 |
|------|------|
| left | 左侧内容（状态点 + 会话名） |
| center | 中间内容（通常空） |
| right | 右侧内容（操作按钮） |

- 高度 34px
- 背景: bgDeep + 微渐变顶部高光 `linear-gradient(180deg, rgba(255,255,255,0.015) 0%, transparent 100%)`
- 底部 1px border

#### APanel

| Prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| collapsible | `boolean` | `false` | 是否可折叠 |
| collapsed | `boolean` | `false` | 折叠状态（v-model） |
| resizable | `boolean` | `false` | 是否可拖拽调整大小 |
| direction | `'horizontal' \| 'vertical'` | `'horizontal'` | 拖拽方向 |
| minSize | `number` | `200` | 最小尺寸 px |
| maxSize | `number` | `500` | 最大尺寸 px |

| Slot | 说明 |
|------|------|
| default | 面板内容 |
| collapse-trigger | 折叠触发区（默认渲染箭头条） |

#### AInput

| Prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| modelValue | `string` | — | 输入值 |
| placeholder | `string` | — | 占位文字 |
| icon | `string \| undefined` | — | 左侧图标 |

- 背景: surfaceDefault
- 聚焦: accent 边框 + `box-shadow: 0 0 0 2px var(--aide-accent-subtle)`

#### ADropdown

| Prop | 类型 | 说明 |
|------|------|------|
| open | `boolean` | 打开状态 |
| items | `Array<{id, label, icon?, divider?}>` | 菜单项 |

| Emit | 说明 |
|------|------|
| select | 选中项 |
| close | 关闭 |

- shadowMd + radiusMd + 进入动画（scale 0.95→1 + opacity）
- Teleport to body

#### AStatusDot

| Prop | 类型 | 说明 |
|------|------|------|
| status | `'stopped' \| 'running' \| 'waiting' \| 'attention'` | 状态 |

- stopped: textMuted 灰色
- running: success 绿色 + `box-shadow: 0 0 6px` 发光 + 脉冲动画
- waiting: accent 琥珀色
- attention: warning 黄色 + 发光

#### ACommandPalette

| Prop | 类型 | 说明 |
|------|------|------|
| open | `boolean` | 打开状态 |
| providers | `SearchProvider[]` | 搜索数据源（复用现有 `useSearchProviders` 接口） |

| Emit | 说明 |
|------|------|
| close | 关闭 |
| select | 选中项 `{type, id, data}` |

- 居中悬浮，宽度 560px，max-height 400px
- 背景遮罩: bgOverlay + `backdrop-filter: blur(8px)`
- 容器: bgRaised + radiusLg + shadowLg
- 分类区段标签（会话 / 文件 / 命令），10px 大写字母
- 键盘导航: ↑↓ 高亮，Enter 选中，Esc 关闭
- 输入防抖 150ms

#### ATreeItem

| Prop | 类型 | 说明 |
|------|------|------|
| label | `string` | 显示文字 |
| icon | `string` | 图标 |
| depth | `number` | 缩进层级 |
| isDir | `boolean` | 是否为目录 |
| expanded | `boolean` | 展开状态 |
| active | `boolean` | 选中态 |

| Emit | 说明 |
|------|------|
| toggle | 点击箭头 |
| select | 点击节点 |

- 缩进: `padding-left: depth * 16px`
- active: accentSubtle 背景 + accent 文字

## 4. 布局重构

### 4.1 App.vue — CSS Grid

```css
.app-layout {
  display: grid;
  grid-template-columns:
    var(--aide-left-w, 280px)
    1px                          /* 左分隔线 */
    minmax(400px, 1fr)           /* 终端 */
    1px                          /* 右分隔线 */
    var(--aide-right-w, 300px);  /* 右面板 */
  grid-template-rows: 1fr;
}
```

折叠时：对应列设为 `0px`，分隔线设为 `0px`。

### 4.2 useResizable composable

统一三套拖拽逻辑为一个 composable：

```ts
function useResizable(options: {
  cssVar: string;          // e.g. '--aide-left-w'
  min: number;
  max: number;
  direction: 'left' | 'right';  // 鼠标移动方向与尺寸增长的关系
}): {
  onMousedown: (e: MouseEvent) => void;
  isDragging: Ref<boolean>;
}
```

`App.vue` 从 ~50 行拖拽代码缩减到 3 次 `useResizable()` 调用。

### 4.3 右面板三 Tab

```vue
<ATabBar
  :tabs="[
    { id: 'files', label: '文件', icon: '📁' },
    { id: 'changes', label: '变更', icon: '✎', badge: changeCount },
    { id: 'git', label: 'Git', icon: '⎇', badge: unstagedCount },
  ]"
  v-model="rightTab"
/>

<div class="tab-content">
  <FileTree v-show="rightTab === 'files'" ... />
  <ChangeLogPanel v-show="rightTab === 'changes'" ... />
  <GitPanel v-show="rightTab === 'git'" ... />
</div>
```

**关键变化：** ChangeLogPanel 从 FileTree 的子区域提升为独立 Tab。删除纵向拖拽分隔条和 `changeLogHeight` 相关逻辑。`@collapse-changed` emit 不再需要。

### 4.4 终端面板 — AToolbar

```vue
<!-- TerminalPanel.vue -->
<AToolbar>
  <template #left>
    <AStatusDot :status="currentStatus" />
    <span class="toolbar-session-name">{{ sessionName }}</span>
  </template>
  <template #right>
    <AButton v-if="!isLive" variant="ghost" @click="tryStartClaude">▶ 启动</AButton>
    <AButton v-else variant="danger" @click="stopClaude">⏹ 停止</AButton>
  </template>
</AToolbar>
```

`currentStatus` 从 `useSessionState` 读取，与侧栏卡片同源。`sessionName` 从当前会话元数据获取。

### 4.5 左侧栏 — 卡片化

```vue
<!-- SidebarLeft.vue: session rendering -->
<ACard
  v-for="s in wsSessions(ws.key)"
  :key="s.id"
  :active="activeSessionId === s.id"
  :glow-color="sessionState[s.id] === 'running' ? 'var(--aide-success)' : undefined"
  @click="selectSession(s.id)"
  @contextmenu.prevent="onSessionContextMenu($event, s.id)"
>
  <div class="session-card-header">
    <AStatusDot :status="sessionState[s.id] || 'stopped'" />
    <span class="session-name">{{ s.name }}</span>
    <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
  </div>
  <div class="session-preview">{{ s.last_message }}</div>
</ACard>
```

删除侧栏搜索框（`.search-box` + `.search-input`），搜索统一到 `ACommandPalette`。

### 4.6 标题栏 — 搜索触发器

`SearchBox.vue` 删除。`TitleBar.vue` 改为：

```vue
<div class="titlebar">
  <div class="titlebar-brand">...</div>

  <!-- 静态触发器，点击打开命令面板 -->
  <button class="titlebar-search-trigger" @click="emit('open-palette')">
    🔍 搜索会话、文件或命令...
    <kbd>Ctrl+P</kbd>
  </button>

  <WindowControls />
</div>
```

`ACommandPalette` 在 `App.vue` 中 Teleport to body：

```vue
<ACommandPalette
  :open="paletteOpen"
  :providers="searchProviders"
  @close="paletteOpen = false"
  @select="onPaletteSelect"
/>
```

## 5. 视觉细节（工匠质感）

这些细节是与"大众 IDE"拉开差距的关键：

### 5.1 微渐变

- 标题栏和终端工具栏顶部: `linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)` — 模拟顶部光照
- 活跃卡片: `linear-gradient(135deg, rgba(212,165,116,0.06) 0%, transparent 60%)` — accent 微光

### 5.2 分隔线

- 面板间分隔线从 3px 粗灰条改为 1px 细线 `rgba(255,255,255,0.06)`
- hover 时变为 accent 色 + 微光 `box-shadow: 0 0 8px rgba(212,165,116,0.2)`

### 5.3 动画

| 元素 | 动画 | 参数 |
|------|------|------|
| 卡片 hover | 背景 + 阴影渐变 | `transition: all 0.15s ease` |
| Tab 切换指示线 | 水平滑动 | `transition: left 0.2s ease, width 0.2s ease` |
| 命令面板打开 | scale + opacity | `from scale(0.96) opacity(0) to scale(1) opacity(1), 0.12s ease-out` |
| 命令面板遮罩 | opacity | `0.15s ease` |
| 下拉菜单 | scale + opacity | 同命令面板 |
| running 状态点 | 发光脉冲 | `box-shadow 2s ease-in-out infinite` |
| running 卡片左缘 | 亮度脉冲 | `opacity 2s ease-in-out infinite` |
| 折叠面板 | width transition | `0.2s ease` |

### 5.4 圆角一致性

| 元素 | 圆角 |
|------|------|
| 按钮、badge、状态点 | radiusSm (4px) |
| 卡片、输入框、下拉菜单 | radiusMd (8px) |
| 命令面板、设置弹窗 | radiusLg (12px) |

## 6. 组件删除清单

| 文件 | 原因 |
|------|------|
| `src/components/titlebar/SearchBox.vue` | 被 `ACommandPalette` 替代 |
| `src/components/SettingsModal.vue` | 已被 `SettingsPanel.vue` 替代（历史遗留） |

## 7. 文件变更矩阵

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/themes/tokens.ts` | 新建 | ThemeTokens 接口 |
| `src/themes/warm-dark.ts` | 新建 | 默认主题 |
| `src/themes/catppuccin.ts` | 新建 | 兼容主题 |
| `src/themes/apply.ts` | 新建 | applyTheme() |
| `src/ui/AButton.vue` | 新建 | 按钮组件 |
| `src/ui/ABadge.vue` | 新建 | 角标组件 |
| `src/ui/ACard.vue` | 新建 | 卡片组件 |
| `src/ui/ATabBar.vue` | 新建 | Tab 栏组件 |
| `src/ui/AToolbar.vue` | 新建 | 工具栏组件 |
| `src/ui/APanel.vue` | 新建 | 可折叠面板组件 |
| `src/ui/AInput.vue` | 新建 | 输入框组件 |
| `src/ui/ADropdown.vue` | 新建 | 下拉菜单组件 |
| `src/ui/AStatusDot.vue` | 新建 | 状态点组件 |
| `src/ui/ACommandPalette.vue` | 新建 | 命令面板组件 |
| `src/ui/ATreeItem.vue` | 新建 | 树节点组件 |
| `src/ui/index.ts` | 新建 | Barrel export |
| `src/composables/useResizable.ts` | 新建 | 统一拖拽逻辑 |
| `src/styles/global.css` | 重写 | CSS 变量全部替换为 `--aide-*`，删除硬编码色值 |
| `src/App.vue` | 重写布局 | Grid 三栏 + 右面板三 Tab + 命令面板集成 |
| `src/components/SidebarLeft.vue` | 修改 | 删搜索框，会话条目用 ACard + AStatusDot |
| `src/components/TerminalPanel.vue` | 修改 | 加 AToolbar |
| `src/components/ChangeLogPanel.vue` | 修改 | 删 `@collapse-changed`，独立为 Tab |
| `src/components/FileTree.vue` | 修改 | 内部用 ATreeItem 替换手写节点 |
| `src/components/GitPanel.vue` | 修改 | 样式迁移到 Token |
| `src/components/titlebar/TitleBar.vue` | 修改 | 删 SearchBox，加搜索触发器按钮 |
| `src/components/titlebar/SearchBox.vue` | 删除 | 被 ACommandPalette 替代 |
| `src/components/SettingsModal.vue` | 删除 | 历史遗留 |
| `src/components/SettingsPanel.vue` | 修改 | 样式迁移到 Token |
| `src/components/ContextMenu.vue` | 修改 | 样式迁移到 Token |
| `src/components/ModalDialog.vue` | 修改 | 样式迁移到 Token |
| `src/components/FileViewer.vue` | 修改 | 样式迁移到 Token |
| `src/components/TreeNodeItem.vue` | 修改 | 内部改用 ATreeItem 或直接替代 |
| `src/types.ts` | 修改 | AppSettings 加 `theme: string` 字段 |
| `src/composables/useSettings.ts` | 修改 | 加载/保存 theme 选项 |
| `src/composables/useSearchProviders.ts` | 修改 | 适配 ACommandPalette 的 provider 接口 |

## 8. 迁移阶段

每个阶段结束后应用可正常运行。

### 阶段 1: 主题基础设施

新建 `src/themes/` 四个文件。`global.css` 中 CSS 变量从硬编码值改为 `--aide-*` 变量（值暂时不变，只改变量名）。`App.vue` `onMounted` 调用 `applyTheme(warmDark)`。

**验证**: 应用启动，视觉与改版前一致（因为 catppuccin 值映射到了新变量名）。

### 阶段 2: 原子组件

新建 `src/ui/` 全部 11 个组件 + `index.ts`。此阶段不修改任何现有组件。

**验证**: `import { ACard } from '@/ui'` 不报错。可以在任意组件中临时渲染 `<ACard>test</ACard>` 验证样式。

### 阶段 3: 命令面板替换 SearchBox

新建 `ACommandPalette`，`TitleBar.vue` 删除 `SearchBox` 引用，改为搜索触发器按钮。`App.vue` 挂载 `ACommandPalette`。`useSearchProviders` 适配新接口。删除 `SearchBox.vue`。

**验证**: Ctrl+P 打开命令面板，搜索会话和文件，选中跳转正常。

### 阶段 4: 左侧栏卡片化

`SidebarLeft.vue` 内部重写：删搜索框，会话条目用 `ACard` + `AStatusDot`。

**验证**: 会话列表渲染正常，状态指示正常，右键菜单正常，running/waiting/attention 动画正常。

### 阶段 5: 布局 Grid + 右面板三 Tab

`App.vue` 布局从 flex 改为 Grid。新建 `useResizable`，替换三套拖拽函数。右面板改为 `ATabBar` + 三个 `v-show` Tab。`ChangeLogPanel` 从文件 Tab 提升为独立 Tab，删除 `changeLogHeight`/`changeLogCollapsed`/纵向拖拽相关代码。

**验证**: 三栏拖拽正常，右面板三 Tab 切换正常，折叠/展开正常。

### 阶段 6: 终端工具栏

`TerminalPanel.vue` 顶部加 `AToolbar`，含 `AStatusDot` + 会话名 + 启动/停止按钮。

**验证**: 工具栏显示正常，启动/停止按钮功能正常，状态同步正常。

### 阶段 7: 全局样式清理 + 切换主题

1. 全局扫描所有组件，将剩余硬编码色值替换为 `var(--aide-*)` 变量
2. `SettingsPanel.vue` 通用 Tab 加"主题"下拉（warm-dark / catppuccin）
3. `AppSettings` 加 `theme` 字段，`useSettings` 加载时调用 `applyTheme`
4. 删除 `SettingsModal.vue`（历史遗留）
5. 删除 `global.css` 中所有旧的硬编码 `:root` 变量块

**验证**: 切换主题后所有组件颜色正确更新。两个主题下完整功能测试。

## 9. 不变的部分

以下不在本次改版范围内：

- Rust 侧所有 commands（PTY、Git、文件系统、会话、市场）
- PTY 管理架构（polling 模式、双线程模型）
- 会话状态机（useSessionState、useSessionMonitor）
- 数据流（轮询间隔、缓冲区机制）
- 会话 ID 迁移逻辑
- 通知系统（useNotification、useWindowFocus）
- 自定义/扩展系统（customizations CRUD）
- 插件市场（marketplace fetch/install）
- 工作台终端（WorkbenchTerminal）
- 文件查看器功能逻辑（FileViewer、CodeEditor）
- 设置面板功能逻辑（仅样式变更 + 加主题选项）

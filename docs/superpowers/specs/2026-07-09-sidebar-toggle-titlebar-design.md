# 标题栏侧边栏收起按钮设计

> 日期：2026-07-09
> 状态：设计已确认，待实现

## 背景与动机

现有侧边栏收起入口是 `App.vue` 里的 `collapse-toggle`——贴在 `panel-left` / `panel-right` 内侧边缘、**hover 才显示**的竖条，图标是 chevron 箭头 `> / <`。存在三个问题：

1. 位置在侧栏**内侧**边缘而非窗口边缘，不符合"窗口边缘收起按钮"的直觉。
2. hover 才出现，不直观，用户难以发现。
3. chevron 箭头不如 VSCode 那种"方块被竖线分成两半"的布局按钮直观——后者一眼能看出当前哪一侧可见。

目标：把收起入口换成标题栏两端的 VSCode 风格按钮，图标直观反映布局状态。

## 目标 / 非目标

**目标**
- 在标题栏左右端各加一个收起/展开按钮，与搜索框同一条横线。
- 图标采用 VSCode 风格"方块被竖线分成两半"，窄半代表对应侧边栏，填充程度反映可见状态。
- 移除现有 hover 竖条 `collapse-toggle`。
- 视觉贴合现有 Catppuccin 暗色主题与标题栏图标按钮语言。

**非目标**
- 不改 `leftCollapsed` / `rightCollapsed` 的状态语义和 grid 轨道宽度逻辑（单一数据源不变）。
- 不改 `resize-handle`、`SidebarLeft`、`FileViewer` 浮层等既有行为。
- 不引入新的状态持久化（收起态本就由现有 ref 驱动，不额外落盘）。

## 现状

`App.vue` 关键结构：
- `leftCollapsed` / `rightCollapsed`：`ref(false)`，grid 轨道宽度的单一数据源。
- `gridTemplateColumns` computed：收起 → `10px`，展开 → `var(--aide-left-w/right-w)`。
- 旧 `collapse-toggle`（模板 539-545 / 583-589 行 + CSS 737-806 行）：贴在侧栏内侧边缘，hover 显示，chevron 箭头靠旋转表示方向。

`TitleBar.vue` 结构（flex，`height:42px`）：
- `.titlebar-left`：logo + 项目名 + git 分支 + 运行配置
- 中段 `.titlebar-search-trigger`：搜索框
- `.titlebar-right`：活跃会话指示 + `WindowControls`（最小化/最大化/关闭）

现有图标按钮语言（`titlebar-run-btn` / `run-play-btn`）：透明背景 + `radius-sm`(4px) + hover `color-mix(accent 12%, transparent)`，颜色全用主题 token。

## 设计

### 方案选择

抽独立组件 `SidebarToggle.vue`（TitleBar 子实现，放 `titlebar/` 同级目录），props/emit 接线。**不**内联进 TitleBar（已 776 行，且违反"不在现有组件内内联堆代码"红线）。

### §1 图标视觉语义

VSCode 风格：一个方块被一条竖线分成宽窄两半。**窄半代表对应侧边栏，宽半代表其余区域。** 窄半的填充程度 = 该侧边栏可见状态。

**左按钮**（切线偏左，左半窄）：
- 展开态：左半（窄）填充 `accent` → 表示左侧栏可见
- 收起态：左半（窄）低对比半透明 → 表示左侧栏已隐藏
- 点击：切换 `leftCollapsed`

**右按钮**（切线偏右，右半窄）：
- 展开态：右半（窄）填充 `accent` → 表示右侧栏可见
- 收起态：右半（窄）低对比半透明 → 表示右侧栏已隐藏
- 点击：切换 `rightCollapsed`

### §1 细化 — 贴合 Catppuccin 主题

**按钮容器**（对齐 `titlebar-run-btn` / `run-play-btn`）：
- 尺寸 `26×26`，图标 `16×16` 居中
- `background: none`、`border: 1px solid transparent`、`border-radius: var(--aide-radius-sm)`
- hover：`background: color-mix(in srgb, var(--aide-accent) 12%, transparent)` + `border-color: color-mix(in srgb, var(--aide-accent) 30%, transparent)`，transition `0.12s`
- 不设 `data-tauri-drag-region`（按钮需可点，拖拽区让给标题栏其余区域）

**图标两半颜色**（全用主题 token）：

| 部位 | 展开态 | 收起态 |
|---|---|---|
| 窄半（侧栏） | `var(--aide-accent)` 实心 | `color-mix(in srgb, var(--aide-text-muted) 40%, transparent)` |
| 宽半（剩余） | `var(--aide-border)` 轮廓 + 内填透明 | 同左，不变 |
| 竖分隔线 | `var(--aide-border)` | `var(--aide-border)` |

- hover 时窄半提亮：展开态 → `var(--aide-accent-hover)`；收起态 → `var(--aide-text-muted)`（40% 透明 → 实心），给"可点亮"暗示。
- 收起态窄半保留半透明 muted 而非全空，维持方块结构感（VSCode 收起态亦保留轮廓变淡），暗色主题对比度合理。

**`v-tooltip`**：沿用现有指令。左按钮 `展开/收起左侧栏`、右按钮 `展开/收起右侧栏`（按 `collapsed` 切文案）。

### §2 组件接口与接线

**新建 `src/components/titlebar/SidebarToggle.vue`**：
- props：`side: 'left' | 'right'`、`collapsed: boolean`
- emits：`toggle: []`
- 纯展示+点击，无内部状态。`side` 决定切线偏左/偏右和窄半位置；`collapsed` 决定窄半填充。点击 emit `toggle`。
- SVG 内联模板（两半矩形 + 竖线 + 外框），fill 用 computed 绑定 `collapsed`。

**`TitleBar.vue`**：
- 新增 props：`leftCollapsed: boolean`、`rightCollapsed: boolean`
- 新增 emits：`toggle-left: []`、`toggle-right: []`
- 模板插入：
  - `.titlebar-left` 最前：`<SidebarToggle side="left" :collapsed="leftCollapsed" @toggle="$emit('toggle-left')" />`
  - `.titlebar-right` 活跃会话指示与 `WindowControls` 之间：`<SidebarToggle side="right" :collapsed="rightCollapsed" @toggle="$emit('toggle-right')" />`

**`App.vue`**：
- `TitleBar` 标签加：`:left-collapsed="leftCollapsed"`、`:right-collapsed="rightCollapsed"`、`@toggle-left="leftCollapsed = !leftCollapsed"`、`@toggle-right="rightCollapsed = !rightCollapsed"`
- `leftCollapsed` / `rightCollapsed` ref 保留不动，仍是 grid 轨道单一数据源，仅多一个标题栏入口。

**数据流**：
```
App.vue (leftCollapsed/rightCollapsed = 单一数据源)
  ├─→ gridTemplateColumns (grid 轨道宽度)
  └─→ TitleBar :left-collapsed / :right-collapsed
        └─→ SidebarToggle :collapsed
              ←─ @toggle ─→ TitleBar @toggle-left/right ─→ App 改 ref
```

### §3 移除旧按钮 + 边界情况

**移除**：
- 删 `App.vue` 模板两个 `<div class="collapse-toggle ...">`（左 539-545、右 583-589 行）
- 删对应 CSS（`.collapse-toggle` 全族 737-806 行）
- `v-tooltip` 文案迁移到新组件

**不动**：
- `gridTemplateColumns` computed：收起 `10px` / 展开 `var(--aide-left/right-w)`
- `.panel-left.collapsed` / `.panel-right.collapsed` class 保留——移除 CSS 后这两个 class 变纯标记，无 CSS 规则引用，无副作用
- `resize-handle` 的 `v-show="!leftCollapsed"`
- `SidebarLeft` 的 `v-show="!leftCollapsed"`

**无障碍/键盘**：新按钮用 `<button>` 元素，原生可聚焦、Enter/Space 触发 `toggle`（旧 `collapse-toggle` 是 div+@click 键盘不可达——顺手修掉）。

**FileViewer 浮层**：靠 `ResizeObserver` 量 `.panel-center` 包围盒重铺。收起由 grid 轨道真变驱动，行为与旧按钮一致，无需改 FileViewer。

## 测试要点

- 左/右按钮各点一次：侧栏收起/展开、grid 轨道真变、FileViewer 浮层重铺
- 收起态窄半低对比、展开态高亮
- hover 浅底 + 窄半提亮
- 键盘 Tab 到按钮、Enter/Space 触发 toggle
- 不干扰窗口控制按钮、搜索框、运行配置、活跃会话指示
- 跨平台：图标/布局纯 CSS+SVG，无平台特有逻辑

## 受影响文件

| 文件 | 改动 |
|---|---|
| `src/components/titlebar/SidebarToggle.vue` | 新建 |
| `src/components/titlebar/TitleBar.vue` | 加 props/emits + 插入两个按钮 |
| `src/App.vue` | 接线 + 移除旧 collapse-toggle 及其 CSS |
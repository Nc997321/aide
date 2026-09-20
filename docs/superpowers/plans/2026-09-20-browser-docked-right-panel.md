# 内嵌浏览器改停靠右栏 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把内嵌浏览器从「与聊天互斥的主区一级视图」改成「右栏里的单例 tab」（可与聊天同屏、可最大化铺满），并让截图工具在视图隐藏时立即如实失败。

**Architecture:** 新建 `useRightPanel` 模块单例作为"右栏显示什么"的唯一主人（折叠/当前 tab/最大化/两档宽度）；`useResizable` 从"持有宽度与上下限"降级为"把宽度绑到 DOM"（三个输入，档位知识由注入的 `WidthSource` 提供）；浏览器面板搬进 `.panel-right-inner` 与其它工具 tab 并列；最大化 = 右栏吃满主区（改一行 grid 模板），**不搬 DOM**。

**Tech Stack:** Vue 3 + TypeScript（前端）、vitest + jsdom（前端测试）、Node sidecar（TS，截图工具）、Rust（只改一处超时文案）。

**Spec:** `docs/superpowers/specs/2026-09-20-browser-docked-right-panel-design.md`

## 与 spec 的一处偏离（先读）

spec §1 末条写"`useBrowserPanel` 收缩为只提供 `everOpened`"。本计划**把它整个删除**，`everOpened` 并入 `useRightPanel.browserEverActive`（Task 1 / Task 5）。理由：否则 App 要同时 watch 两个 store 才能驱动懒挂载——那正是 spec 要消灭的"两份面板开合状态"。其余照 spec 执行。

## Global Constraints

- **不改隐藏策略**：`Bounds::hidden()`、WebView2 反节流参数、`TrySuspendAsync` 一律不碰（spec 非目标）。
- **不动** `PaneLayout`、聊天渲染、`TabItem` 联合类型（09-15 换形态的收益必须保持）。
- **宽度不落盘**：两档宽度只存内存，跨重启按窗口重算。
- **单函数输入 ≤4**（用户级约定）：`useResizable` 因此从 5 个字段降到 3 个。
- **注释中文**、解释"为什么"不解释"是什么"；提交用 conventional 中文 subject + body + `Co-Authored-By: Claude Code <noreply@anthropic.com>` 尾行。
- **每个任务收尾跑门禁**（全仓，不许只跑改动文件）：
  - `npx vue-tsc --noEmit`
  - `npx vitest run`（全仓；单文件调试用 `npx vitest run <path>`）
  - `pnpm check:sync-io` / `pnpm check:overlay-layers` / `pnpm check:tauri-imports`
  - Rust 改动时：`cd src-tauri && cargo test --lib`

---

## Task 1: `useRightPanel` 单例（纯状态）

**Files:**
- Create: `src/composables/useRightPanel.ts`
- Test: `src/composables/useRightPanel.test.ts`

**Interfaces:**
- Produces: `RightTabId` 联合类型；`useRightPanel()` 返回 `{ collapsed, tab, wantMaximized, maximized, browserActive, browserEverActive, select, setMaximized }`；`__resetRightPanelForTest()`。
  - `collapsed: Ref<boolean>`、`tab: Ref<RightTabId>`、`wantMaximized: Ref<boolean>`
  - `maximized: ComputedRef<boolean>`（= `wantMaximized && browserActive`）
  - `browserActive: ComputedRef<boolean>`（= `tab === "browser" && !collapsed`）
  - `browserEverActive: Ref<boolean>`（懒挂载标记）
  - `select(id: RightTabId): void`、`setMaximized(on: boolean): void`
- Consumes: 无（本任务是叶子）。

- [ ] **Step 1: 写失败的测试**

`src/composables/useRightPanel.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useRightPanel, __resetRightPanelForTest } from "./useRightPanel";

// 模块级单例（与 usePaneLayout 同范式）：用例间共享状态，故每个用例前复位。
beforeEach(() => __resetRightPanelForTest());

describe("select 的三态裁决（沿用旧 onRailSelect）", () => {
  it("折叠态点任意项 → 展开并激活", () => {
    const p = useRightPanel();
    p.select("git");
    expect(p.tab.value).toBe("git");
    expect(p.collapsed.value).toBe(false);
  });

  it("点已激活项 → 折叠（不切走）", () => {
    const p = useRightPanel();
    p.select("git");
    p.select("git");
    expect(p.collapsed.value).toBe(true);
    expect(p.tab.value).toBe("git");
  });

  it("点未激活项 → 切过去，不折叠", () => {
    const p = useRightPanel();
    p.select("git");
    p.select("search");
    expect(p.tab.value).toBe("search");
    expect(p.collapsed.value).toBe(false);
  });
});

describe("browserActive / maximized 都是派生值", () => {
  it("选中浏览器且展开 → browserActive 为真", () => {
    const p = useRightPanel();
    p.select("browser");
    expect(p.browserActive.value).toBe(true);
  });

  it("折叠或切走 → browserActive 为假", () => {
    const p = useRightPanel();
    p.select("browser");
    p.select("git");
    expect(p.browserActive.value).toBe(false);
  });

  it("最大化意图在切走时不成立、切回来自动恢复（不做额外清理）", () => {
    const p = useRightPanel();
    p.select("browser");
    p.setMaximized(true);
    expect(p.maximized.value).toBe(true);

    p.select("git"); // 切走
    expect(p.maximized.value).toBe(false);
    expect(p.wantMaximized.value).toBe(true); // 意图还在

    p.select("browser"); // 切回来
    expect(p.maximized.value).toBe(true);
  });

  it("折叠浏览器 tab 时最大化立刻失效", () => {
    const p = useRightPanel();
    p.select("browser");
    p.setMaximized(true);
    p.select("browser"); // 再点一次 = 折叠
    expect(p.maximized.value).toBe(false);
  });
});

describe("懒挂载", () => {
  it("首次 select('browser') 置 browserEverActive，之后折叠仍为真", () => {
    const p = useRightPanel();
    expect(p.browserEverActive.value).toBe(false);
    p.select("browser");
    expect(p.browserEverActive.value).toBe(true);
    p.select("browser"); // 折叠
    expect(p.browserEverActive.value).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: FAIL —— `Failed to resolve import "./useRightPanel"`。

- [ ] **Step 3: 实现**

`src/composables/useRightPanel.ts`：

```ts
// 右侧栏「显示什么」的单一主人（模块级单例，与 usePaneLayout / useWorkspaces 同范式）。
//
// 为什么要有这个模块：内嵌浏览器从「主区一级视图」搬进右栏后，**"面板开没开"只准有一个主人**。
// 历史上 rightTab / rightCollapsed 住在 App.vue、浏览器开合住在 useBrowserPanel——两半各说各话，
// "面板关了视图还在""切了 tab 视图不跟着走"这类幽灵故障都源自这种分裂。
//
// 本模块只认状态与裁决，不认 DOM（宽度绑定见 useResizable + rightPanelWidthSource）。
import { computed, ref } from "vue";

/** 右栏 tab id。加一个 tab = 这里加一个字面量 + App.vue 的 rightTabs / RAIL_DIGIT_TABS 各加一行。 */
export type RightTabId =
  | "files"
  | "changes"
  | "git"
  | "search"
  | "codegraph"
  | "callhierarchy"
  | "permissions"
  | "browser";

/** 默认收起（只留竖直 rail），沿用旧 rightCollapsed 的初值。 */
const collapsed = ref(true);
const tab = ref<RightTabId>("files");

/** 最大化**意图**；能不能成立由 `maximized` 派生裁决（见下）。 */
const wantMaximized = ref(false);

/** 浏览器组件首次激活才挂（异步 chunk 不在启动时拉），挂上后常驻——保活语义。 */
const browserEverActive = ref(false);

/** 浏览器视图此刻该不该露头：视图可见性总闸的一半（另一半是 App 的 overlayLayerOpen）。 */
const browserActive = computed(() => tab.value === "browser" && !collapsed.value);

/**
 * 最大化 = 右栏铺满、聊天让位。**派生而非独立状态**：折叠或切走立刻为假，
 * 不需要"谁负责在切 tab 时把它清掉"这种约定（幽灵状态的温床）。
 * 意图是记住的——切回浏览器 tab 会自动恢复最大化，这是有意的。
 */
const maximized = computed(() => wantMaximized.value && browserActive.value);

/** rail / 快捷键的统一裁决（逐字沿用 App.vue 旧 onRailSelect 的三态语义）。 */
function select(id: RightTabId) {
  // 懒挂载：第一次点就挂，之后常驻（关面板只 setVisible(false)，页面与历史都留着）。
  if (id === "browser") browserEverActive.value = true;
  if (collapsed.value) {
    tab.value = id;
    collapsed.value = false;
  } else if (id === tab.value) {
    collapsed.value = true;
  } else {
    tab.value = id;
  }
}

function setMaximized(on: boolean) {
  wantMaximized.value = on;
}

export function useRightPanel() {
  return {
    collapsed,
    tab,
    wantMaximized,
    maximized,
    browserActive,
    browserEverActive,
    select,
    setMaximized,
  };
}

/** 仅供测试复位模块单例（同 `__resetPaneLayoutForTest` 范式）。 */
export function __resetRightPanelForTest() {
  collapsed.value = true;
  tab.value = "files";
  wantMaximized.value = false;
  browserEverActive.value = false;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: PASS（9 条）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useRightPanel.ts src/composables/useRightPanel.test.ts
git commit -m "feat(browser): 右栏状态单例 useRightPanel——开合/最大化/懒挂载一处裁决

浏览器搬进右栏前先把状态收成一个主人：旧代码里 rightTab+rightCollapsed 住在
App.vue、浏览器开合住在 useBrowserPanel，两半各说各话。

最大化用派生值（wantMaximized && browserActive）而不是独立 ref：折叠/切走自动失效，
不需要"切 tab 时记得清掉"这种约定；意图保留，切回浏览器 tab 自动恢复。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 2: `useResizable` 档案化（3 个输入）

**Files:**
- Modify: `src/composables/useResizable.ts`（整文件重写，43 行 → 约 110 行）
- Test: `src/composables/useResizable.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface WidthSource { active(): string; limits(name: string): { initial: number | (() => number); min: number; max: number | (() => number) }; get(name: string): number; set(name: string, px: number): void }`
  - `staticWidthSource(limits: { initial: number; min: number; max: number }): WidthSource`
  - `useResizable(options: { cssVar: string; direction: "left" | "right"; source: WidthSource }): { onMousedown(e: MouseEvent): void; isDragging: Ref<boolean>; apply(): void }`
- Consumes: 无。
- **破坏性**：旧的 `{ cssVar, initial, min, max, direction }` 形态与 `size` 返回值**删除**（`size` 无消费者，`App.vue` 只用 `isDragging` / `onMousedown`）。Task 3 会同步改 App.vue 的两个调用点。

- [ ] **Step 1: 写失败的测试**

`src/composables/useResizable.test.ts`：

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { nextTick, ref } from "vue";
import { useResizable, staticWidthSource, type WidthSource } from "./useResizable";

const VAR = "--t-w";

function cssVar(): string {
  return document.documentElement.style.getPropertyValue(VAR);
}

/** 可切档的桩 source：`active` 读一个 ref，切档 = 改 ref。 */
function twoProfileSource() {
  const active = ref("narrow");
  const store: Record<string, number> = { narrow: 0, browser: 0 };
  const source: WidthSource = {
    active: () => active.value,
    limits: (name) =>
      name === "browser"
        ? { initial: () => 800, min: 420, max: () => 1000 }
        : { initial: 340, min: 300, max: 540 },
    get: (name) => store[name] ?? 0,
    set: (name, px) => {
      store[name] = px;
    },
  };
  return { source, active, store };
}

function drag(from: number, to: number) {
  document.dispatchEvent(new MouseEvent("mouseup", { clientX: to })); // 清掉可能残留的上一次拖动
  return { start: from, move: to };
}

beforeEach(() => {
  document.documentElement.style.removeProperty(VAR);
});

describe("useResizable · 落值", () => {
  it("挂上就把当前档的初始值写进 CSS 变量", () => {
    const { source } = twoProfileSource();
    useResizable({ cssVar: VAR, direction: "right", source });
    expect(cssVar()).toBe("340px");
  });

  it("切档 → 写新档的值（切档靠 source.active 的响应式读触发）", async () => {
    const { source, active } = twoProfileSource();
    useResizable({ cssVar: VAR, direction: "right", source });
    active.value = "browser";
    await nextTick();
    expect(cssVar()).toBe("800px");
  });

  it("已记的值优先于 initial", async () => {
    const { source, active, store } = twoProfileSource();
    store.browser = 640;
    useResizable({ cssVar: VAR, direction: "right", source });
    active.value = "browser";
    await nextTick();
    expect(cssVar()).toBe("640px");
  });
});

describe("useResizable · 拖动", () => {
  it("direction=right：向左拖变大，并把值写回 source", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    expect(cssVar()).toBe("440px"); // 340 + 100
    expect(store.narrow).toBe(440);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
  });

  it("direction=left：向右拖变大", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "left", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 360 }));
    expect(store.narrow).toBe(400);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 360 }));
  });

  it("clamp 到上下限", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 0 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -5000 }));
    expect(store.narrow).toBe(540); // 上限
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 5000 }));
    expect(store.narrow).toBe(300); // 下限
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 5000 }));
  });

  it("max < min（窗口过窄）时按 min 收", () => {
    const store = { narrow: 0 };
    const source: WidthSource = {
      active: () => "narrow",
      limits: () => ({ initial: 340, min: 420, max: () => 300 }),
      get: () => store.narrow,
      set: (_n, px) => {
        store.narrow = px;
      },
    };
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    expect(cssVar()).toBe("420px");
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
    expect(store.narrow).toBe(420);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 100 }));
  });

  it("mouseup 之后不再改值", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
    expect(store.narrow).toBe(0);
    expect(r.isDragging.value).toBe(false);
  });
});

describe("staticWidthSource（单档，给左侧栏用）", () => {
  it("自带记忆：拖动写回、再次挂载用记忆值", async () => {
    const src = staticWidthSource({ initial: 280, min: 220, max: 450 });
    const r = useResizable({ cssVar: VAR, direction: "left", source: src });
    expect(cssVar()).toBe("280px");
    r.onMousedown(new MouseEvent("mousedown", { clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
    expect(src.get("default")).toBe(380);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useResizable.test.ts`
Expected: FAIL —— `staticWidthSource is not a function` / `useResizable` 读 `options.source` 为 undefined。

- [ ] **Step 3: 实现**

`src/composables/useResizable.ts`（整文件替换）：

```ts
// 面板宽度的**DOM 绑定**：读当前档的宽度 → 写 CSS 变量；拖动 → clamp 后写回。
//
// 为什么宽度真相不在这里：同一个右栏有两档宽度（窄工具 tab 340 / 浏览器宽档 ≈窗口一半），
// 值要跨 tab 往返记住、还要随窗口 resize 收敛——那是**面板状态**，主人是 useRightPanel。
// 本模块因此只认三个输入（cssVar / direction / source），档位与上下限由 source 提供。
import { getCurrentScope, onScopeDispose, ref, watchEffect } from "vue";

/** 某档的宽度规则。`initial` / `max` 允许是函数：宽档要看当前窗口宽度现算。 */
export interface WidthLimits {
  initial: number | (() => number);
  min: number;
  max: number | (() => number);
}

/** 宽度来源：档位名、各档边界、已记的值。实现方是面板状态的主人。 */
export interface WidthSource {
  /** 当前生效的档位名（**响应式读取**——切档时本模块的 watchEffect 会自动重跑）。 */
  active(): string;
  limits(name: string): WidthLimits;
  /** 某档已记的宽度；0 = 没记过，用 initial。 */
  get(name: string): number;
  /** 写回某档宽度（拖动过程中每次移动都写，切档往返才不会丢）。 */
  set(name: string, px: number): void;
}

/** 单档宽度源：给没有档位需求的地方（如左侧栏）用，内部自带一个 ref 记值。 */
export function staticWidthSource(limits: { initial: number; min: number; max: number }): WidthSource {
  const px = ref(0);
  return {
    active: () => "default",
    limits: () => limits,
    get: () => px.value,
    set: (_name, value) => {
      px.value = value;
    },
  };
}

export interface ResizableOptions {
  cssVar: string;
  direction: "left" | "right";
  source: WidthSource;
}

export function useResizable(options: ResizableOptions) {
  const isDragging = ref(false);

  /** 该档的实际边界：max < min（窗口过窄）时按 min 收——宁可压破聊天底线，也不把面板压到不可用。 */
  function boundsOf(name: string): { min: number; max: number } {
    const limits = options.source.limits(name);
    const max = typeof limits.max === "function" ? limits.max() : limits.max;
    return { min: limits.min, max: Math.max(limits.min, max) };
  }

  function currentPx(name: string): number {
    const limits = options.source.limits(name);
    const remembered = options.source.get(name);
    const raw =
      remembered > 0 ? remembered : typeof limits.initial === "function" ? limits.initial() : limits.initial;
    const { min, max } = boundsOf(name);
    return Math.max(min, Math.min(max, raw));
  }

  /** 把当前档的宽度落到 CSS 变量。档位变化 / 窗口 resize 时重跑。 */
  function apply() {
    const name = options.source.active();
    document.documentElement.style.setProperty(options.cssVar, `${currentPx(name)}px`);
  }

  function onMousedown(e: MouseEvent) {
    isDragging.value = true;
    const startX = e.clientX;
    const name = options.source.active();
    const startSize = currentPx(name);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const raw = options.direction === "left" ? startSize + delta : startSize - delta;
      const { min, max } = boundsOf(name);
      const px = Math.max(min, Math.min(max, raw));
      document.documentElement.style.setProperty(options.cssVar, `${px}px`);
      options.source.set(name, px);
    };

    const onUp = () => {
      isDragging.value = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // 档位变化（切 tab / 折叠 / 最大化）→ 重新落值；动态上限（宽档看窗口宽度）→ resize 时重新收敛。
  watchEffect(apply);
  window.addEventListener("resize", apply);
  // 组件卸载时摘掉 listen；非组件上下文（单测直调）没有 scope，跳过而不是报警告。
  if (getCurrentScope()) onScopeDispose(() => window.removeEventListener("resize", apply));

  return { onMousedown, isDragging, apply };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/useResizable.test.ts`
Expected: PASS（8 条）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useResizable.ts src/composables/useResizable.test.ts
git commit -m "refactor(panel): useResizable 降级为 DOM 绑定，宽度真相交给面板状态

原形态一次吃 5 个输入（cssVar/initial/min/max/direction）且自己持有宽度真相，
撑不住"同一个右栏两档宽度、切档往返要记住、上限随窗口变"这三件事。

改成三输入（cssVar / direction / source）：档位名、边界、已记的值都由注入的
WidthSource 提供，本模块只做"读当前档 → 写 CSS 变量；拖动 → clamp 后写回"。
max < min 时按 min 收（窗口过窄时聊天底线让位给面板可用性）。

顺带删掉 size 返回值——全仓无消费者。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 3: App.vue 重接线（挂载 + 入口 + 布局 + 互斥）

**Files:**
- Modify: `src/App.vue`（9 处，见下）
- Modify: `src/components/Browser/BrowserPanel.vue:27,44,156,455`
- Modify: `src/components/SidebarNavGroup.vue:15,32,118-135`

**Interfaces:**
- Consumes: Task 1 的 `useRightPanel` / `RightTabId`。
- Produces: 右栏 tab `"browser"`；`rightTab` / `rightCollapsed` 两个 App 内别名（模板与既有函数不用改）；`.panel-right-inner` 里的浏览器挂载点。
- **注意**：本任务**不改**宽度（`useResizable` 调用点先临时留旧签名会编译不过——所以本任务里两个调用点先改成 `staticWidthSource` 单档，Task 4 再把右栏换成双档）。

- [ ] **Step 1: 状态接入（`App.vue`）**

删掉 `App.vue:23` 的 `import { useBrowserPanel }`，换成：

```ts
import { useRightPanel, type RightTabId } from "./composables/useRightPanel";
```

删掉 `App.vue:75-76`：
```ts
const rightCollapsed = ref(true);
const rightTab = ref<"files" | "changes" | ...>("files");
```
换成：
```ts
// 右栏状态的主人是 useRightPanel（模块单例）。这两个别名只为少改模板与既有函数——
// 它们就是 store 里的 ref 本身，写别名 = 写 store。
const rightPanel = useRightPanel();
const rightCollapsed = rightPanel.collapsed;
const rightTab = rightPanel.tab;
```

删掉 `App.vue:178` 那一行 `const browserPanel = useBrowserPanel();`（连同上面那行注释里"侧栏入口同一开关"的说法一起改）：

```ts
// 内嵌浏览器面板：主区已不认它——它是右栏的一个 tab（Ctrl+8 / Ctrl+Shift+B / rail 图标）。
```

`App.vue:100-105` 的 `rightResize` 先临时降到单档（Task 4 换双档）：

```ts
const rightResize = useResizable({
  cssVar: "--aide-right-w",
  direction: "right",
  source: staticWidthSource({ initial: 340, min: 300, max: 540 }),
});
```

`App.vue:94-99` 的 `leftResize` 同步换新签名：

```ts
const leftResize = useResizable({
  cssVar: "--aide-left-w",
  direction: "left",
  source: staticWidthSource({ initial: 280, min: 220, max: 450 }),
});
```

并在 import 里加 `staticWidthSource`：
```ts
import { useResizable, staticWidthSource } from "./composables/useResizable";
```

- [ ] **Step 2: rail 第 8 个 tab + 快捷键**

`App.vue:309-311` 一带的图标常量后追加（字形抄 `SidebarNavGroup.vue:126-131` 的地球，同一字形语言）：

```ts
const tabIconBrowser = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M12 3a9 9 0 0 0 0 18"/></svg>';
```

`rightTabs`（`App.vue:317-325`）末尾（`permissions` 之前）插入：

```ts
  { id: "browser", icon: tabIconBrowser, label: "浏览器 (Ctrl+8)" },
```

`RAIL_DIGIT_TABS`（`App.vue:344-352`）类型与内容一起改：

```ts
const RAIL_DIGIT_TABS: Record<string, RightTabId> = {
  Digit1: "files",
  Digit2: "changes",
  Digit3: "git",
  Digit4: "search",
  Digit5: "permissions",
  Digit6: "codegraph",
  Digit7: "callhierarchy",
  Digit8: "browser",
};
```

`onRailSelect`（`App.vue:330-341`）改成一行转交：

```ts
/** 右侧竖直工具栏选择（IDEA 式）：三态裁决（展开/折叠/切换）住在 useRightPanel.select。 */
function onRailSelect(id: string) {
  rightPanel.select(id as RightTabId);
}
```

`Ctrl+Shift+B`（`App.vue:672-678`）：

```ts
  // Ctrl+Shift+B：内嵌浏览器（右栏 tab；已激活则折叠）
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyB" || e.key === "B")) {
    e.preventDefault();
    e.stopPropagation();
    rightPanel.select("browser");
    return;
  }
```

- [ ] **Step 3: 布局（grid 分支、中心 v-show、挂载搬家）**

`gridTemplateColumns`（`App.vue:114-124`）改成分支：

```ts
/** 最大化 = 右栏吃满主区：中心轨道归 0、右栏拿 1fr。聊天区已被 v-show 换下（保活不卸载），
 *  所以这里不需要动 DOM 结构——原生视图的"洞"只是换了个更大的 rect。 */
const browserMaximized = rightPanel.maximized;

const gridTemplateColumns = computed(() => {
  const left = !leftPinned.value ? "0px" : leftCollapsed.value ? "10px" : "var(--aide-left-w, 280px)";
  if (browserMaximized.value) return `${left} 1px 0px 1px 1fr`;
  const right = rightCollapsed.value ? "var(--aide-rail-w, 40px)" : "var(--aide-right-w, 300px)";
  return `${left} 1px minmax(400px, 1fr) 1px ${right}`;
});
```

中心区 v-show（`App.vue:1037`）：把 `&& !browserPanel.panelOpen.value` 改成 `&& !browserMaximized`。

> ⚠️ **`.value` 别顺手带上**：`browserMaximized` 是 `<script setup>` 的顶层 ref，模板里
> 自动解包——写 `browserMaximized.value` 会取到 `undefined.value`（模板对**成员表达式**
> 比如 `rightPanel.browserEverActive.value` 才需要 `.value`，因为那是普通对象的属性）。

删掉中心区的浏览器挂载块（`App.vue:1029-1034`，即那段 `<!-- 内嵌浏览器：**v-if + v-show 而非 v-else-if 链** ... -->` + `<BrowserPanel ... />`）。

在 `.panel-right-inner` 的 `.tab-content` 里（`App.vue:1079-1084`，`PermissionsPanel` 之后）加：

```vue
            <!-- 内嵌浏览器：与其它工具 tab 并列的单例槽位。首次激活才挂（异步 chunk），
                 挂上后常驻——关面板只 setVisible(false)，页面与前进后退历史都留着。 -->
            <BrowserPanel
              v-if="rightPanel.browserEverActive.value"
              v-show="rightTab === 'browser'"
            />
```

- [ ] **Step 4: 互斥与生命周期**

`closeOtherPanels`（`App.vue:382-387`）：删掉 `if (except !== "browser") browserPanel.closePanel();` 那一行。

删掉 `App.vue:391` 的 `watch(browserPanel.panelOpen, ...)`。

在 `watch(() => automation.state.view, ...)`（`App.vue:392`）之后加：

```ts
// 最大化 = 右栏吃满主区，与其它主区面板互斥：
// 开最大化先关掉它们；它们被打开则退最大化。**只在有面板真的开着时才退**——
// 否则 closeOtherPanels 关掉它们的瞬间会反过来把刚开的最大化取消掉。
watch(browserMaximized, (on) => {
  if (on) closeOtherPanels("browser");
});
watch(
  [marketplace.panelOpen, observatory.panelOpen, knowledgeBase.panelOpen, () => automation.state.view],
  ([mk, ob, kb, auto]) => {
    if (mk || ob || kb || auto !== null) rightPanel.setMaximized(false);
  },
);
```

`onSessionChanged`（`App.vue:394-404`）：删掉 `browserPanel.closePanel();`，并把注释订正为：

```ts
function onSessionChanged(id: string) {
  // 选中会话时关掉自动化/插件市场/记忆观测台，主区切回聊天。
  // （知识库不关：它跟会话/工作区/配对都无关。浏览器也不关：它是右栏 tab，
  //   2026-09-20 起不再占主区——正是"切会话就把浏览器踢掉"这条把 agent 截图逼进了死角。）
  automation.closePanel();
  marketplace.closePanel();
  observatory.closePanel();
```

- [ ] **Step 5: BrowserPanel 与左栏入口**

`src/components/Browser/BrowserPanel.vue:44`：
```ts
import { useRightPanel } from "../../composables/useRightPanel";
// ...
const { browserActive, select } = useRightPanel();
```
`:156`：
```ts
const viewAllowed = computed(() => browserActive.value && !overlayLayerOpen.value);
```
`:455` 的关闭按钮：
```vue
        @click="select('browser')"
```
（点已激活的 tab = 折叠，与 rail 同语义；视图 `setVisible(false)` 保活不变。）

`src/components/SidebarNavGroup.vue`：删掉 `:15` 的 import、`:32` 的解构，以及模板里那整段浏览器行（`:118-135`，`<div class="nav-row" :class="{ on: browserOpen }" ...>` 到 `</div>`，含地球 svg 与"浏览器"标签）。

- [ ] **Step 6: 编译 + 全量测试**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（0 错）。

Run: `npx vitest run`
Expected: 除 `BrowserPanel.test.ts`（Task 5 处理，此刻会因找不到 `useBrowserPanel` 的开合入口而失败）外全绿。把该文件的当前失败记下来，Task 5 修。

Run: `pnpm check:overlay-layers && pnpm check:tauri-imports && pnpm check:sync-io`
Expected: 三条全过。

- [ ] **Step 7: 手动冒烟（dev）**

Run: `pnpm dev`（**记忆：sidecar 跑 dist，改了 src 必须 build + 重启**；本次未改 sidecar，无需 build）
检查：`Ctrl+8` / `Ctrl+Shift+B` / rail 图标三者都能开右栏浏览器 tab；聊天仍在左；拖右栏宽度把手上限仍是 540（Task 4 才放开到宽档）；点已激活图标折叠。

- [ ] **Step 8: 提交**

```bash
git add src/App.vue src/components/Browser/BrowserPanel.vue src/components/SidebarNavGroup.vue
git commit -m "feat(browser): 内嵌浏览器搬进右栏 tab——与聊天同屏，切会话不再踢它

浏览器原本是主区一级视图，与聊天在同一个 v-show 条件上互斥：用户看着聊天时视图必然
隐藏，而隐藏的 WebView2 不合成帧，agent 截图因此永远等不到帧（10s 超时）。

改动：
- 挂载点从 .panel-center 搬到 .panel-right-inner 的 tab-content，与文件/变更/Git 并列；
  首次激活才挂（异步 chunk），挂上常驻。
- 浏览器退出三处主区逻辑：closeOtherPanels、中心 v-show 条件、onSessionChanged。
- 新增最大化：右栏吃满主区（grid 中心轨道归 0、右栏 1fr），聊天 v-show 让位不卸载；
  与其它主区面板互斥，且只在真有面板打开时才退最大化（否则会被 closeOtherPanels 反噬）。
- 入口：rail 第 8 个 tab + Ctrl+8 + Ctrl+Shift+B；左栏那行入口删除。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 4: 右栏宽度双档（工具窄档 / 浏览器宽档）

**Files:**
- Modify: `src/composables/useRightPanel.ts`（加 `widths` / `widthProfile` / `rightPanelWidthSource`）
- Modify: `src/composables/useRightPanel.test.ts`（加宽度档测试）
- Modify: `src/App.vue`（`rightResize` 换双档 + `measureLayout`）

**Interfaces:**
- Consumes: Task 2 的 `WidthSource` / `staticWidthSource`；Task 1 的 store。
- Produces: `rightPanelWidthSource(measure: () => { appW: number; leftW: number }): WidthSource`；store 新增 `widths: Ref<{ narrow: number; browser: number }>` 与 `widthProfile: ComputedRef<"narrow" | "browser">`。

- [ ] **Step 1: 写失败的测试**

追加到 `src/composables/useRightPanel.test.ts`：

```ts
describe("宽度档位", () => {
  it("浏览器停靠态用宽档；最大化 / 折叠 / 其它 tab 用窄档", () => {
    const p = useRightPanel();
    expect(p.widthProfile.value).toBe("narrow");
    p.select("browser");
    expect(p.widthProfile.value).toBe("browser");
    p.setMaximized(true);
    expect(p.widthProfile.value).toBe("narrow"); // 最大化吃满，宽度不再参与
  });

  it("值存在 store 里（切档往返不丢）", () => {
    const p = useRightPanel();
    p.setWidth("browser", 720);
    expect(p.widths.value.browser).toBe(720);
  });
});

describe("rightPanelWidthSource", () => {
  const measure = () => ({ appW: 1600, leftW: 280 });

  it("active 跟随 store 的档位", () => {
    const p = useRightPanel();
    const src = rightPanelWidthSource(measure);
    expect(src.active()).toBe("narrow");
    p.select("browser");
    expect(src.active()).toBe("browser");
  });

  it("宽档：初值 = 窗口一半，上限给聊天留 400px", () => {
    const src = rightPanelWidthSource(measure);
    const limits = src.limits("browser");
    expect((limits.initial as () => number)()).toBe(800);
    expect(limits.min).toBe(420);
    expect((limits.max as () => number)()).toBe(1600 - 280 - 400 - 2); // 918
  });

  it("窄档与旧行为一致（340 / 300..540）", () => {
    const src = rightPanelWidthSource(measure);
    const limits = src.limits("narrow");
    expect(limits.initial).toBe(340);
    expect(limits.min).toBe(300);
    expect(limits.max).toBe(540);
  });

  it("窗口过窄 → max < min（由 useResizable 按 min 收）", () => {
    const src = rightPanelWidthSource(() => ({ appW: 900, leftW: 280 }));
    const limits = src.limits("browser");
    expect((limits.max as () => number)()).toBeLessThan(limits.min);
  });

  it("读到的已记宽度能写回（store 是唯一主人）", () => {
    const p = useRightPanel();
    const src = rightPanelWidthSource(measure);
    src.set("browser", 700);
    expect(src.get("browser")).toBe(700);
    expect(p.widths.value.browser).toBe(700);
  });
});
```

同时把该文件顶部 import 改成：
```ts
import { useRightPanel, rightPanelWidthSource, __resetRightPanelForTest } from "./useRightPanel";
```
并在 `__resetRightPanelForTest` 里加 `widths.value = { narrow: 0, browser: 0 };`（Task 4 Step 3 同步改实现）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: FAIL —— `rightPanelWidthSource is not a function`。

- [ ] **Step 3: 实现**

在 `src/composables/useRightPanel.ts` 里追加（`import` 行补上 `import type { WidthSource } from "./useResizable";`）：

```ts
/** 中心轨道 minmax(400px,1fr) 的保底：**聊天底线优先于"五五开"**。 */
const MIN_CHAT_PX = 400;
/** 两块面板之间的两条 1px 分隔线轨道。 */
const GUTTER_PX = 2;

/** 两档宽度（内存，0 = 没记过）：窄档给 7 个工具 tab，宽档给浏览器。不落盘（用户 2026-09-20 定）。 */
const widths = ref<{ narrow: number; browser: number }>({ narrow: 0, browser: 0 });

/** 拖动把手此刻用哪一档：浏览器停靠态用宽档，其余（含最大化，此时宽度不参与布局）用窄档。 */
const widthProfile = computed<"narrow" | "browser">(() =>
  browserActive.value && !maximized.value ? "browser" : "narrow",
);

/** 布局量测：App 注入（只有它知道 DOM）。量不到给 0 → 一律按 min 收，宁可容错不猜。 */
export type LayoutMeasure = () => { appW: number; leftW: number };

/** 右栏宽度源：档位选择 + 边界都在这里，`useResizable` 只拿它去绑 DOM。 */
export function rightPanelWidthSource(measure: LayoutMeasure): WidthSource {
  return {
    active: () => widthProfile.value,
    limits: (name) =>
      name === "browser"
        ? {
            initial: () => Math.round(measure().appW * 0.5),
            min: 420,
            max: () => measure().appW - measure().leftW - MIN_CHAT_PX - GUTTER_PX,
          }
        : { initial: 340, min: 300, max: 540 },
    get: (name) => (name === "browser" ? widths.value.browser : widths.value.narrow),
    set: (name, px) => {
      if (name === "browser") widths.value.browser = px;
      else widths.value.narrow = px;
    },
  };
}

function setWidth(name: "narrow" | "browser", px: number) {
  widths.value[name] = px;
}
```

`useRightPanel()` 的返回里加 `widths, widthProfile, setWidth`；`browserActive`/`maximized` 的声明顺序保持不变（`widthProfile` 依赖它们）。`__resetRightPanelForTest` 里补 `widths.value = { narrow: 0, browser: 0 };`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: PASS（全部）。

- [ ] **Step 5: App.vue 接双档**

`App.vue` 的 `rightResize` 换成：

```ts
/** 右栏宽档的边界要看窗口：量 .app-layout 与**非 overlay 态**的左侧栏真实宽度
 *  （overlay 态侧栏脱离 grid 不吃轨道，不能算进去）。 */
function measureLayout() {
  const layout = document.querySelector<HTMLElement>(".app-layout");
  const left = document.querySelector<HTMLElement>(".panel-left:not(.overlay)");
  return {
    appW: layout?.getBoundingClientRect().width ?? 0,
    leftW: left?.getBoundingClientRect().width ?? 0,
  };
}

const rightResize = useResizable({
  cssVar: "--aide-right-w",
  direction: "right",
  source: rightPanelWidthSource(measureLayout),
});
```

import 里加 `rightPanelWidthSource`。

- [ ] **Step 6: 门禁**

Run: `npx vue-tsc --noEmit && npx vitest run`
Expected: 前端全绿（`BrowserPanel.test.ts` 若未在 Task 5 修复则仍红——见 Task 5）。

- [ ] **Step 7: 手动冒烟（dev）**

切到「文件」tab → 宽度 340 上下、拖到 540 到顶；切到浏览器 tab → 自动变约窗口一半；拖宽/拖窄；切回「文件」→ 宽度回到那一档自己的值；`Ctrl+8` 折叠再展开 → 宽度仍记着；窗口拉窄到极限 → 浏览器不低于 420、聊天被压破 400 底线（可接受，见 spec 降级表）。

- [ ] **Step 8: 提交**

```bash
git add src/composables/useRightPanel.ts src/composables/useRightPanel.test.ts src/App.vue
git commit -m "feat(browser): 右栏宽度分两档——工具 tab 窄档原样，浏览器宽档约窗口一半

右栏旧上限 540px 装不下浏览器，而工具 tab 又不需要那么宽：宽度按 tab 分档，
浏览器停靠态用宽档（初值 = 窗口一半，上限给聊天留 400px 底线），其余一律窄档。
两档的值存 useRightPanel（切档往返记住），不落盘；窗口 resize 时动态上限重新收敛。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 5: 清理 `useBrowserPanel` + 修 BrowserPanel 回归测试

**Files:**
- Delete: `src/composables/useBrowserPanel.ts`、`src/composables/useBrowserPanel.test.ts`
- Modify: `src/components/Browser/BrowserPanel.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `useRightPanel` / `__resetRightPanelForTest`。
- Produces: 无新接口（纯清理）。

- [ ] **Step 1: 改测试用新入口**

`BrowserPanel.test.ts`：
- import：`import { useBrowserPanel } from "../../composables/useBrowserPanel";` → `import { useRightPanel, __resetRightPanelForTest } from "../../composables/useRightPanel";`
- `beforeEach` 末尾：`useBrowserPanel().openPanel();` → `__resetRightPanelForTest(); useRightPanel().select("browser");`
- `afterEach` 末尾：`useBrowserPanel().closePanel();` → `__resetRightPanelForTest();`
- 用例「浮层开着时面板被关掉 → 再开面板不许把原生视图露出来」里两行：
  ```ts
  useBrowserPanel().closePanel(); // 浮层还开着
  ...
  useBrowserPanel().openPanel();
  ```
  改成：
  ```ts
  useRightPanel().select("browser"); // 再点已激活的 tab = 折叠（浮层还开着）
  ...
  useRightPanel().select("browser"); // 再展开
  ```

- [ ] **Step 2: 删模块**

```bash
git rm src/composables/useBrowserPanel.ts src/composables/useBrowserPanel.test.ts
```

- [ ] **Step 3: 全仓核对无残留**

Run: `grep -rn "useBrowserPanel" src/ agent-sidecar/src/ packages/ 2>/dev/null`
Expected: 无输出。

- [ ] **Step 4: 全量测试**

Run: `npx vitest run`
Expected: 全绿（`BrowserPanel.test.ts` 的三条让位回归 + 收藏夹用例全过）。

- [ ] **Step 5: 提交**

```bash
git add -A src/components/Browser/BrowserPanel.test.ts
git commit -m "refactor(browser): 删掉 useBrowserPanel——面板开合状态只剩一个主人

everOpened 并入 useRightPanel.browserEverActive；回归测试改用 select('browser')
驱动（点已激活项 = 折叠，与 rail 同语义）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 6: 截图如实失败（sidecar）

**Files:**
- Modify: `agent-sidecar/src/extensions/browser/screenshot.ts`
- Modify: `agent-sidecar/src/extensions/browserTools.ts:19-22,245-267,305-327`
- Test: `agent-sidecar/src/extensions/browserTools.test.ts`（截图块 + 夹具顺序）

**Interfaces:**
- Consumes: `probeVisibility`（`browser/runEval.ts:278`）、`PageVisibility`。
- Produces: `captureScreenshot(viewId, opts, emit): Promise<ScreenshotOutcome>`，其中 `ScreenshotOutcome` 新增 `visibility: PageVisibility`（**截图前**探到的那一次，caption 复用它——不再二次探测）。
- **破坏性**：现有截图用例的桥请求顺序翻转（原先 `[0]=captureScreenshot, [1]=caption 的探测`，现在 `[0]=探测, [1]=captureScreenshot`，成功路径也只有两发）。

- [ ] **Step 1: 写失败的测试（先改夹具顺序，再加新用例）**

`browserTools.test.ts` 截图块里，三条现有用例改成新顺序，并加一条"隐藏不试"：

```ts
  it("默认 jpeg q80：先探可见性 → 再截图；caption 复用那次探测，不二次探测", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk("visible", "string")); // ① 探可见性
    const q = await waitForQuery(events, 1);                           // ② 截图
    expect(q.method).toBe("Page.captureScreenshot");
    expect(q.params).toEqual({ format: "jpeg", quality: 80 });
    reply(q, { ok: true, data: { value: { data: "BASE64JPEG" } } });

    const r = await p;
    expect(events).toHaveLength(2); // 没有第三发
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
  });

  it("png 不带 quality（CDP 对 png 传它会报错）", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({ format: "png" }, {});
    reply(await waitForQuery(events, 0), evalOk("visible", "string"));
    const q = await waitForQuery(events, 1);
    expect(q.params).toEqual({ format: "png" });
    expect(q.params.quality).toBeUndefined();
    reply(q, { ok: true, data: { value: { data: "BASE64PNG" } } });

    const r = await p;
    expect(r.content[0].text).toContain("PNG");
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  /**
   * 视图隐藏 → **压根不试**。隐藏的 WebView2 不合成帧，`Page.captureScreenshot` 等不到帧
   * 就是 10s 超时（`native.rs:38`），而旧文案还把原因说成 "view closed"。这条钉住：
   * 不发截图请求、不烧那 10 秒、文案点名隐藏与出路。
   */
  it("视图隐藏 → 不发截图请求，文案点名隐藏与出路", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk("hidden", "string"));

    const r = await p;
    expect(events).toHaveLength(1); // 只有那一次探测
    expect(r.content).toHaveLength(1); // 不发图像块
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("hidden");
    expect(r.content[0].text).toContain("browser_read");
  });

  /**
   * CDP 域名可用性是运行期变量 → 被拒时必须**如实说清是运行期能力问题**并指向结构化通道，
   * 而不是假装截到了（模型会以为自己在看页面，实际什么都没看到）。
   */
  it("运行期拒绝 → 回文本说明 + 指向 browser_read/eval，不发图像块", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk("visible", "string"));
    reply(await waitForQuery(events, 1), {
      ok: true,
      data: { value: { error: { code: -32601, message: "'Page.captureScreenshot' wasn't found" } } },
    });

    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain("rejected by the runtime");
    expect(r.content[0].text).toContain("wasn't found");
    expect(r.content[0].text).toContain("WebView2 runtime capability");
    expect(r.content[0].text).toContain("browser_read");
  });

  it("回了 ok 但没有图像数据 → 如实报错，不塞空图", async () => {
    const { events, emit } = emitCollector();
    const p = toolByName({} as NodeJS.ProcessEnv, emit, "browser_screenshot").handler({}, {});
    reply(await waitForQuery(events, 0), evalOk("visible", "string"));
    reply(await waitForQuery(events, 1), { ok: true, data: { value: {} } });
    const r = await p;
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain("no image data");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run agent-sidecar/src/extensions/browserTools.test.ts -t screenshot`
Expected: FAIL —— 第 0 发回的是可见性、而现在的实现第 0 发就去截图（`q.method` 断言不过），且"视图隐藏"用例拿不到文案。

- [ ] **Step 3: 实现（`screenshot.ts`）**

替换文件末尾的注释与函数签名/开头：

```ts
import { probeVisibility } from "./runEval.js";
import type { PageVisibility } from "./runEval.js";

export interface ScreenshotOutcome {
  ok: boolean;
  data?: string;
  mimeType?: string;
  error?: string;
  /**
   * 截图**之前**探到的页面可见性。caption 直接复用它——同一轮里再探一次没有新信息，
   * 白多一发往返（这条路径本来就是最贵的那条）。
   */
  visibility: PageVisibility;
}

/** 视图隐藏时的失败文案（**不试**：隐藏的 WebView2 不合成帧，等帧就是 10s 超时）。 */
const HIDDEN_ERROR =
  'Not taken: this browser view is hidden from the engine (document.visibilityState = "hidden"), and a ' +
  "hidden WebView2 stops compositing — Page.captureScreenshot cannot get a frame, so the call would hang " +
  "until it timed out. This is an Aide/engine state, not a page problem. The view is hidden whenever its " +
  "panel is not showing: the right panel is collapsed, another right-panel tab (Files / Changes / Git / …) " +
  "is active, or an overlay (settings, command palette, permission dialog) is up. Ask the user to bring the " +
  "Browser tab to the front, or use browser_read / browser_eval — both work on hidden views.";

export async function captureScreenshot(
  viewId: string | undefined,
  opts: { fullPage: boolean; format: ScreenshotFormat },
  emit: (e: ChatEvent) => void,
): Promise<ScreenshotOutcome> {
  // 先判可见：隐藏视图的截图**注定**超时，不如立刻如实失败（2026-09-20 真机实测：
  // 隐藏视图 rAF 一帧都不跑，captureScreenshot 10s 无回包）。
  const visibility = await probeVisibility(viewId, emit);
  if (visibility === "hidden") return { ok: false, error: HIDDEN_ERROR, visibility };
  ...
```

其余分支返回对象都要带上 `visibility`，并把超时文案改成：

```ts
      error: resp.timedOut
        ? "Screenshot timed out — the desktop host did not reply within 15s. A view hidden mid-call cannot " +
          "produce a frame; the view may also have been closed."
        : `Screenshot failed: ${resp.error ?? "unknown error"}`,
```

删掉文件末尾那段"隐藏视图交出来的往往是上一次合成的那一帧"的注释（**未经验证**，实测是压根不返回），换成：

```ts
// 可见性探测住在 runEval.ts（`probeVisibility`）——求值的出口只有一处，别在这儿再开一份。
// 本模块在**截图之前**探它：隐藏 → 直接失败（隐藏视图等不到帧）。别把它挪到截图之后：
// 那样既白烧 10 秒，也让"为什么失败"变得不可诊断。
```

- [ ] **Step 4: 实现（`browserTools.ts`）**

- `:19-22` 的 import：删掉 `probeVisibility` 与 `hiddenNote` 两行（本文件不再用；`hiddenNote` 仍被 `act.ts` / `format.ts` / `wait.ts` 使用）。
- 删掉 `screenshotCaption` 整个函数（`:245-267`），换成纯常量 + 小函数：

```ts
/**
 * 截图块的说明文本。**不再自带可见性告警**：视图隐藏在 `captureScreenshot` 里已经被拦下
 * （压根不会走到这里），`unknown` 按 `visibility.ts` 的纪律也不说——没有依据的"可能"就是噪音。
 */
function screenshotCaption(opts: { fullPage: boolean; format: ScreenshotFormat }): string {
  return (
    `Screenshot of the embedded browser ${opts.fullPage ? "page (full)" : "visible viewport"} as ` +
    `${opts.format.toUpperCase()}. Reminder: this is the visual fallback — use browser_read / ` +
    `browser_eval when the question is about content or structure.`
  );
}
```

- handler（`:305-326`）里 caption 调用改成同步版：

```ts
            {
              type: "text" as const,
              text: screenshotCaption({ fullPage, format }),
            },
```

- 工具描述末尾追加一句（让模型调之前就知道这条前提）：

```
" Requires the view to be showing on screen: a hidden view cannot be captured, and the tool will say so " +
"instead of guessing."
```

- [ ] **Step 5: 跑测试 + 更新快照**

Run: `npx vitest run agent-sidecar/src/extensions/browserTools.test.ts`
Expected: PASS。

Run: `npx vitest run agent-sidecar/src/extensions/browserMcp.test.ts -u`
Expected: 快照因描述变化被更新（`browserMcp.test.ts.snap`）；**先读一遍 diff 确认只有描述那一行变了**，`BROWSER_ALLOW_RULES` / `BROWSER_INSTRUCTIONS` 两道断言不该动。

- [ ] **Step 6: 全量测试 + 提交**

Run: `npx vitest run`
Expected: 全绿。

```bash
git add agent-sidecar/src/extensions/browser/screenshot.ts agent-sidecar/src/extensions/browserTools.ts agent-sidecar/src/extensions/browserTools.test.ts agent-sidecar/src/extensions/__snapshots__/browserMcp.test.ts.snap
git commit -m "fix(browser): 截图对隐藏视图如实失败——不再烧 10 秒、不再说 view closed

真机实测（2026-09-20）：视图隐藏时 document.visibilityState='hidden'、JS 上下文活着但
rAF 一帧不跑（frames=0），Page.captureScreenshot 等不到帧 → 10s NATIVE_TIMEOUT，而文案
把原因说成 'view closed mid-flight?'，把 agent 引向"窗口被遮挡"的错误方向。

改成截图前先探可见性：hidden 直接回一条点名原因与出路的失败文案（不发截图请求、
不烧 10 秒）；成功路径复用这次探测，caption 不再二次探测也不再声称"隐藏视图会给旧帧"
（该说法未经验证，实测是压根不返回）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 7: 下钻超时文案订正（Rust）

**Files:**
- Modify: `src-tauri/src/browser/adapter/webview2/native.rs:75-77`

**Interfaces:**
- Consumes / Produces: 无（纯文案）。

- [ ] **Step 1: 改文案**

`native.rs` 的 `drill` 超时分支：

```rust
        // 超时原因不止一种：视图可能在取出句柄与闭包执行之间被 close（completed handler 永不来），
        // 也可能是**依赖合成帧的调用**（如 Page.captureScreenshot）落在了隐藏视图上——隐藏视图
        // 一帧都不合成，回包永远不来。下钻层是通用骨架，**只枚举可能，不猜单一原因**。
        Err(_) => Err(fail(format!(
            "native call got no reply within {NATIVE_TIMEOUT:?} (the view may be closed, or a \
             compositor-dependent call was made on a hidden view)"
        ))),
```

- [ ] **Step 2: 编译 + 测试**

Run: `cd src-tauri && cargo test --lib`
Expected: 全绿（`native.rs` 的两条 `wide` 单测不受影响）。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/browser/adapter/webview2/native.rs
git commit -m "fix(browser): 下钻超时文案不再断定 view closed——隐藏视图也是一种

视图没关、只是被隐藏时，依赖合成帧的 CDP 调用同样拿不到回包。骨架层只枚举可能，
不指名单一原因（截图路径已在前一层拦住隐藏视图，这里兜的是竞态）。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Task 8: 真机验收（需要用户在场）

**Files:** 无（只跑 dev 与人工核对）

**验收清单（逐条打勾，任何一条不过就地开新任务，不许"先合并再说"）：**

- [ ] **1. 停靠态截图能出图（本轮改动的正经验收点）**：右栏切到浏览器、页面在前台 → 让 agent 跑 `browser_screenshot` → 拿到图像块，caption 不带"stale"字样。
- [ ] **2. 隐藏态如实失败**：折叠右栏（或切到「文件」tab）→ 再让 agent 截图 → 立即回一条点名 hidden 的文本（**不是** 10 秒后超时），文案里有 `browser_read` 出路。
- [ ] **3. 同屏**：右栏浏览器 + 左侧聊天同时可见；拖宽档把手，洞的 rect 跟着变（`set_bounds` 生效：页面内容重排不错位）。
- [ ] **4. 宽度两档**：切「文件」→ 340 上下、上限 540；切浏览器 → 约窗口一半；各自记住手拖值；窗口拉窄 → 浏览器不低于 420。
- [ ] **5. 最大化**：右栏铺满、聊天让位；还原后浏览器回到右栏原宽度；最大化期间打开插件市场 → 自动退最大化。
- [ ] **6. 切会话不踢浏览器**（对比改动前 `App.vue:401` 的行为）。
- [ ] **7. 浮层让位**：设置 / Ctrl+P / 权限弹窗 / 右键菜单弹出时视图隐藏、关掉回来。
- [ ] **8. 文件窗口层**：最大化时 `FileViewer` 悬浮窗缩没、还原后自动回来；不出现"露半个窗口"。**真露** → 进最大化前先收起它（补一个小任务）。
- [ ] **9. 快捷键三入口语义一致**：`Ctrl+8` / `Ctrl+Shift+B` / rail 点已激活项 = 折叠。
- [ ] **10. 左栏不再有浏览器入口**；`Ctrl+Shift+B` 仍可达。

- [ ] **Step: dev 怎么起（含两个已知坑）**

Run: `pnpm dev`
- **坑 1**：sidecar 跑 `dist` 构建产物——本计划改了 `agent-sidecar/src`（Task 6），**必须先 `pnpm build:sidecar`（或仓里既有的 sidecar 构建脚本）再重启 tauri dev**，否则验的是旧代码。
- **坑 2**：安装版与 dev 版可同时运行（`Get-Process aide` 比启动时间分辨），确认对话跑在哪个实例上。
- 真机手工核对时用 `browser_tabs` 看宿主侧 `visible` 与页面侧 `visibilityState` 是否一致（2026-09-20 已确证一致，可复查）。

---

## 自审记录

- **spec 覆盖**：§1 状态模型 → Task 1；§2 布局与宽度 → Task 3（布局）+ Task 4（宽度）；§3 入口与迁移 → Task 3 Step 2 / Step 5；§4 测试与验收 → 各任务 Step（单测）+ Task 8（真机）；§5 截图如实失败 → Task 6 + Task 7；非目标"宽度不落盘" → Task 4 Step 3 注释与测试都只走内存。
- **偏离**：`useBrowserPanel` 整删（见文首），其余逐条对齐。
- **类型一致性**：`WidthSource` / `rightPanelWidthSource` / `WidthLimits` / `RightTabId` / `browserActive` / `browserMaximized`（App 内别名 = `rightPanel.maximized`）在 Task 1-3-4 之间名字与形态一致。
- **已知顺序约束**：Task 3 结束时 `BrowserPanel.test.ts` 会红（它还在用 `useBrowserPanel`），Task 5 修——中间态不提交上线，只影响本机测试读数。

// 右侧栏「显示什么」的单一主人（模块级单例，与 usePaneLayout / useWorkspaces 同范式）。
//
// 为什么要有这个模块：内嵌浏览器从「主区一级视图」搬进右栏后，**"面板开没开"只准有一个主人**。
// 历史上 rightTab / rightCollapsed 住在 App.vue、浏览器开合住在 useBrowserPanel——两半各说各话，
// "面板关了视图还在""切了 tab 视图不跟着走"这类幽灵故障都源自这种分裂。
//
// 本模块只认状态与裁决，不认 DOM（宽度绑定见 useResizable + rightPanelWidthSource）。
import { computed, ref } from "vue";

import type { WidthSource } from "./useResizable";

/** 右栏 tab id。加一个 tab = 这里加一个字面量 + App.vue 的 rightTabs / RAIL_DIGIT_TABS 各加一行。 */
export type RightTabId =
  | "files"
  | "changes"
  | "git"
  | "search"
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

/**
 * 待打开的地址。右栏只负责「记下来 + 把浏览器 tab 露出来」，真正去
 * `browser.create` / `browser.navigate` 的是 `BrowserPanel` 自己——它的内部状态
 * 不对外暴露（无 props、无 emits、无 defineExpose），这个 ref 是唯一的缝。
 *
 * 与 `useBrowserViews` 的 `pendingFocusViewId` 同一范式：**待办 + 消费**，
 * 而不是「把 URL 塞进别人的私有状态里」。
 */
const pendingBrowserUrl = ref<string | null>(null);

/** 浏览器视图此刻该不该露头：视图可见性总闸的一半（另一半是 App 的 overlayLayerOpen）。 */
const browserActive = computed(() => tab.value === "browser" && !collapsed.value);

/**
 * 最大化 = 右栏铺满、聊天让位。**派生而非独立状态**：折叠或切走立刻为假，
 * 不需要"谁负责在切 tab 时把它清掉"这种约定（幽灵状态的温床）。
 * 意图是记住的——切回浏览器 tab 会自动恢复最大化，这是有意的。
 */
const maximized = computed(() => wantMaximized.value && browserActive.value);

/** rail / 快捷键的统一裁决（逐字沿用 App.vue 旧 onRailSelect 的三态语义）。 */
function select(id: RightTabId) {  // 懒挂载：第一次点就挂，之后常驻（关面板只 setDisplayed(false)，页面与历史都留着）。
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

/**
 * 收起右栏（只留竖直 rail）。幂等；**不动 tab** —— "上次看的是哪一栏"是记着的，
 * 下次展开还在那一栏。用于「切进日常对话就收起面板」（spec 2026-09-20）：那是布局
 * 动作，不是归属变更，活动工作区一动不动。
 */
function collapse() {
  collapsed.value = true;
}

function setMaximized(on: boolean) {
  wantMaximized.value = on;
}

/**
 * **幂等**展开到某个 tab（不是 toggle）。
 *
 * 不能用 `select(id)`：那是 toggle，用户已经在该 tab 时会把面板**收起来**——
 * 一个"给我看看"的请求变成"把你的面板关掉"。agent 的 focus 请求（浏览器）与
 * 结算卡的「变更面板 ↗」都踩这个坑，故裁决收在这里一处。
 */
function ensureTabShown(id: RightTabId) {
  if (id === "browser") browserEverActive.value = true; // 懒挂载：浏览器组件首次激活才挂
  tab.value = id;
  collapsed.value = false;
}

/** 展开浏览器面板（agent 的 focus 请求走它）。 */
function ensureBrowserShown() {
  ensureTabShown("browser");
}

/**
 * 「给我在右栏把这个地址打开」——资料库的网页产物预览走它。
 *
 * 只记待办 + 展开右栏；面板自己消费（见 `consumePendingBrowserUrl`）。
 * 连开两个地址时后者覆盖前者：待打开的只有一个，排队没有语义。
 */
function openInBrowser(url: string) {
  ensureBrowserShown();
  pendingBrowserUrl.value = url;
}

/** 取走待打开的地址（取走即清空，避免第二个面板实例重复打开）。 */
function consumePendingBrowserUrl(): string | null {
  const url = pendingBrowserUrl.value;
  pendingBrowserUrl.value = null;
  return url;
}

// ── 宽度：两档（窄工具 tab / 浏览器宽档），值只存内存（跨重启按窗口重算，用户 2026-09-20 定）──

/** 中心轨道 minmax(400px,1fr) 的保底：**聊天底线优先于"五五开"**。 */
const MIN_CHAT_PX = 400;
/** 两块面板之间的两条 1px 分隔线轨道。 */
const GUTTER_PX = 2;

const widths = ref<{ narrow: number; browser: number }>({ narrow: 0, browser: 0 });

/** 拖动把手此刻用哪一档：浏览器停靠态用宽档，其余（含最大化——此时宽度不参与布局）用窄档。 */
const widthProfile = computed<"narrow" | "browser">(() =>
  browserActive.value && !maximized.value ? "browser" : "narrow",
);

/** 布局量测：App 注入（只有它知道 DOM）。量不到给 0 → 一律按 min 收，宁可容错不猜。 */
export type LayoutMeasure = () => { appW: number; leftW: number };

/** 右栏宽度源：档位选择与边界都在这里，`useResizable` 只拿它去绑 DOM。 */
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

export function useRightPanel() {
  return {
    collapsed,
    tab,
    wantMaximized,
    maximized,
    browserActive,
    browserEverActive,
    select,
    collapse,
    setMaximized,
    ensureBrowserShown,
    ensureTabShown,
    pendingBrowserUrl,
    openInBrowser,
    consumePendingBrowserUrl,
    widths,
    widthProfile,
    setWidth,
  };
}

/** 仅供测试复位模块单例（同 `__resetPaneLayoutForTest` 范式）。 */
export function __resetRightPanelForTest() {
  collapsed.value = true;
  tab.value = "files";
  wantMaximized.value = false;
  browserEverActive.value = false;
  pendingBrowserUrl.value = null;
  widths.value = { narrow: 0, browser: 0 };
}

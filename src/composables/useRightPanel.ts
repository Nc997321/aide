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

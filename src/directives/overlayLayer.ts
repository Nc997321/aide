// 全屏遮罩层登记处——「此刻有没有 HTML 浮层盖在主区之上」的**单一事实源**。
//
// 两个消费者问的其实是同一个问题：
// - **渲染层**：内嵌浏览器的原生 WebView2 子视图浮在所有 HTML 之上、**不受 z-index 约束**
//   （见 BrowserPanel.vue 文件头「物理约束」）→ 浮层开着时它必须 `setDisplayed(false)` 让位，
//   否则浮层被网页吃掉下半截。`BrowserPanel.vue` 的 `viewAllowed` 读这里。
// - **键盘**：`PermissionDialog` 的 window 级 Enter/Esc 只在不被浮层挡住时才响应。
//   （原先它在 `OVERLAY_SELECTOR` 里另抄一份遮罩类名表——同一个概念两份清单必然漂移，
//   2026-09-16 收敛到这里。）
//
// 用法：遮罩**根元素**挂 `v-overlay-layer`（局部 import `vOverlayLayer` 即可，无需全局注册）。
// 登记跟着元素生命周期走，所以契约是 **浮层根元素用 `v-if` 控制（DOM 存在 = 开着）**——
// 这正是 PermissionDialog 的键盘路由一直以来依赖的那条约定，此处只是把它变成可查询的状态。
// `v-show` 的常驻浮层不适用（本仓暂无；真要加，得换成按可见性来源登记的形式）。
//
// 漏登记的代价：面板开着时这个浮层被网页吃掉（视觉），或键盘穿透到权限弹窗（安全）。
// `scripts/check-overlay-layers.mjs` 在构建期兜这条漏。
import { readonly, ref, type Directive } from "vue";

/** 当前开着的浮层。用元素本身做身份：同组件多实例（多窗格各一份）天然各记各的。 */
const open = new Set<HTMLElement>();
const anyOpen = ref(false);

/** 有没有浮层正盖在主区之上。只读——登记只有 `v-overlay-layer` 一条路。 */
export const overlayLayerOpen = readonly(anyOpen);

function sync() {
  anyOpen.value = open.size > 0;
}

export const vOverlayLayer: Directive<HTMLElement, undefined> = {
  mounted(el) {
    open.add(el);
    sync();
  },
  unmounted(el) {
    open.delete(el);
    sync();
  },
};

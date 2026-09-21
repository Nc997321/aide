/**
 * 「可点击」判定 —— **注入脚本共用的那一段**。
 *
 * 两个消费者内插同一份：`projection.ts`（`browser_read` 的可点元素索引）与 `actions.ts`
 * （`browser_act` 的文本候选、候选提示）。单一真相源的理由是**可发现性必须等于可操作性**：
 * read 里看得见的可点元素，act 就该能按文本点到。两份判定各写一套（原先就是：索引按标签一份、
 * 文本候选按另一份，且都窄）时，agent 会撞上「索引里没有、按文本也点不到」的 div 型按钮。
 *
 * # 判据两类，都不猜
 *
 * 1. **标记线索**（便宜、精确）：标签 / role / 属性。覆盖标准控件与框架自己打了角色的组件。
 * 2. **光标线索**（贵，要 `getComputedStyle`）：`cursor: pointer` 是**浏览器自己**暴露给用户的
 *    「这里能点」——只有它认得 `<div class="aclick">`、`<span class="tab-btn">` 这类
 *    「用 div 拼的按钮」。光标是**继承属性**，所以外层卡片设了 pointer，内层文字元素同样报
 *    pointer：扫描按 DOM 顺序取「祖先先入册」，点它的中心就是点这段文字，比点整个卡片的几何
 *    中心更稳。
 *
 * **诚实边界**：既无标记线索、又没写 `cursor: pointer` 的元素，这里认不出。那种情况
 * **如实说认不出**（`actions.ts` 的三种「找不到」），让模型改口径用选择器 —— 不猜着点。
 *
 * # 为什么是字符串
 *
 * 这是**注入进页面的 JS 源码**，不是本进程能跑的函数：两个调用方各自的脚本靠内插共享它。
 * 写的时候别用反引号或 `${}`（会撕开外层模板字面量）；`clickable.test.ts` 钉住了这条。
 */

/** 标记线索（CSS 选择器形态；`actions.ts` 也拿它拼文本候选）。 */
export const CLICKABLE_MARKUP_SELECTOR =
  'button,[role="button"],input[type="submit"],input[type="button"],a[href],' +
  '[onclick],[tabindex],[contenteditable="true"],[aria-haspopup]';

/** 共享片段：注入脚本里可用的三个判定（外加内插的选择器常量）。 */
export const CLICKABLE_JS = `
  var CLICKABLE_MARKUP = ${JSON.stringify(CLICKABLE_MARKUP_SELECTOR)};

  /** 标记线索：标签 / role / 属性。 */
  function clickableByMarkup(el) {
    try { return !!(el.matches && el.matches(CLICKABLE_MARKUP)); } catch (e) { return false; }
  }

  /** 光标线索：调用方自己决定何时付这次 getComputedStyle（逐元素，贵）。 */
  function clickableByStyle(el) {
    try { return window.getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
  }

  /**
   * 有没有盒 —— 挡掉 display:none 系（含隐藏的 popper、teleport 出去的日期面板）。
   *
   * ⚠️ **抓不到 visibility:hidden 与 opacity:0**：那要 computed style，逐元素太贵。
   * 如实留着这条边界，别在这里假装筛干净了。
   * 拿不到 getClientRects（老运行时）时回 true —— 宁可多列，不可漏列。
   */
  function isRendered(el) {
    if (!el || !el.getClientRects) return true;
    try { return el.getClientRects().length > 0; } catch (e) { return true; }
  }
`;

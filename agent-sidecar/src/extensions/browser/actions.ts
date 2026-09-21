/**
 * 页面动作脚本（**站点无关**）——`browser_act` 的载荷。
 *
 * # 定位方式：文本 / 选择器，**不用 ref 表**
 *
 * 快照发 ref、下一次调用按 ref 找元素那套（Playwright MCP 的形状）有个天然麻烦：页面一变
 * ref 全失效，得靠"响亮地报错 + 让模型重新快照"兜。而 agent 表达"点那个写着「刷新」的按钮"
 * 本来就是自然的——直接按文本定位既没有跨调用的状态，也没有失效问题。
 *
 * # 点击路径：CDP 真实输入优先，脚本派发兜底
 *
 * `element.click()` 会跳过事件管线（无 hover/mousedown/mouseup、无 `isTrusted`），在不少
 * 框架和文件上传上失效——所以主路径是把坐标交给 CDP 的 `Input.dispatchMouseEvent` 派发
 * **真实**输入。但 WebView2 是 Evergreen 运行时，各机器版本不同，**CDP 域名可用性是运行期
 * 变量**，所以必须有兜底，且**如实报告走了哪条路**（不静默降级）。
 *
 * # 「找不到」有三种，分开报
 *
 * ① 页面上根本没有这段文本 ② 有、但全部匹配不可见 ③ 有且可见、但它的元素**不被认为可点击**
 * （用 div 拼的按钮，且没写 `cursor:pointer`/role/handler）。三者的下一步完全不同：改词 /
 * 先点开或等渲染 / 改用选择器。合成一句"没找到"，模型只能在三种假设里瞎试。
 * 判据本身（什么算可点击）住在 `clickable.ts`，与 `browser_read` 的索引共用同一份。
 *
 * # 上限与安全
 *
 * - 只做「解析目标」和「设值/派发事件」，**不提交表单**——提交与否由模型按用户意图决定。
 * - 目标解析不到时回 `ok:false` + 候选清单，让模型改口径重试，而不是点错元素。
 */
import { CLICKABLE_JS, CLICKABLE_MARKUP_SELECTOR } from "./clickable.js";

/** 目标描述：`selector` 与 `text` 至少给一个；两个都给时 `selector` 优先。 */
export interface ActTarget {
  /** CSS 选择器。 */
  selector?: string;
  /** 按可见文本匹配（最具体的那个优先）。 */
  text?: string;
  /** 限定文本匹配的标签范围（如 `"button"`），省略则在常见可交互标签里找。 */
  tag?: string;
  /** 命中多个时的序号（默认 0）。 */
  index?: number;
}

/**
 * 文本匹配的默认候选范围：内容元素的宽集合 **∪「可点击」判据**（`clickable.ts`）。
 *
 * 并集而非替换，两条理由：① 只按可点击判据取候选会**回归**今天能用的路径（点 `td` 靠父级
 * handler 生效的表格行）；② 并集保证「`browser_read` 里看得见的可点元素，这里按文本一定点得到」。
 * 精度由 `byText` 的「精确匹配优先 + 标签最短优先」兜着。
 */
const TEXT_CANDIDATE_SELECTOR =
  'button,a,[role="button"],input,select,textarea,label,td,th,li,div,span,p,h1,h2,h3,h4,h5,h6,' +
  CLICKABLE_MARKUP_SELECTOR;

/**
 * 解析目标的公共前导（三个脚本共用）：把目标注入脚本、并提供统一的查找/可见性工具。
 *
 * `JSON.stringify` 的产物是合法 JS 字面量（JSON 是 JS 对象的子集），故此处内插无注入风险；
 * 但**字符串里的 `</script>` 之类不构成问题**——这不是 HTML 上下文。
 */
function preamble(target: ActTarget): string {
  return `
  'use strict';
  var TARGET = ${JSON.stringify(target)};
  var TEXT_CANDIDATES = ${JSON.stringify(TEXT_CANDIDATE_SELECTOR)};
${CLICKABLE_JS}
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var st = null;
    try { st = window.getComputedStyle(el); } catch (e) { return true; }
    if (!st) return true;
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  }

  function labelOf(el) {
    var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t) return t;
    if (el.value) return String(el.value);
    var al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return al;
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return ph;
    return '';
  }

  /** 元素的自述（给模型看的候选行）：标签 + 文本 + id/name/class 线索。 */
  function describe(el) {
    var cls = '';
    try {
      if (el.className && typeof el.className === 'string') cls = el.className.trim().split(/\\s+/)[0] || '';
    } catch (e) { /* SVG 的 className 是对象：忽略 */ }
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      text: labelOf(el).slice(0, 120),
      id: el.id || null,
      name: (el.getAttribute && el.getAttribute('name')) || null,
      cls: cls || null
    };
  }

  /** 给模型改口用的选择器建议（能直接用在下一次调用里）。 */
  function selectorHint(el) {
    if (el.id) return '#' + el.id;
    var tag = el.tagName ? el.tagName.toLowerCase() : '?';
    var d = describe(el);
    return d.cls ? tag + '.' + d.cls : tag;
  }

  /**
   * 页面上**真的**带着这段文本的元素：按文本节点找，**不看可点性、不看可见性**
   * （正因为要区分这两种情况，才必须绕开候选池）。
   * 只在"候选池为空"的失败路径上跑——成功路径零成本。
   */
  function textHits(want, cap) {
    var hits = [];
    try {
      var root = document.body || document.documentElement;
      if (!root) return hits;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var seen = 0;
      var n;
      while ((n = walker.nextNode())) {
        if (++seen > 4000) break;
        if (!n.data || n.data.indexOf(want) < 0) continue;
        var el = n.parentElement;
        if (!el) continue;
        if (hits.indexOf(el) < 0) hits.push(el);
        if (hits.length >= cap) break;
      }
    } catch (e) { /* 补充说明拿不到就算了，别把失败变成异常 */ }
    return hits;
  }

  /** 「找不到」的三种分支（见文件头）。 */
  function notFound(want) {
    var hits = textHits(want, 12);
    var shown = [], hiddenHits = [];
    for (var i = 0; i < hits.length; i++) {
      (visible(hits[i]) ? shown : hiddenHits).push(hits[i]);
    }
    if (shown.length) {
      return {
        error: 'text ' + JSON.stringify(want) + ' is on the page and visible, but its element is not ' +
          'recognized as clickable (no cursor:pointer, role or handler) — retry with an explicit ' +
          'selector such as ' + selectorHint(shown[0]),
        candidatesKind: 'text-hits',
        candidates: shown.slice(0, 6).map(describe)
      };
    }
    if (hiddenHits.length) {
      return {
        error: 'text ' + JSON.stringify(want) + ' exists on the page but every match is hidden ' +
          '(display:none / zero-size) — open it or wait for the page to render first',
        candidatesKind: 'text-hits',
        candidates: hiddenHits.slice(0, 6).map(describe)
      };
    }
    return { error: 'no element on the page contains that text ' + JSON.stringify(want) };
  }

  function bySelector() {
    var found;
    try { found = document.querySelectorAll(TARGET.selector); }
    catch (e) { return { error: 'invalid CSS selector: ' + String(e.message || e) }; }
    var vis = [];
    for (var i = 0; i < found.length; i++) { if (visible(found[i])) vis.push(found[i]); }
    var pool = vis.length ? vis : Array.prototype.slice.call(found);
    if (!pool.length) return { error: 'selector matched nothing: ' + TARGET.selector };
    return { el: pool[Math.min(TARGET.index || 0, pool.length - 1)], count: pool.length };
  }

  function byText() {
    var sel = TARGET.tag ? TARGET.tag : TEXT_CANDIDATES;
    var found;
    try { found = document.querySelectorAll(sel); } catch (e) { return { error: 'invalid tag: ' + TARGET.tag }; }
    var want = String(TARGET.text);
    var exact = [], partial = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (!visible(el)) continue;
      var t = labelOf(el);
      if (!t) continue;
      if (t === want) exact.push(el);
      else if (t.indexOf(want) >= 0) partial.push(el);
    }
    var pool = exact.length ? exact : partial;
    if (!pool.length) return notFound(want);
    // 最具体的优先：文本最短的那个通常就是目标，而不是包含它的整个容器；文本等长时取
    // **子元素更少**的那个（<div class="aclick"><span>查看</span></div> 里该点 span ——
    // 点内层文字一定落在 handler 作用域内，点外层只在外层真的挂了 handler 时才生效）。
    pool.sort(function (a, b) {
      var d = labelOf(a).length - labelOf(b).length;
      if (d !== 0) return d;
      return (a.children ? a.children.length : 0) - (b.children ? b.children.length : 0);
    });
    return { el: pool[Math.min(TARGET.index || 0, pool.length - 1)], count: pool.length };
  }

  function resolve() {
    if (TARGET.selector) return bySelector();
    if (TARGET.text) return byText();
    return { error: 'no target given: provide selector or text' };
  }

  /**
   * 解析失败的统一信封：notFound 已经给了**定性**的候选（文本命中）就用它；
   * 否则补一份"页面上现在有哪些能点的"，让模型改口径。
   */
  function failure(err, extra) {
    var out = { ok: false, error: err };
    if (extra && extra.candidates && extra.candidates.length) {
      out.candidates = extra.candidates;
      out.candidatesKind = extra.candidatesKind || 'clickable';
      return out;
    }
    var hint = [];
    try {
      var cands = document.querySelectorAll(CLICKABLE_MARKUP);
      for (var ci = 0; ci < cands.length && hint.length < 15; ci++) {
        if (!visible(cands[ci])) continue;
        var lbl = labelOf(cands[ci]);
        if (lbl) hint.push(describe(cands[ci]));
      }
    } catch (e) { /* 候选只是锦上添花，拿不到就算了 */ }
    out.candidates = hint;
    out.candidatesKind = 'clickable';
    return out;
  }
`;
}

/**
 * 解析目标并**算好屏幕坐标**（点击用）。返回值里带 `hit` 描述，让模型知道点到了什么。
 *
 * 坐标口径：先 `scrollIntoView({behavior:'instant'})`（**必须 instant**——smooth 是动画，
 * 同一次脚本执行里读到的 rect 会是滚动前的旧值），再读 `getBoundingClientRect()`。
 * rect 是视口相对坐标，正是 CDP `Input.dispatchMouseEvent` 要的口径。
 */
export function buildResolveScript(target: ActTarget): string {
  return `(() => {${preamble(target)}
  try {
    var r = resolve();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (e) { el.scrollIntoView(); }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, error: 'matched element has zero size (hidden or not laid out)', hit: describe(el) };
    }
    return {
      ok: true,
      hit: describe(el),
      matched: r.count,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  } catch (e) {
    return { ok: false, error: 'resolve failed: ' + String((e && e.message) || e) };
  }
})()`;
}

/**
 * 设值（`fill`）：置 value 并派发 `input` + `change`。
 *
 * **两个事件都要派发**：Vue/React 受控组件靠 `input` 同步内部状态，而复选框/下拉/表单序列化
 * 靠 `change`。只派发一个会出现「看起来填上了，提交时是空的」。
 */
export function buildFillScript(target: ActTarget, value: string): string {
  return `(() => {${preamble(target)}
  try {
    var r = resolve();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    var VALUE = ${JSON.stringify(value)};
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 非必需 */ }
    el.focus && el.focus();

    if (el.tagName === 'SELECT') {
      var matched = null;
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.value === VALUE || (o.textContent || '').trim() === VALUE) { matched = o; break; }
      }
      if (!matched) {
        var opts = [];
        for (var j = 0; j < el.options.length && j < 40; j++) opts.push((el.options[j].textContent || '').trim());
        return { ok: false, error: 'no option matching ' + JSON.stringify(VALUE), options: opts, hit: describe(el) };
      }
      el.value = matched.value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      var want = VALUE === 'true' || VALUE === 'checked' || VALUE === '1';
      if (el.checked !== want) el.click();
    } else {
      el.value = VALUE;
    }

    var evOpts = { bubbles: true, cancelable: true };
    try { el.dispatchEvent(new Event('input', evOpts)); } catch (e) { /* 老环境忽略 */ }
    try { el.dispatchEvent(new Event('change', evOpts)); } catch (e) { /* 老环境忽略 */ }
    return { ok: true, hit: describe(el), value: el.value };
  } catch (e) {
    return { ok: false, error: 'fill failed: ' + String((e && e.message) || e) };
  }
})()`;
}

/**
 * 脚本派发兜底点击：CDP 不可用时用。
 *
 * 用**完整鼠标事件序列**（pointerdown → mousedown → pointerup → mouseup → click）而不是
 * `el.click()`：后者只发一个 click，依赖 mousedown 起效的控件（下拉、拖拽、菜单）会静默失效。
 * 仍不是 `isTrusted` 事件——**这一点由调用方如实告诉模型**，不假装等价。
 */
export function buildClickFallbackScript(target: ActTarget): string {
  return `(() => {${preamble(target)}
  try {
    var r = resolve();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 非必需 */ }
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
    var seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
    for (var i = 0; i < seq.length; i++) {
      var name = seq[i];
      var ev;
      try {
        ev = (name.indexOf('pointer') === 0 && window.PointerEvent)
          ? new PointerEvent(name, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, base))
          : new MouseEvent(name, base);
      } catch (e) {
        ev = new MouseEvent(name, base);
      }
      el.dispatchEvent(ev);
    }
    el.dispatchEvent(new MouseEvent('click', base));
    if (typeof el.focus === 'function') { try { el.focus(); } catch (e) { /* 非必需 */ } }
    return { ok: true, hit: describe(el) };
  } catch (e) {
    return { ok: false, error: 'click fallback failed: ' + String((e && e.message) || e) };
  }
})()`;
}

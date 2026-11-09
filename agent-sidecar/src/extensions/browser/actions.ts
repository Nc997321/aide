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
import { FIELD_LABEL_JS } from "./fieldLabel.js";

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
 *
 * 但这个集合是**文本载体**、不是**可点断言**：挑目标前 `byText` 还要过一道 `landable`
 * （自己或 ≤6 层祖先带可点线索）——否则裸 div 会让"文本在、但不像可点击"那条分支永远够不着。
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
${FIELD_LABEL_JS}
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
   * 「去掉所有空白」的形态 —— **只给比较用**。
   *
   * 为什么：EP 把双字按钮渲染成「确　定」（中间是空白/全角空格），而模型给的是「确定」——
   * 归一化之后既不 === 也不 indexOf。JS 正则的空白类覆盖 U+3000（全角空格）与换行，所以这一
   * 句就够了。
   *
   * （本文件是**注入脚本的源码**：注释里也不能出现反引号，那会撕开外层模板字面量——
   * 同款约定见 clickable.ts。）
   *
   * ⚠️ **不许拿它去做 labelOf 的归一化**：labelOf 的单空格折叠是渲染给模型看的形态，
   * 改它会波及 browser_read 的索引输出。
   */
  function tight(s) { return String(s == null ? '' : s).replace(/\\s+/g, ''); }

  /**
   * 文本命中分两池：**精确**（相等，或**去空白后相等**）与**包含**（含去空白后包含）。
   *
   * 去空白那一层是给 CJK 框架渲染留的容错（见 tight）：常规页面这一层恒等于上一层，
   * 不多不少；只有「确　定」这类渲染才会把真按钮救回候选池。
   * wantTight 为空串时整层跳过——否则 indexOf('') 恒为 0，页面上**每个**元素都会变成包含。
   */
  function textPools(found, want, wantTight) {
    var exact = [], partial = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (!visible(el)) continue;
      var t = labelOf(el);
      if (!t) continue;
      var tt = tight(t);
      if (t === want || (wantTight && tt === wantTight)) exact.push(el);
      else if (t.indexOf(want) >= 0 || (wantTight && tt.indexOf(wantTight) >= 0)) partial.push(el);
    }
    return { exact: exact, partial: partial };
  }

  /**
   * 池子滤成「点下去会落在可点元素里」的那堆，再按**最具体的优先**排序。
   *
   * 为什么必须滤：池子是"文本载体"的宽集合（裸 div/span/td 都在里面，见 TEXT_CANDIDATE_SELECTOR
   * 的注释），**能承载文本 ≠ 能点**。滤空了由调用方交给 notFound（选择器建议），不猜着点；
   * 少了这一步，宽池子会让**任何**装在 div 里的文字都"点得到"，「文本在、但不像可点击」那条
   * 分支就成了真页面上够不着的死代码（2026-09-22 夹具实测）。
   *
   * 排序口径：文本最短的那个通常就是目标，而不是包含它的整个容器；文本等长时取**子元素更少**
   * 的那个（<div class="aclick"><span>查看</span></div> 里该点 span —— 点内层文字一定落在
   * handler 作用域内，点外层只在外层真的挂了 handler 时才生效）。
   */
  function landableFirst(pool) {
    var live = [];
    for (var i = 0; i < pool.length; i++) {
      if (landable(pool[i])) live.push(pool[i]);
    }
    live.sort(function (a, b) {
      var d = labelOf(a).length - labelOf(b).length;
      if (d !== 0) return d;
      return (a.children ? a.children.length : 0) - (b.children ? b.children.length : 0);
    });
    return live;
  }

  /**
   * 页面上**真的**带着这段文本的元素：按文本节点找，**不看可点性、不看可见性**
   * （正因为要区分这两种情况，才必须绕开候选池）。
   * 只在"候选池为空"的失败路径上跑——成功路径零成本。
   */
  function textHits(want, cap) {
    var hits = [];
    var wantTight = tight(want);
    try {
      var root = document.body || document.documentElement;
      if (!root) return hits;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var seen = 0;
      var n;
      while ((n = walker.nextNode())) {
        if (++seen > 4000) break;
        if (!n.data || (n.data.indexOf(want) < 0 && (!wantTight || tight(n.data).indexOf(wantTight) < 0))) continue;
        var el = n.parentElement;
        if (!el) continue;
        if (hits.indexOf(el) < 0) hits.push(el);
        if (hits.length >= cap) break;
      }
    } catch (e) { /* 补充说明拿不到就算了，别把失败变成异常 */ }
    return hits;
  }

  /**
   * 点下去会不会落在某个"看起来能点"的元素里：**自己算，或某个祖先算**。
   *
   * 为什么必须看祖先：文字常常装在子元素里，而 handler / role 挂在父级
   * （<div role="button"><span>保存</span></div>、<button>保存 <span>草稿</span></button>）——
   * 点击靠冒泡生效，只看自己会把这类全部误判成"不可点"。
   * 样式那一半不必往上找：cursor 是**继承属性**，祖先设了 pointer，自己就报 pointer。
   *
   * 上限 6 层：够覆盖常见包裹层级，又不至于把"整页裹在一个可点容器里"这种病态结构当成处处可点。
   */
  function landable(el) {
    if (clickableByMarkup(el) || clickableByStyle(el)) return true;
    var p = el.parentElement;
    for (var hop = 0; p && hop < 6; hop++) {
      if (clickableByMarkup(p)) return true;
      p = p.parentElement;
    }
    return false;
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
    // 多命中且**没显式给 index** → 不猜。selector 的池子是文档序，第一个没有任何理由，而默默取它
    // 是个替调用方做的决定（2026-09-29 走查实锤：宽 selector 把值灌进了另一个控件的搜索框）。
    // 显式 index（含 0）是调用方自己的表达，照办——「要第一个」因此仍然是一句话的事。
    if (pool.length > 1 && TARGET.index === undefined) {
      return {
        error: 'selector ' + JSON.stringify(TARGET.selector) + ' matched ' + pool.length +
          ' elements — pass index to pick one, or narrow the selector (nothing was touched)',
        candidatesKind: 'selector-matches',
        candidates: pool.slice(0, 8).map(describe)
      };
    }
    var used = Math.min(TARGET.index || 0, pool.length - 1);
    return { el: pool[used], count: pool.length, used: used };
  }

  function byText() {
    var sel = TARGET.tag ? TARGET.tag : TEXT_CANDIDATES;
    var found;
    try { found = document.querySelectorAll(sel); } catch (e) { return { error: 'invalid tag: ' + TARGET.tag }; }
    var want = String(TARGET.text);
    var pools = textPools(found, want, tight(want));
    var pool = pools.exact.length ? pools.exact : pools.partial;
    if (!pool.length) return notFound(want);
    var live = landableFirst(pool);
    if (!live.length) return notFound(want);
    // used 是**钳制之后**的序号：index 越界时 Math.min 会换成别的元素，必须一起交代
    // （调用方据此报数，见 act.ts 的 matchNote），否则模型以为自己点的是自己说的那个。
    var used = Math.min(TARGET.index || 0, live.length - 1);
    return { el: live[used], count: live.length, used: used };
  }

  function resolve() {
    if (TARGET.selector) return bySelector();
    if (TARGET.text) return byText();
    return { error: 'no target given: provide selector or text' };
  }

  /**
   * 按键的目标（press 专用）：**给了就解析，没给就是当前焦点**——"fill 之后按回车"靠的就是
   * 后者，不该逼调用方把刚填过的字段再说一遍。
   *
   * 页面上**什么都没聚焦**时如实失败：发出的键没人接，模型看到的只是"按了没反应"（幽灵故障）。
   * 焦点落在 body/documentElement 上等于没聚焦（事件落到 document，没有任何控件收到）。
   */
  function targetOrActive() {
    if (TARGET.selector || TARGET.text) return resolve();
    var act = document.activeElement;
    if (!act || act === document.body || act === document.documentElement) {
      return { error: 'nothing is focused in the page — focus a field first (fill or click it), ' +
        'or pass text/selector to press' };
    }
    return { el: act };
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

  // ---- fill 的目标：**字段**，不是可点元素（2026-10-07 agent 实测反馈） ----
  //
  // 按 text 找输入框时，用户说的是「satoken 那个框」——它的标签 / name / id / placeholder，
  // 而文本候选池认的是**元素自己的文字**（输入框没有），于是落到 notFound、再列一份可点元素，
  // 跟要找的东西不是一类。判据与 browser_read 印的 label= 共用（fieldLabel.ts）。

  /** 一个字段能被叫出来的所有名字（read 里印得出来的都在这里）。 */
  function fieldNames(el) {
    var names = [fieldLabelOf(el)];
    var attrs = ['name', 'id', 'placeholder', 'aria-label'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(attrs[i]);
      if (v) names.push(fieldNorm(v));
    }
    return names;
  }

  /** 按名字找字段：精确池优先、包含池兜底（同 textPools 的去空白容错）。没有就回 null。 */
  function byField() {
    var found;
    try { found = document.querySelectorAll(TARGET.tag || FIELD_SELECTOR); } catch (e) { return null; }
    var want = String(TARGET.text), wantTight = tight(want);
    var exact = [], partial = [];
    for (var i = 0; i < found.length; i++) {
      var el = found[i];
      if (!visible(el)) continue;
      var names = fieldNames(el), hitExact = false, hitPartial = false;
      for (var j = 0; j < names.length; j++) {
        var n = names[j];
        if (!n) continue;
        var nt = tight(n);
        if (n === want || (wantTight && nt === wantTight)) { hitExact = true; break; }
        if (n.indexOf(want) >= 0 || (wantTight && nt.indexOf(wantTight) >= 0)) hitPartial = true;
      }
      if (hitExact) exact.push(el); else if (hitPartial) partial.push(el);
    }
    var pool = exact.length ? exact : partial;
    if (!pool.length) return null;
    var used = Math.min(TARGET.index || 0, pool.length - 1);
    return { el: pool[used], count: pool.length, used: used };
  }

  /**
   * fill 的解析：selector 照旧；text 先按**字段名**找，找不到再走通用文本解析——命中的是
   * label 时换成它关联的控件（点 label 本来就是聚焦它的那个框）。
   */
  function resolveField() {
    if (TARGET.selector || !TARGET.text) return resolve();
    var f = byField();
    if (f) return f;
    var r = resolve();
    if (r.el && r.el.tagName === 'LABEL' && r.el.control) r.el = r.el.control;
    if (r.error) {
      r.error = 'no form field is named ' + JSON.stringify(String(TARGET.text)) +
        ' (matched against label, name, id and placeholder)';
      r.candidates = null;
    }
    return r;
  }

  /** 字段的自述：describe 的形状，文字换成字段标签，另带 type / placeholder。 */
  function describeField(el) {
    var d = describe(el);
    d.text = fieldLabelOf(el).slice(0, 120);
    d.type = el.type ? String(el.type) : null;
    d.placeholder = (el.getAttribute && el.getAttribute('placeholder')) || null;
    return d;
  }

  /**
   * fill 解析失败：selector 歧义那份候选照旧（下一步是给 index）；其余一律列**页面上的字段**
   * ——可点元素清单对「找输入框」没有用。
   */
  function fieldFailure(err, extra) {
    if (extra && extra.candidatesKind === 'selector-matches') return failure(err, extra);
    var out = { ok: false, error: err, candidates: [], candidatesKind: 'fields' };
    try {
      var all = document.querySelectorAll(FIELD_SELECTOR);
      for (var i = 0; i < all.length && out.candidates.length < 15; i++) {
        if (visible(all[i])) out.candidates.push(describeField(all[i]));
      }
    } catch (e) { /* 候选只是锦上添花 */ }
    return out;
  }
`;
}

/**
 * 解析目标并**算好两套坐标**：视口中心的 `x`/`y`（点击用）与页面坐标矩形 `rect`（截图裁剪用）。
 * 返回值里带 `hit` 描述，让模型知道点到了什么。
 *
 * 坐标口径：先 `scrollIntoView({behavior:'instant'})`（**必须 instant**——smooth 是动画，
 * 同一次脚本执行里读到的 rect 会是滚动前的旧值），再读 `getBoundingClientRect()`。
 * 那个 rect 是**视口相对**坐标，正是 CDP `Input.dispatchMouseEvent` 要的口径；而
 * `Page.captureScreenshot` 的 `clip` 相对**文档原点**，所以要另加滚动偏移（脚本里的 `rect`）。
 *
 * `opts.scroll` 缺省 true（点击必须把元素滚进视口）。截图时传 `false`——**别动用户正在看的
 * 滚动位置**，裁剪靠 CDP 的 `captureBeyondViewport`。
 *
 * `matched` / `usedIndex` = 命中数与**钳制后**用的是第几个（`index` 越界会被 `Math.min` 换掉）。
 * 三个脚本（本函数 / `buildFillScript` / `buildClickFallbackScript`）**都带**这一对：调用方按它
 * 报数（act.ts 的 matchNote），少一处那条路的注脚就永远不出现。
 */
export function buildResolveScript(target: ActTarget, opts: { scroll?: boolean } = {}): string {
  return `(() => {${preamble(target)}
  try {
    var r = resolve();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    var SCROLL = ${opts.scroll === false ? "false" : "true"};
    if (SCROLL) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
      catch (e) { el.scrollIntoView(); }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, error: 'matched element has zero size (hidden or not laid out)', hit: describe(el) };
    }
    // 截图裁剪要**页面坐标**（CDP 的 Page.captureScreenshot 的 clip 相对文档原点，不是视口）。
    // 本文件是注入脚本的源码：注释里不许出现反引号（会撕开外层模板字面量，见 preamble 的约定）。
    var sx = window.pageXOffset || document.documentElement.scrollLeft || 0;
    var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
    // 未实测的假设：position:fixed 的元素没有文档位置，它在 captureBeyondViewport 展开出的
    // 虚拟视口里被画在哪里（顶部？原点？）我们**没有量过**，本式一律按"文档坐标 = 视口坐标 +
    // 滚动偏移"算。别照两种猜测里的任一种去改它（它们互相排斥，改错会把今天对的那半弄坏）；
    // 真机夹具（滚动页面上的固定对话框）归 Task 12 的验收清单。
    return {
      ok: true,
      hit: describe(el),
      matched: r.count,
      usedIndex: r.used,
      rect: { x: Math.round(rect.left + sx), y: Math.round(rect.top + sy),
              w: Math.round(rect.width), h: Math.round(rect.height) },
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  } catch (e) {
    return { ok: false, error: 'resolve failed: ' + String((e && e.message) || e) };
  }
})()`;
}

/**
 * 设值（`fill`）：置 value 并派发 `input` + `change`，然后**读回校验**。
 *
 * **两个事件都要派发**：Vue/React 受控组件靠 `input` 同步内部状态，而复选框/下拉/表单序列化
 * 靠 `change`。只派发一个会出现「看起来填上了，提交时是空的」。派发了哪两个由调用方写进结果
 * （模型据此判断要不要再补一次 `press`/聚焦事件），脚本自己只负责**如实回报**。
 *
 * **读回校验（2026-09-29 走查反馈）**：写了不等于落住。受控组件会把值改回去、file 输入框会
 * 静静吞掉赋值——只回报"我写了 X"就是假成功。这里写完读一次，对不上就如实失败，把读到的值
 * 报出来。判定口径按元素类型各算各的（<select> 比 option 的 value、勾选框比 checked）。
 *
 * **不是表单元素就拒绝**：旧实现对任何元素都 `el.value = VALUE`——在 contenteditable 这类元素上
 * 那是挂了个 expando 属性（页面毫无变化），却照样回 "Set … to …"。禁用/只读同理：页面不会收。
 */
export function buildFillScript(target: ActTarget, value: string): string {
  return `(() => {${preamble(target)}
  try {
    var r = resolveField();
    if (r.error) return fieldFailure(r.error, r);
    var el = r.el;
    var VALUE = ${JSON.stringify(value)};
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 非必需 */ }
    el.focus && el.focus();

    // 三块各一件事：落值（含拒绝）→ 派发事件 → 读回校验。want / readBack 是它们的接口。
    var want = null;
    var readBack = null;
${fillDispatchScript()}
${fillEventsScript()}
${fillVerifyScript()}
  } catch (e) {
    return { ok: false, error: 'fill failed: ' + String((e && e.message) || e) };
  }
})()`;
}

/**
 * 落值分派：先拒**写了也没用**的目标（禁用 / 只读 / file / 不是表单元素），再按类型落值。
 * 每种类型自己绑好 `want`（读回应当等于什么）与 `readBack`（怎么读）。
 */
function fillDispatchScript(): string {
  return `    if (el.disabled === true) {
      return { ok: false, error: 'the control is disabled — the page will not accept a value', hit: describe(el) };
    }
    if (el.readOnly === true) {
      return { ok: false, error: 'the control is read-only — if setting it programmatically is really ' +
        'what you mean, use browser_eval', hit: describe(el) };
    }
    var tag = el.tagName;
    if (tag === 'SELECT') {
${fillSelectBranch()}
    } else if (el.type === 'checkbox' || el.type === 'radio') {
${fillChoiceBranch()}
    } else if (tag === 'INPUT' && el.type === 'file') {
      return { ok: false, error: 'a file input cannot be filled from script — that is a browser ' +
        'security boundary, so drive the real picker instead', hit: describe(el) };
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
${fillTextBranch()}
    } else {
      return { ok: false, error: 'this element is not an input, textarea or select — it has no value ' +
        'to set (a contenteditable takes text through browser_eval, or click into it and press keys)',
        hit: describe(el) };
    }`;
}

/** 派发 `input` + `change`：Vue/React 受控组件靠前者同步内部状态，勾选/下拉/表单序列化靠后者。 */
function fillEventsScript(): string {
  return `    var evOpts = { bubbles: true, cancelable: true };
    try { el.dispatchEvent(new Event('input', evOpts)); } catch (e) { /* 老环境忽略 */ }
    try { el.dispatchEvent(new Event('change', evOpts)); } catch (e) { /* 老环境忽略 */ }`;
}

/** 读回校验 + 两个信封：读回对不上就是**失败**（把读到的值一并带出去，模型据此判断下一步）。 */
function fillVerifyScript(): string {
  return `    var got = readBack();
    if (got !== want) {
      return { ok: false, error: 'the element reads back ' + JSON.stringify(got) + ' after the write, ' +
        'not ' + JSON.stringify(want) + ' — a control or framework reverted or ignored it, so nothing ' +
        'was really set', hit: describe(el), events: ['input', 'change'] };
    }
    return { ok: true, hit: describe(el), value: el.value, want: want, events: ['input', 'change'],
             matched: r.count, usedIndex: r.used };`;
}

/** `<select>`：按 option 的 value 或可见文本落值；没有匹配项时把候选清单带出去。 */
function fillSelectBranch(): string {
  return `      var matched = null;
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
      want = String(matched.value);
      readBack = function () { return String(el.value); };`;
}

/** 勾选类：读回口径是 `checked`（它的 `value` 是提交值，不是勾没勾）。 */
function fillChoiceBranch(): string {
  return `      var checked = VALUE === 'true' || VALUE === 'checked' || VALUE === '1';
      if (el.checked !== checked) el.click();
      want = String(checked);
      readBack = function () { return String(el.checked === true); };`;
}

/** 文本类：写 value，读回口径就是它自己（受控组件改回去时两边就对不上）。 */
function fillTextBranch(): string {
  return `      el.value = VALUE;
      want = VALUE;
      readBack = function () { return String(el.value); };`;
}

/**
 * 按键的第一步：**确定键落在谁身上**（并把它聚焦），把命中的元素报回来。
 *
 * 为什么先要这一发：`Input.dispatchKeyEvent` 交给**页面当前焦点**，而"我以为光标在搜索框里"
 * 是这类工具最容易出的错位。先读一次、如实回报，错位当场可见；顺带把目标聚焦（要按键的字段
 * 常常还没被点过）。真实的键盘事件随后由 CDP 派发（见 `act.ts` 的 `performPress`）。
 */
export function buildFocusScript(target: ActTarget): string {
  return `(() => {${preamble(target)}
  try {
    var r = targetOrActive();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* 非必需 */ }
    try { el.focus && el.focus(); } catch (e) { /* 不可聚焦的元素照样可能挂着 document 级 handler */ }
    return { ok: true, hit: describe(el) };
  } catch (e) {
    return { ok: false, error: 'focus failed: ' + String((e && e.message) || e) };
  }
})()`;
}

/**
 * CDP 不可用时的按键兜底：合成 `keydown` / `keyup`。
 *
 * **不等价**（与点击的兜底同款纪律）：非 `isTrusted`、不会移动焦点、不产生字符——只对"自己监听
 * keydown"的页面有效。走这条路必须由调用方如实说明，不假装与真按键一样。
 */
export function buildKeyFallbackScript(
  target: ActTarget,
  key: string,
  code: string,
  modifiers: string[],
): string {
  const has = (m: string) => modifiers.some((x) => String(x).toLowerCase() === m);
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    code,
    ctrlKey: has("ctrl"),
    altKey: has("alt"),
    metaKey: has("meta"),
    shiftKey: has("shift"),
  };
  return `(() => {${preamble(target)}
  try {
    var r = targetOrActive();
    if (r.error) return failure(r.error, r);
    var el = r.el;
    try { el.focus && el.focus(); } catch (e) { /* 非必需 */ }
    var BASE = ${JSON.stringify(base)};
    var names = ['keydown', 'keyup'];
    for (var i = 0; i < names.length; i++) {
      var ev;
      try {
        ev = window.KeyboardEvent ? new window.KeyboardEvent(names[i], BASE)
                                  : new Event(names[i], BASE);
      } catch (e) { ev = new Event(names[i], BASE); }
      try { el.dispatchEvent(ev); } catch (e) { /* 派发不了也照样如实回报 */ }
    }
    return { ok: true, hit: describe(el) };
  } catch (e) {
    return { ok: false, error: 'key fallback failed: ' + String((e && e.message) || e) };
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
    return { ok: true, hit: describe(el), matched: r.count, usedIndex: r.used };
  } catch (e) {
    return { ok: false, error: 'click fallback failed: ' + String((e && e.message) || e) };
  }
})()`;
}

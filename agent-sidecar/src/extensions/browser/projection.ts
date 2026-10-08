/**
 * 通用页面骨架投影脚本（**站点无关**）——`browser_read` 的固定载荷。
 *
 * # 为什么住在这里（而不是 Rust / skill）
 *
 * - 放 Rust：投影脚本认识「表格 / 表单 / 按钮」，放内核就是让内核认识页面语义——违反
 *   「内核只提供机制（注入脚本→拿回 JSON），不认识用途」的红线；且改脚本要重编 Rust。
 * - 放 skill：skill 是**站点 know-how** 的家；通用骨架抽取器必须**没有任何 skill 时也能用**，
 *   两者生命周期不同。
 * - 放 sidecar 工具层（选定）：投影 = 机制（通用 DOM 骨架抽取），工具层就是机制的家。
 *   Rust 桥只收到一段不透明字符串——因此 `src-tauri/` 里 grep 任何站点名都恒为 0 命中。
 *
 * # 脚本契约
 *
 * 1. **返回对象而非 `JSON.stringify`**：`ExecuteScript` 自己会把返回值序列化成 JSON，
 *    再 stringify 一层就是双重编码（拿回来是个字符串，不是结构）。
 * 2. **信封 `{ok: true|false, ...}`**：页面脚本抛异常时 `ExecuteScript` 回 `null`，与
 *    「确实返回 null」不可区分——所以顶层 try/catch 必须自己兜住，把失败也变成信封。
 * 3. **零站点名词**：这个文件的任何一行都不许出现站点名/站点专属选择器。
 *    站点差异走 skill 的 reference 文件（数据），不进这里。
 *
 * # 两条筛选约定（都不是"猜"，都如实报数）
 *
 * - **可点元素 = 标记线索 ∪ 光标线索**：判据住在 `clickable.ts`（与 `actions.ts` 共用同一份，
 *   保证「read 里看得见的，act 就点得到」）。
 * - **默认只列渲染中的东西**：`display:none` 系的 popper / 隐藏面板是纯噪音，默认不列并回一行
 *   计数（`hiddenSkipped`）——**不静默丢**。原型页那种「一页叠好几个隐藏状态」需要它们，
 *   用 `include_hidden` 打开。
 *
 * # 已知边界（如实，不假装）
 *
 * - 跨域 iframe 只能给 `src`（`contentDocument` 拿不到），标 `sameOrigin: false`。
 * - `rowspan`/`colspan` 不展开：表格按 DOM 单元格矩阵给，合并单元格会错位。
 * - `password` 输入框的值**刻意不读**（红acted）——那是用户的凭据，不该进模型上下文。
 * - 可见性只看「有没有盒」：`visibility:hidden` / `opacity:0` 藏的东西仍会列出来（逐元素算样式太贵）。
 */
import { CLICKABLE_JS } from "./clickable.js";
import { FIELD_LABEL_JS } from "./fieldLabel.js";

/** 投影选项。 */
export interface ProjectionOptions {
  /**
   * `true` = 连隐藏的（`display:none` 系）表格/字段/可点元素一起列。
   * 缺省 false：隐藏的 popper 是噪音，但**计数会回报**，不会静默消失。
   */
  includeHidden?: boolean;
}

/** 一次投影的产出上限（保护模型上下文；触顶时 `truncated: true`）。 */
const LIMITS = {
  nodes: 1500,
  text: 300,
  rows: 60,
  cols: 40,
  headings: 80,
  clickables: 120,
  frames: 20,
  /** `cursor:pointer` 扫描的样式探针预算（`getComputedStyle` 逐元素，是这里最贵的一步）。 */
  styleProbes: 2000,
} as const;

/**
 * 通用页面骨架投影脚本。
 *
 * 注意：这是**注入进页面的 JS 源码字符串**，不是 TS。写的时候别用反引号或 `${}`——
 * 会把外层模板字面量撕开。同理正则里的反斜杠要按模板字面量规则转义。
 */
export function buildProjectionScript(opts: ProjectionOptions = {}): string {
  return `(() => {
  'use strict';

  var LIMITS = ${JSON.stringify(LIMITS)};
  var INCLUDE_HIDDEN = ${opts.includeHidden ? "true" : "false"};
  var budget = LIMITS.nodes;
  var truncated = false;

  function spend(n) {
    budget -= n;
    if (budget < 0) { truncated = true; return false; }
    return true;
  }

  function cut(s, n) {
    var t = (s === null || s === undefined ? '' : String(s)).replace(/\\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '\\u2026' : t;
  }
${CLICKABLE_JS}
  // ---- 标签关联（"这个框填什么"的唯一可靠答案；判据住在 fieldLabel.ts，与 fill 的字段查找共用） ----
${FIELD_LABEL_JS}
  function labelOf(el) { return cut(fieldLabelOf(el), LIMITS.text); }

  // ---- 表格 ----
  function tableOf(t) {
    var trs = Array.prototype.slice.call(t.querySelectorAll('tr'));
    var headers = null;
    var rows = [];
    for (var i = 0; i < trs.length && i < LIMITS.rows; i++) {
      var kids = Array.prototype.slice.call(trs[i].children).slice(0, LIMITS.cols);
      if (!kids.length) continue;
      var cells = kids.map(function (c) { return cut(c.textContent, LIMITS.text); });
      var allTh = kids.every(function (c) { return c.tagName === 'TH'; });
      if (allTh && headers === null) { headers = cells; continue; }
      rows.push(cells);
    }
    return {
      caption: t.caption ? cut(t.caption.textContent, LIMITS.text) : null,
      headers: headers,
      rows: rows
    };
  }

  // ---- 表单控件 ----
  function fieldOf(el) {
    var type = (el.type || '').toLowerCase();
    var f = {
      tag: el.tagName.toLowerCase(),
      type: type || null,
      name: el.name || null,
      label: labelOf(el),
      value: null,
      options: null,
      disabled: !!el.disabled,
      required: !!el.required
    };

    if (el.tagName === 'SELECT') {
      f.options = Array.prototype.slice.call(el.options).slice(0, LIMITS.cols).map(function (o) {
        return { text: cut(o.textContent, LIMITS.text), value: o.value, selected: !!o.selected };
      });
    } else if (type === 'password') {
      // 用户的凭据不进模型上下文——只报"这里有个已填/未填的密码框"。
      f.value = el.value ? '[redacted]' : '';
    } else if (type === 'checkbox' || type === 'radio') {
      f.value = el.checked ? 'checked' : 'unchecked';
    } else if (type === 'file') {
      f.value = el.files && el.files.length ? el.files.length + ' file(s)' : '';
    } else {
      f.value = cut(el.value, LIMITS.text);
    }
    return f;
  }

  /**
   * 老路：textContent（**含**隐藏内容），剥掉 script/style/noscript/template。
   * 只有两处用得上：include_hidden 打开时、以及拿不到 innerText 时的退路。
   */
  function plainText(doc) {
    try {
      var clone = doc.body ? doc.body.cloneNode(true) : null;
      if (!clone) return '';
      var junk = clone.querySelectorAll('script,style,noscript,template');
      for (var n = 0; n < junk.length; n++) {
        if (junk[n].parentNode) junk[n].parentNode.removeChild(junk[n]);
      }
      return String(clone.textContent || '');
    } catch (e) { return ''; }
  }

  /**
   * 正文文本。**默认只取渲染中的内容**（innerText 是浏览器自己的可见性感知 API——
   * 什么算可见交给浏览器自己判，就不可能与我们判得不一样）。
   *
   * ⚠️ 三条不许踩：
   * 1. 必须对**原文档**的 doc.body 取（innerText 依赖元素在文档中且有布局）；
   *    游离的 cloneNode(true) 上取会**退化**成 textContent 语义 —— 那是个"看着改了、
   *    实际没过滤"的假修复。
   * 2. include_hidden 打开时走老路（textContent，含隐藏内容）——开关与 skeleton 同义。
   * 3. 拿不到 innerText（老运行时 / 无 body）时**如实标** textFiltered = false 再退回老路，
   *    不假装过滤过了。
   */
  function projectText(doc) {
    var full = plainText(doc);
    if (INCLUDE_HIDDEN) return { text: cut(full, 20000), filtered: true };
    try {
      if (doc.body && typeof doc.body.innerText === 'string') {
        return { text: cut(doc.body.innerText, 20000), filtered: true };
      }
    } catch (e) { /* 落到底下如实标未过滤 */ }
    return { text: cut(full, 20000), filtered: false };
  }

  function project(doc) {
    var out = {};
    // 隐藏项计数**每份投影各算各的**（同源帧会递归投影，共用一份会串味）。
    var skipped = { tables: 0, fields: 0, clickables: 0, headings: 0 };
    /** 这个元素要不要因为"没在渲染"而跳过（默认跳，计数；include_hidden 时一律不跳）。 */
    function hidden(el, key) {
      if (INCLUDE_HIDDEN || isRendered(el)) return false;
      skipped[key]++;
      return true;
    }

    out.title = cut(doc.title, LIMITS.text);
    out.url = cut(doc.location && doc.location.href, 500);
    out.readyState = doc.readyState;

    // 大纲
    var hs = [];
    var hn = doc.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < hn.length && hs.length < LIMITS.headings; i++) {
      if (hidden(hn[i], 'headings')) continue;
      hs.push({ level: Number(hn[i].tagName.charAt(1)), text: cut(hn[i].textContent, LIMITS.text) });
    }
    out.headings = hs;

    // 表格
    out.tables = [];
    var ts = doc.querySelectorAll('table');
    for (var j = 0; j < ts.length; j++) {
      if (hidden(ts[j], 'tables')) continue;
      if (!spend(1)) break;
      out.tables.push(tableOf(ts[j]));
    }

    // 表单控件
    out.fields = [];
    var fs = doc.querySelectorAll('input,select,textarea');
    for (var k = 0; k < fs.length; k++) {
      var el = fs[k];
      var t = (el.type || '').toLowerCase();
      if (t === 'hidden') continue;
      if (hidden(el, 'fields')) continue;
      if (!spend(1)) break;
      out.fields.push(fieldOf(el));
    }

    // 可点元素（判据见 clickable.ts）：**标记线索 ∪ 光标线索**，agent 找"点哪里"的输入
    out.clickables = [];
    var taken = [];
    function collect(c) {
      if (out.clickables.length >= LIMITS.clickables) { truncated = true; return; }
      for (var i = 0; i < taken.length; i++) {
        // 祖先已入册：这个只是它的内容（同一目标的重复项，列出来是噪音）
        if (taken[i] === c || (taken[i].contains && taken[i].contains(c))) return;
      }
      if (hidden(c, 'clickables')) return;
      var text = cut(c.textContent, LIMITS.text) ||
        cut(c.value, LIMITS.text) ||
        cut(c.getAttribute && c.getAttribute('aria-label'), LIMITS.text) ||
        cut(c.getAttribute && c.getAttribute('title'), LIMITS.text);
      if (!text) return;
      taken.push(c);
      out.clickables.push({
        tag: c.tagName.toLowerCase(),
        text: text,
        href: c.getAttribute && c.getAttribute('href') ? cut(c.getAttribute('href'), 500) : null,
        disabled: !!c.disabled
      });
    }

    // ① 标记线索：便宜且精确，先跑
    var cs = doc.querySelectorAll(CLICKABLE_MARKUP);
    for (var m = 0; m < cs.length && out.clickables.length < LIMITS.clickables; m++) {
      collect(cs[m]);
    }

    // ② 光标线索：用 div/span 拼的按钮只在这一趟被认出来。逐元素 getComputedStyle 很贵，
    //    所以先剪枝（容器 / 没有名字的点它说不清点什么）、再限预算；预算耗尽**如实标 truncated**。
    var probes = LIMITS.styleProbes;
    var all = doc.querySelectorAll('*');
    for (var q = 0; q < all.length && probes > 0 && out.clickables.length < LIMITS.clickables; q++) {
      var e = all[q];
      if (e.children && e.children.length > 2) continue;
      var own = cut(e.textContent, 60) ||
        cut(e.getAttribute && (e.getAttribute('aria-label') || e.getAttribute('title')), 60);
      if (!own) continue;
      var inside = false;
      for (var w = 0; w < taken.length; w++) {
        if (taken[w].contains && taken[w].contains(e)) { inside = true; break; }
      }
      if (inside) continue;
      probes--;
      if (clickableByStyle(e)) collect(e);
    }
    if (probes <= 0) truncated = true;

    // 正文文本（默认只取渲染中的内容——判据见 projectText 的注释）
    var body = projectText(doc);
    out.text = body.text;
    out.textFiltered = body.filtered;

    // iframe 清单：同源递归抽取，跨域**只报 src**（如实，不假装读到了）
    out.frames = [];
    var ifr = doc.querySelectorAll('iframe');
    for (var p = 0; p < ifr.length && out.frames.length < LIMITS.frames; p++) {
      var f = ifr[p];
      // 用**解析后的绝对 URL**（f.src）而不是 getAttribute('src')：相对路径对调用方没用，
      // 而且下游按 URL 与 CDP 的帧表配对时，只有绝对形式能对上。
      var entry = { src: cut(f.src, 500), sameOrigin: false, content: null };
      try {
        var inner = f.contentDocument;
        if (inner && inner.body) {
          entry.sameOrigin = true;
          if (!truncated) entry.content = project(inner);
        }
      } catch (e) {
        // 跨域：保持 sameOrigin=false
      }
      out.frames.push(entry);
    }

    out.hiddenSkipped = skipped;
    return out;
  }

  try {
    var result = project(document);
    result.ok = true;
    result.truncated = truncated;
    return result;
  } catch (e) {
    return {
      ok: false,
      error: 'page projection failed: ' + String((e && e.message) || e),
      truncated: truncated
    };
  }
})()`;
}

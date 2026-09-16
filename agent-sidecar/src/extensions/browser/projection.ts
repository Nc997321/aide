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
 * # 已知边界（如实，不假装）
 *
 * - 跨域 iframe 只能给 `src`（`contentDocument` 拿不到），标 `sameOrigin: false`。
 * - `rowspan`/`colspan` 不展开：表格按 DOM 单元格矩阵给，合并单元格会错位。
 * - `password` 输入框的值**刻意不读**（红acted）——那是用户的凭据，不该进模型上下文。
 */

/** 一次投影的产出上限（保护模型上下文；触顶时 `truncated: true`）。 */
const LIMITS = {
  nodes: 1500,
  text: 300,
  rows: 60,
  cols: 40,
  headings: 80,
  clickables: 120,
  frames: 20,
} as const;

/**
 * 通用页面骨架投影脚本。
 *
 * 注意：这是**注入进页面的 JS 源码字符串**，不是 TS。写的时候别用反引号或 `${}`——
 * 会把外层模板字面量撕开。同理正则里的反斜杠要按模板字面量规则转义。
 */
export const PAGE_PROJECTION_SCRIPT = `(() => {
  'use strict';

  var LIMITS = ${JSON.stringify(LIMITS)};
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

  // ---- 标签关联（"这个框填什么"的唯一可靠答案） ----
  // 四级兜底，最后一级是**表格布局启发式**：国内企业后台大量用 <td>标签</td><td><input></td>
  // 而不用 label/for。这是通用启发式（任何表格布局页面都成立），不是站点适配。
  function labelOf(el) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return cut(aria, LIMITS.text);

    var id = el.id;
    if (id) {
      try {
        var lab = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return cut(lab.textContent, LIMITS.text);
      } catch (e) { /* CSS.escape 不支持则跳过这一级 */ }
    }

    try {
      var wrap = el.closest && el.closest('label');
      if (wrap) return cut(wrap.textContent, LIMITS.text);
    } catch (e) { /* ignore */ }

    try {
      var td = el.closest && el.closest('td,th');
      if (td && td.previousElementSibling) {
        return cut(td.previousElementSibling.textContent, LIMITS.text);
      }
    } catch (e) { /* ignore */ }

    var ph = el.getAttribute && el.getAttribute('placeholder');
    return ph ? cut(ph, LIMITS.text) : '';
  }

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

  function project(doc) {
    var out = {};

    out.title = cut(doc.title, LIMITS.text);
    out.url = cut(doc.location && doc.location.href, 500);
    out.readyState = doc.readyState;

    // 大纲
    var hs = [];
    var hn = doc.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < hn.length && hs.length < LIMITS.headings; i++) {
      hs.push({ level: Number(hn[i].tagName.charAt(1)), text: cut(hn[i].textContent, LIMITS.text) });
    }
    out.headings = hs;

    // 表格
    out.tables = [];
    var ts = doc.querySelectorAll('table');
    for (var j = 0; j < ts.length; j++) {
      if (!spend(1)) break;
      out.tables.push(tableOf(ts[j]));
    }

    // 表单控件
    out.fields = [];
    var fs = doc.querySelectorAll('input,select,textarea');
    for (var k = 0; k < fs.length; k++) {
      if (!spend(1)) break;
      var el = fs[k];
      var t = (el.type || '').toLowerCase();
      if (t === 'hidden') continue;
      out.fields.push(fieldOf(el));
    }

    // 可点元素（按钮 / 链接 / role=button）——agent 找"点哪里"的输入
    out.clickables = [];
    var cs = doc.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a[href]');
    for (var m = 0; m < cs.length && out.clickables.length < LIMITS.clickables; m++) {
      var c = cs[m];
      var text = cut(c.textContent, LIMITS.text) ||
        cut(c.value, LIMITS.text) ||
        cut(c.getAttribute && c.getAttribute('aria-label'), LIMITS.text);
      if (!text) continue;
      out.clickables.push({
        tag: c.tagName.toLowerCase(),
        text: text,
        href: c.getAttribute && c.getAttribute('href') ? cut(c.getAttribute('href'), 500) : null,
        disabled: !!c.disabled
      });
    }

    // 正文文本（剥掉 script/style/noscript）
    try {
      var clone = doc.body ? doc.body.cloneNode(true) : null;
      if (clone) {
        var junk = clone.querySelectorAll('script,style,noscript,template');
        for (var n = 0; n < junk.length; n++) {
          if (junk[n].parentNode) junk[n].parentNode.removeChild(junk[n]);
        }
        out.text = cut(clone.textContent, 20000);
      } else {
        out.text = '';
      }
    } catch (e) {
      out.text = '';
    }

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

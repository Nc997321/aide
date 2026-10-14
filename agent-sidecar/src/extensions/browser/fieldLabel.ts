/**
 * 「这个框叫什么」—— **注入脚本共用的字段标签判定**。
 *
 * 两个消费者内插同一份（同 `clickable.ts` 的理由：可发现性必须等于可操作性）：
 * `projection.ts`（`browser_read` 的 Form fields 里印的 `label=`）与 `actions.ts`
 * （`browser_act fill` 按 `text` 找字段、找不到时列出的字段候选）。read 里印出来的标签，
 * fill 就该能按它找到——两份判定各写一套，agent 会撞上「read 说它叫 satoken、fill 说没有
 * satoken」（2026-10-07 agent 实测反馈：最后靠读组件源码才拿到 `.cred input`）。
 *
 * # 五级兜底（顺序即优先级）
 *
 * aria-label → `<label for>` → 包裹它的 `<label>` → **表格布局启发式**（国内企业后台大量用
 * `<td>标签</td><td><input></td>` 而不用 label/for；通用启发式，不是站点适配）→ **相邻文本**
 * → placeholder。
 *
 * 相邻文本（2026-10-14 agent 实测：输入框旁边明明写着「设备编号」，只因不是 `<label for>` 关联，
 * 回的是 `(no label found)`，验收时"这是哪个字段"只能靠猜）：逐层向上找**只含这一个字段**的
 * 容器，取字段之前的文本。两道闸防认错——容器里一出现第二个字段就停（那段文本说不清是谁的），
 * 文本过长就停（那是段落，不是标签）。排在 placeholder 前面：placeholder 多是「请输入…」的提示语。
 *
 * # 为什么是字符串
 *
 * 这是**注入进页面的 JS 源码**。写的时候别用反引号或 `${}`（会撕开外层模板字面量），
 * 正则里的反斜杠按模板字面量规则转义。
 */

/** 可填写的表单控件（`type=hidden` 不算：页面上没有它，填它也不是用户能做的事）。 */
export const FIELD_SELECTOR = 'input:not([type="hidden"]),select,textarea';

/** 相邻文本兜底：最多向上找几层容器。表单库的「标签 + 控件」一般隔两三层包装。 */
const NEARBY_MAX_DEPTH = 4;
/** 相邻文本兜底：超过这个长度就不当标签（那是说明段落）。 */
const NEARBY_MAX_CHARS = 40;

/** 共享片段：`fieldLabelOf(el)` —— 空白折叠、**不截断**（截断是渲染方的事）。 */
export const FIELD_LABEL_JS = `
  var FIELD_SELECTOR = ${JSON.stringify(FIELD_SELECTOR)};
  var NEARBY_MAX_DEPTH = ${NEARBY_MAX_DEPTH};
  var NEARBY_MAX_CHARS = ${NEARBY_MAX_CHARS};

  function fieldNorm(s) {
    return (s === null || s === undefined ? '' : String(s)).replace(/\\s+/g, ' ').trim();
  }

  /** 同一父节点下、排在 node 之前（after 时为之后）的兄弟文本。 */
  function siblingText(node, after) {
    var parts = [];
    for (var s = after ? node.nextSibling : node.previousSibling; s; s = after ? s.nextSibling : s.previousSibling) {
      if (s.nodeType !== 1 && s.nodeType !== 3) continue;
      // 标题是在给一整块命名，不是在给这个框命名。
      if (s.nodeType === 1 && /^(SCRIPT|STYLE|H[1-6])$/.test(s.tagName)) continue;
      if (after) parts.push(s.textContent); else parts.unshift(s.textContent);
    }
    return fieldNorm(parts.join(' '));
  }

  /** 相邻文本：见文件头。勾选类控件的名字惯例写在**后面**，前面没有时才看后面。 */
  function nearbyLabel(el) {
    var trailing = /^(checkbox|radio)$/.test(String(el.type || ''));
    var node = el;
    for (var up = 0; up < NEARBY_MAX_DEPTH; up++) {
      var box = node.parentElement;
      if (!box || box.tagName === 'BODY' || box.tagName === 'HTML') return '';
      if (box.querySelectorAll(FIELD_SELECTOR).length !== 1) return '';
      var t = siblingText(node, false) || (trailing ? siblingText(node, true) : '');
      if (t) return t.length <= NEARBY_MAX_CHARS ? t : '';
      node = box;
    }
    return '';
  }

  function fieldLabelOf(el) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return fieldNorm(aria);

    var id = el.id;
    if (id) {
      try {
        var lab = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return fieldNorm(lab.textContent);
      } catch (e) { /* CSS.escape 不支持则跳过这一级 */ }
    }

    try {
      var wrap = el.closest && el.closest('label');
      if (wrap) return fieldNorm(wrap.textContent);
    } catch (e) { /* ignore */ }

    try {
      var td = el.closest && el.closest('td,th');
      if (td && td.previousElementSibling) return fieldNorm(td.previousElementSibling.textContent);
    } catch (e) { /* ignore */ }

    try {
      var near = nearbyLabel(el);
      if (near) return near;
    } catch (e) { /* ignore */ }

    var ph = el.getAttribute && el.getAttribute('placeholder');
    return ph ? fieldNorm(ph) : '';
  }
`;

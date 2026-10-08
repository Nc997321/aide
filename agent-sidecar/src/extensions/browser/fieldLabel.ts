/**
 * 「这个框叫什么」—— **注入脚本共用的字段标签判定**。
 *
 * 两个消费者内插同一份（同 `clickable.ts` 的理由：可发现性必须等于可操作性）：
 * `projection.ts`（`browser_read` 的 Form fields 里印的 `label=`）与 `actions.ts`
 * （`browser_act fill` 按 `text` 找字段、找不到时列出的字段候选）。read 里印出来的标签，
 * fill 就该能按它找到——两份判定各写一套，agent 会撞上「read 说它叫 satoken、fill 说没有
 * satoken」（2026-10-07 agent 实测反馈：最后靠读组件源码才拿到 `.cred input`）。
 *
 * # 四级兜底（顺序即优先级）
 *
 * aria-label → `<label for>` → 包裹它的 `<label>` → **表格布局启发式**（国内企业后台大量用
 * `<td>标签</td><td><input></td>` 而不用 label/for；通用启发式，不是站点适配）→ placeholder。
 *
 * # 为什么是字符串
 *
 * 这是**注入进页面的 JS 源码**。写的时候别用反引号或 `${}`（会撕开外层模板字面量），
 * 正则里的反斜杠按模板字面量规则转义。
 */

/** 可填写的表单控件（`type=hidden` 不算：页面上没有它，填它也不是用户能做的事）。 */
export const FIELD_SELECTOR = 'input:not([type="hidden"]),select,textarea';

/** 共享片段：`fieldLabelOf(el)` —— 空白折叠、**不截断**（截断是渲染方的事）。 */
export const FIELD_LABEL_JS = `
  var FIELD_SELECTOR = ${JSON.stringify(FIELD_SELECTOR)};

  function fieldNorm(s) {
    return (s === null || s === undefined ? '' : String(s)).replace(/\\s+/g, ' ').trim();
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

    var ph = el.getAttribute && el.getAttribute('placeholder');
    return ph ? fieldNorm(ph) : '';
  }
`;

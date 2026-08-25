/**
 * cmFlash —— 跳转定位后的「闪一下渐隐」行高亮扩展。
 *
 * 定位到目标行（或目标代码块多行）后，给这些行挂一个 `cm-flash-line` 装饰，
 * CSS animation 从高亮渐隐到透明；duration 到后由调用方 dispatch remove
 * effect 清装饰。StateField 管理临时装饰：add 加行装饰、remove 清空，装饰
 * 随文档改动 map（行号移动时高亮仍贴对行）。
 *
 * 分层：本文件只产 CodeMirror 扩展 + effect 定义，不管定时器/生命周期/颜色配比
 * （颜色用主题 token var(--aide-accent)，时长由调用方控制）。调用方（CodeEditor）
 * 负责 dispatch add/remove 与 timer 清理——扩展只提供装饰机制。
 */
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";

/** flash 高亮指令：add=true 时 line..line+count-1 挂高亮，add=false 清空全部。 */
export interface FlashSpec {
  /** 1-based 起始行（add=true 时有效） */
  line: number;
  /** 高亮行数（add=true 时有效） */
  count: number;
  /** true=加装饰 / false=清空（line、count 忽略） */
  add: boolean;
}

/** dispatch 此 effect 触发/清除 flash 装饰 */
export const flashEffect = StateEffect.define<FlashSpec>();

/** 装饰 StateField（导出仅供测试/高级用法取用，一般用 cmFlash() 整体接入）。 */
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashEffect)) continue;
      if (!e.value.add) {
        decos = Decoration.none;
        continue;
      }
      const doc = tr.state.doc;
      const start = Math.max(1, Math.min(e.value.line, doc.lines));
      const end = Math.min(doc.lines, start + Math.max(1, e.value.count) - 1);
      const add: Range<Decoration>[] = [];
      for (let n = start; n <= end; n++) {
        add.push(Decoration.line({ class: "cm-flash-line" }).range(doc.line(n).from));
      }
      decos = Decoration.set(add, true);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * cmFlash 扩展：StateField（装饰管理）+ baseTheme（行高亮渐隐样式）。
 * @keyframes + 颜色全走主题 token，主题切换自动生效；class 名 cm-flash-line 唯一。
 */
export function cmFlash(): Extension {
  return [
    flashField,
    EditorView.baseTheme({
      ".cm-flash-line": {
        animation: "aide-flash-line 1.5s ease-out",
      },
      "@keyframes aide-flash-line": {
        // 从 accent 半透明渐隐到透明；不覆盖 cm-activeLine（动画结束透明后后者自然显现）
        from: { backgroundColor: "color-mix(in srgb, var(--aide-accent) 38%, transparent)" },
        to: { backgroundColor: "transparent" },
      },
    }),
  ];
}
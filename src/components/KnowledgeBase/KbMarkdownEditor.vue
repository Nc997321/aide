<script setup lang="ts">
// 知识库正文编辑器：**单栏**，排版与阅读页同一套（同字号/行高/标题层级），
// 没有「左源码 + 右预览」的对照——对照是两份内容在抢注意力，写的时候只该看见一份。
//
// 做法是 CodeMirror 6 + markdown 语法高亮：标题按层级放大、粗体/斜体/引用/行内代码/
// 链接直接以成品样式呈现，Markdown 标记符（# * > ` []()）退成弱色但**不隐藏**——
// 隐藏标记需要「光标进出」的装饰状态机，图片 / 表格 / 原始 HTML 上都是坑，且改的是
// 用户的原文：宁可留着标记，也不让「看见的」与「存下的」对不上。
//
// 样式只引用 var(--aide-*)（CLAUDE.md：主题系统是配色唯一来源），HighlightStyle 产出
// 的是 class 规则，主题切换时变量自动生效，无需像代码编辑器那样重建扩展。
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
// minimalSetup = 历史 + 默认快捷键 + drawSelection（无行号 / 折叠 / 括号补全）。
// 不直接 import @codemirror/commands：它是 codemirror 元包的传递依赖，pnpm 下源码够不着。
import { minimalSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { FORMAT_ACTIONS, type FormatAction } from "./mdCommands";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** Ctrl/Cmd+S：只报意图，保存的前置条件（锁/标题）在父层 */
  save: [];
}>();

/** 标记程序性替换（父层改值回灌），不回流 v-model——否则 CM 的换行归一化会造成假 dirty。 */
const fromParent = Annotation.define<boolean>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;

const mdStyle = HighlightStyle.define([
  // 层级与阅读页 .kb-body 的 h1–h4 同值（KbDocumentView.vue）
  { tag: tags.heading1, fontSize: "22px", fontWeight: "600", color: "var(--aide-text-primary)" },
  { tag: tags.heading2, fontSize: "17px", fontWeight: "600", color: "var(--aide-text-primary)" },
  { tag: tags.heading3, fontSize: "15px", fontWeight: "600", color: "var(--aide-text-primary)" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600", color: "var(--aide-text-primary)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "var(--aide-text-muted)" },
  { tag: tags.quote, color: "var(--aide-text-muted)" },
  { tag: tags.monospace, fontFamily: "var(--aide-font-mono)", fontSize: "0.92em", color: "var(--aide-text-secondary)" },
  { tag: [tags.link, tags.url], color: "var(--aide-accent)" },
  // 标记符：弱化但保留（HeaderMark / EmphasisMark / QuoteMark / ListMark / CodeMark / LinkMark）
  { tag: tags.processingInstruction, color: "var(--aide-text-muted)", fontWeight: "400" },
  { tag: tags.contentSeparator, color: "var(--aide-text-muted)" },
]);

const theme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--aide-text-primary)",
    fontSize: "14px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    // base 主题在 .cm-scroller 上硬设 monospace，不覆盖的话正文会掉成等宽（见 CodeEditor.vue 同款注释）
    fontFamily: "inherit",
    lineHeight: "1.8",
    overflow: "visible",
  },
  ".cm-content": {
    padding: "0 0 25vh",
    // 页面是一张纸：点正文下面的空白也应落进编辑器
    minHeight: "50vh",
    caretColor: "var(--aide-text-primary)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--aide-text-primary)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--aide-selection-bg) !important",
  },
  ".cm-placeholder": { color: "var(--aide-text-muted)" },
});

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        minimalSetup,
        EditorView.lineWrapping,
        // gfm 基底：表格 / 删除线 / 任务列表，与阅读页 marked({gfm:true}) 对齐
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(mdStyle),
        placeholder("开始写…（支持 Markdown）"),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (emit("save"), true) },
          { key: "Mod-b", preventDefault: true, run: (v) => (FORMAT_ACTIONS.bold(v), true) },
          { key: "Mod-i", preventDefault: true, run: (v) => (FORMAT_ACTIONS.italic(v), true) },
          { key: "Mod-k", preventDefault: true, run: (v) => (FORMAT_ACTIONS.link(v), true) },
        ]),
        theme,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (u.transactions.some((t) => t.annotation(fromParent))) return;
          emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
  view.focus();
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

// 父层改值（目前只有初始化与失锁重取后的回灌）：与当前内容一致就不动，避免光标跳
watch(
  () => props.modelValue,
  (v) => {
    if (!view || v === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: v },
      annotations: fromParent.of(true),
    });
  },
);

function run(action: FormatAction): void {
  if (view) FORMAT_ACTIONS[action](view);
}

/** 工具条：不求全，只放写文档最常用的十个。其余照常手打 Markdown——存下去的永远是原文。 */
const TOOLS: { action: FormatAction; label: string; title: string; cls?: string }[] = [
  { action: "bold", label: "B", title: "加粗（Ctrl/Cmd+B）", cls: "b" },
  { action: "italic", label: "I", title: "斜体（Ctrl/Cmd+I）", cls: "i" },
  { action: "code", label: "<>", title: "行内代码", cls: "m" },
  { action: "link", label: "链接", title: "链接（Ctrl/Cmd+K）" },
  { action: "h2", label: "H2", title: "二级标题" },
  { action: "h3", label: "H3", title: "三级标题" },
  { action: "quote", label: "引用", title: "引用" },
  { action: "ul", label: "列表", title: "无序列表" },
  { action: "ol", label: "编号", title: "有序列表" },
  { action: "codeBlock", label: "代码块", title: "代码块" },
];

defineExpose({ focus: () => view?.focus() });
</script>

<template>
  <div class="kb-md-wrap">
    <!-- mousedown.prevent：点按钮不抢走编辑器的焦点与选区，命令才作用得上 -->
    <div class="kb-md-tools" role="toolbar" aria-label="格式">
      <button
        v-for="t in TOOLS"
        :key="t.action"
        type="button"
        class="kb-md-tool"
        :class="t.cls"
        :title="t.title"
        @mousedown.prevent
        @click="run(t.action)"
      >
        {{ t.label }}
      </button>
    </div>
    <div ref="host" class="kb-md-editor" @mousedown.self="view?.focus()" />
  </div>
</template>

<style scoped>
.kb-md-editor {
  min-height: 50vh;
  cursor: text;
}

/* 工具条钉在滚动区顶部；不透明底（与面板同色），否则正文会从它下面透出来 */
.kb-md-tools {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 0 10px;
  margin-bottom: 4px;
  background: var(--aide-bg-base);
  user-select: none;
}
.kb-md-tool {
  min-width: 28px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-md-tool:hover { color: var(--aide-text-primary); background: var(--aide-surface-hover); }
.kb-md-tool:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-md-tool.b { font-weight: 700; }
.kb-md-tool.i { font-style: italic; }
.kb-md-tool.m { font-family: var(--aide-font-mono); }
</style>

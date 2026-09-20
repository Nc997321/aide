<script setup lang="ts">
/**
 * 变更卡的静态 diff：**不建 CodeMirror**。
 *
 * 为什么要有它（2026-09-20 冻结取证）：对话里每个 Edit/Write 块默认展开、
 * 各挂一个 DiffViewer（CodeMirror merge 视图）。一屏几十张卡就是几十个编辑器，
 * 每张 ~180~250ms（含 60~180ms 强制同步布局）、~270 个节点——真机表现为切到
 * 编辑密集的会话后主线程连续饱和十几~二十几秒，冻结报告里那串 `import.then`
 * 长帧就是它们在 `await loadLanguageExtension` 之后构造编辑器。夹具实测
 * （docs/prototypes/_harness/freeze-repro-live）：40 张卡 13 个长帧 / 10762 节点，
 * 同样 40 个块换成非变更工具：0 长帧 / 322 节点。
 *
 * 换成本组件后每卡 ~40 节点、~1~3ms，配色与语法色一分不差（同一套 token +
 * diffThemes.ts 的三层 color-mix 配方），丢的只有编辑器级能力：gutter 色条
 * （并入行号列）、「上一处/下一处」跳转、并排↔单栏切换——要看完整编辑器，
 * 卡头的「打开 ↗」进文件查看器，那边仍是 CodeMirror。
 *
 * 渲染管线：diffRows（纯函数：行模型 + 行内变更段）→ highlightLines
 * （整段跑一次 hljs，再按行切开，跨行 token 不断色）→ applyTextMarks
 * （把变更段插回高亮 HTML）。三步各自单测，本组件只负责摆 DOM 与配色。
 */
import { computed } from "vue";
import type { DiffPair } from "../../types";
import { buildDiffRows } from "../../utils/diffRows";
import { applyTextMarks } from "../../utils/textMarks";
import { diffNotice } from "../../utils/diffNotice";
import { highlightLines } from "@aide/sdk/utils/highlight";
import { useSettings } from "../../composables/useSettings";

const props = withDefaults(
  defineProps<{
    pair: DiffPair;
    filePath: string;
    /** 片段在文件中的真实起始行（算出前不传 → 行号从 1） */
    firstLineNumber?: number;
  }>(),
  { firstLineNumber: undefined },
);

const { settings } = useSettings();

/** 不渲染内容的情形（太大 / 二进制 / 仅行尾不同）：与文件查看器同一判定。 */
const notice = computed(() => diffNotice(props.pair));

const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

/** 行号偏移：片段第 1 行在文件里的真实行号。 */
const lineOffset = computed(() => (props.firstLineNumber ?? 1) - 1);

interface RenderRow {
  kind: "ctx" | "del" | "add";
  no: number;
  /** 已高亮并按行内变更段切好的行 HTML */
  html: string;
}

const rows = computed<RenderRow[]>(() => {
  if (notice.value) return [];
  const { oldText, newText } = props.pair;
  const aLines = highlightLines(oldText, ext.value);
  const bLines = highlightLines(newText, ext.value);

  return buildDiffRows(oldText, newText).map((row) => {
    // del 行取旧侧高亮、add 行取新侧；ctx 两侧文本相同，取旧侧即可
    const which = row.kind === "add" ? bLines : aLines;
    const index = (row.kind === "add" ? row.bLine : row.aLine) ?? 1;
    return {
      kind: row.kind,
      no: index + lineOffset.value,
      html: applyTextMarks(which[index - 1] ?? "", row.marks, `sd-mark--${row.kind}`),
    };
  });
});
</script>

<template>
  <div
    class="sd"
    :style="{
      '--cm-font-size': `${settings.fontSize}px`,
      '--cm-font-family': settings.editorFontFamily,
    }"
  >
    <div v-if="notice" class="sd-notice">{{ notice }}</div>
    <div v-else class="sd-body">
      <div v-for="(row, i) in rows" :key="i" class="sd-row" :class="`sd-row--${row.kind}`">
        <span class="sd-no">{{ row.no }}</span>
        <span class="sd-sign">{{ row.kind === "add" ? "+" : row.kind === "del" ? "-" : "" }}</span>
        <!-- 内容来自 highlightLines + applyTextMarks：文本由 hljs 转义，
             类名由 hljs 产出，本组件不引入任何未转义文本 -->
        <span class="sd-code" v-html="row.html"></span>
      </div>
    </div>
  </div>
</template>

<!-- 非 scoped：v-html 生成的高亮 DOM 与行底 tint 需要全局规则命中 -->
<style>
.sd {
  height: 100%;
  overflow: auto;
  background: var(--aide-bg-deep);
  font-family: var(--cm-font-family);
  font-size: var(--cm-font-size);
  /* 三层 diff 结构（照抄 fileviewer/diffThemes.ts 的 color-mix 配方：
     行底 tint → 行内变更段 → 色条），全部从主题 token 现场派生 */
  --sd-add-line: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-success) 68%, var(--aide-text-muted)) 12%,
    transparent
  );
  --sd-del-line: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-danger) 68%, var(--aide-text-muted)) 13%,
    transparent
  );
  --sd-add-text: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-success) 68%, var(--aide-text-muted)) 34%,
    transparent
  );
  --sd-del-text: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-danger) 68%, var(--aide-text-muted)) 34%,
    transparent
  );
  --sd-add-gutter: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-success) 68%, var(--aide-text-muted)) 55%,
    transparent
  );
  --sd-del-gutter: color-mix(
    in srgb,
    color-mix(in oklch, var(--aide-danger) 68%, var(--aide-text-muted)) 55%,
    transparent
  );
}

.sd-notice {
  padding: 10px 12px;
  color: var(--aide-text-muted);
  font-size: 11px;
}

.sd-body {
  min-width: min-content;
}

.sd-row {
  display: grid;
  grid-template-columns: 46px 14px 1fr;
  white-space: pre;
  line-height: 1.6;
  color: var(--aide-text-secondary);
}

.sd-row--add {
  background: var(--sd-add-line);
}
.sd-row--del {
  background: var(--sd-del-line);
}

.sd-no {
  text-align: right;
  padding-right: 8px;
  color: var(--aide-text-muted);
  font-family: var(--cm-font-family);
  font-size: calc(var(--cm-font-size) - 1px);
  user-select: none;
  border-right: 1px solid var(--aide-border-subtle);
}
.sd-row--add .sd-no {
  background: var(--sd-add-gutter);
  color: var(--aide-text-primary);
}
.sd-row--del .sd-no {
  background: var(--sd-del-gutter);
  color: var(--aide-text-primary);
}

.sd-sign {
  text-align: center;
  user-select: none;
  color: var(--aide-text-muted);
}
.sd-row--add .sd-sign {
  color: var(--aide-success);
}
.sd-row--del .sd-sign {
  color: var(--aide-danger);
}

.sd-code {
  padding-left: 10px;
}

/* 行内变更段（同一行里逐段加深） */
.sd-mark--add {
  background: var(--sd-add-text);
  border-radius: 2px;
}
.sd-mark--del {
  background: var(--sd-del-text);
  border-radius: 2px;
}

/* 语法色：与 global.css 的代码块、FileWindow 的查看器同一套 token 配方 */
.sd .hljs-keyword,
.sd .hljs-selector-tag,
.sd .hljs-type,
.sd .hljs-meta-keyword {
  color: var(--aide-syntax-keyword);
}
.sd .hljs-string,
.sd .hljs-addition,
.sd .hljs-regexp {
  color: var(--aide-success);
}
.sd .hljs-number,
.sd .hljs-literal,
.sd .hljs-variable,
.sd .hljs-template-variable,
.sd .hljs-tag .hljs-attr {
  color: var(--aide-syntax-number);
}
.sd .hljs-comment,
.sd .hljs-quote {
  color: var(--aide-text-muted);
  font-style: italic;
}
.sd .hljs-title,
.sd .hljs-title.class_,
.sd .hljs-title.function_,
.sd .hljs-section,
.sd .hljs-meta,
.sd .hljs-attr,
.sd .hljs-attribute {
  color: var(--aide-accent);
}
.sd .hljs-built_in,
.sd .hljs-symbol,
.sd .hljs-name,
.sd .hljs-selector-id,
.sd .hljs-selector-class {
  color: var(--aide-info);
}
.sd .hljs-class .hljs-title,
.sd .hljs-title.class_.inherited__ {
  color: var(--aide-warning);
}
.sd .hljs-punctuation,
.sd .hljs-operator,
.sd .hljs-bracket {
  color: var(--aide-text-secondary);
}
</style>

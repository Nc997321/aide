<script setup lang="ts">
/**
 * 流式正文渲染（B「渐显波」）。
 *
 * 三种模式，只在前两种条件下才走新的分段路径——**任何拿不准的情况都退回
 * 整块渲染，与改动前逐字节一致**：
 *   - final：非流式块 → `renderMarkdown`（缓存 + 语法高亮）。与改前一致。
 *   - plain：流式但尾巴不可动画（超长段落 / 代码围栏 / 列表标题等块级标记）
 *           → `renderStreaming` 整块渲染。与改前一致。
 *   - split：前缀 `renderMarkdown` 定格不重渲 + 尾巴逐块淡入。
 *
 * 为什么必须拆成两个元素：尾巴的块要逐块动画，块就必须是**稳定存在的 DOM 节点**。
 * 整块 `v-html` 会在每个增量把 innerHTML 换掉，动画节点连根拔起、动画每帧从头
 * 开始，等于没有动画。
 *
 * 顺带减负：今天是每个增量全量重解析 markdown，拆完前缀只在跨段落时重渲一次。
 * 分段规则与降级判据全在 `@aide/sdk/utils/streamSplit`（纯函数，独立可测）。
 */
import { computed } from "vue";
import { renderMarkdown, renderStreaming } from "@/utils/markdown";
import { splitStreamingText, stripInlineMarks } from "@aide/sdk/utils/streamSplit";
import { useStreamChunks } from "@/composables/useStreamChunks";

const props = defineProps<{
  /** 正文全文（TextBlock.text）。 */
  text: string;
  /** 是否是该消息的流式尾块。 */
  streaming: boolean;
}>();

const split = computed(() => (props.streaming ? splitStreamingText(props.text) : null));

/** 定稿块：整块 renderMarkdown（缓存 + 语法高亮），与改动前完全一致。 */
const finalHtml = computed(() => (props.streaming ? "" : renderMarkdown(props.text)));

/** 已定稿前缀：`renderMarkdown` 按 text 缓存，同串零解析成本，代码块补齐高亮。 */
const frozenHtml = computed(() => {
  const frozen = split.value?.frozen;
  return frozen ? renderMarkdown(frozen) : "";
});

/** 不可动画的尾巴（超长段落 / 代码围栏 / 列表标题等块级标记）：走 `renderStreaming`
 *  保住 markdown 结构，只是不出波形。
 *
 *  关键：**绝不能退回「整段 renderStreaming」**。正文逐字流式之后，整段渲染 =
 *  每条 delta 全量重解析全文，正是 2026-08 那次 O(n²) 卡死的形状。分成「前缀
 *  （只在跨段落时渲一次）+ 尾巴（以段落为界，有界）」之后，每次重渲的范围被
 *  段落长度封顶。 */
const tailHtml = computed(() => {
  const s = split.value;
  return s && !s.tailAnimated ? renderStreaming(s.tail) : "";
});

/** 尾巴是否走 markdown 那一路。判据取**原文**而非渲染结果——marked 对空输入未必
 *  返回空串，拿渲染结果当 v-if 会在尾巴为空时留下一个空 div（白吃 8px 上边距）。 */
const hasPlainTail = computed(() => {
  const s = split.value;
  return Boolean(s && !s.tailAnimated && s.tail);
});

/** 尾巴纯文本（已藏起行内标记符号）。不可动画时恒为空，顺带清空块表。 */
const tailText = computed(() =>
  split.value?.tailAnimated ? stripInlineMarks(split.value.tail) : "",
);

/** 尾巴的逐块 span。`maxChunks: Infinity`——尾巴以段落为界，跨段落时整表重置，
 *  不需要按块数退役（退役/落定的机制见 useStreamChunks，思考块那边用得上）。 */
const { chunks } = useStreamChunks(tailText, { maxChunks: Infinity });
</script>

<template>
  <div class="msg-text">
    <template v-if="streaming">
      <div v-if="frozenHtml" class="msg-frozen" v-html="frozenHtml" />
      <!-- 尾巴二选一：可动画走逐块 span；否则整段 markdown（仍以段落为界） -->
      <div v-if="hasPlainTail" class="msg-tail" v-html="tailHtml" />
      <!-- v-else-if 而非 v-else：尾巴为空（正段刚以空行收尾）时不留空 div——
           空元素也会吃到 `div + .msg-tail` 的 8px 上边距，凭空多一段间距 -->
      <div v-else-if="chunks.length" class="msg-tail">
        <span
          v-for="(c, i) in chunks"
          :key="i"
          class="aide-wave-chunk"
          :style="{ animationDelay: c.delay + 'ms' }"
        >{{ c.text }}</span>
      </div>
    </template>
    <div v-else v-html="finalHtml" />
  </div>
</template>

<style scoped>
/* .aide-wave-chunk 的动画定义在 global.css（思考块共用，不能藏在 scoped 里）。 */

/* 前缀的末段 <p> 会被 global.css 的 `.msg-text p:last-child { margin-bottom: 0 }`
   归零——那条规则是给「整块正文的最后一段」用的，而这里后面还接着尾巴，得把下边距
   还回来，否则段落间距比单容器时少 8px（虚拟页靠实测行高记账，这种系统性偏差会累积）。
   其余块级元素（pre 6px / ul 4px / h 8px4px）不带 :last-child 归零，原样保留。
   还回来之后由相邻兄弟的外边距折叠自然得出间距，尾巴这边不需要再加 margin——加死值
   反而会在前缀以代码块/列表收尾时把 6px/4px 顶成 8px。
   8px 是与 `.msg-text p` 的 margin-bottom 对齐的字面量，两处一起改。 */
.msg-frozen > p:last-child {
  margin-bottom: 8px;
}
</style>

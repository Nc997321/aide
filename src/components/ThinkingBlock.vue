<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import type { TruncatedInfo } from "@/types/chat";
/** 主线程思考块——partial=on 时 sidecar 把 thinking_delta 逐字转发（流式），partial=off /
 *  历史回放走 thinking 整块。视觉对齐子代理 .sa-thinking（灰斜体小字 + agentAccent 色调），独立成
 *  组件与 ToolCallBlock / SubagentCallBlock 同级。
 *
 *  思考可能很长（实测上万字），用 details 原生折叠。流式期（streaming=true）默认展开看逐字
 *  生成，结束自动折叠；用户手动点一次后 userOverride 接管（用户意愿优先于流式默认）。
 *  落在 .msg-turn（铜书脊）里，不套独立卡片避免双层边条，只用 agentAccent 淡左边条区分正文。
 *  text 空时 sidecar 不发本组件，故此处 text 必非空。
 *
 *  性能红线（freeze-1788224842632 长任务环链坐实）：thinking delta 每条都会整段替换
 *  thinking-body 的文本节点，浏览器对全文重排版——overflow:hidden 只裁显示不省排版，
 *  长思考下「每条 delta 一次 O(全文) 全文档布局」= 主线程 230-550ms 连续长任务
 *  （切换回运行中的长会话时集中爆发）。故流式期渲染尾部窗口（streamingBody），钉底
 *  读数每帧合并一次（schedulePin）。 */
const props = defineProps<{ text: string; truncated?: TruncatedInfo; streaming?: boolean }>();

/** 流式渲染窗口（UTF-16 码元）：只在尾部保留这么多字符。选字符而非字节——
 *  排版成本的直接量纲是字形数（字符是它的直接代理）；且 JS 字符串没有 O(1) 的
 *  UTF-8 字节长，按字节窗口化需每条 delta 现算全文字节，等于把 O(n²) 从排版
 *  换到编码上。可见窗口只有 320px（≈十几行），逐字可见内容不受影响；
 *  头部「xx 字」计数始终显示全文真实长度。 */
const STREAM_TAIL_CHARS = 8000;

/** 用户是否手动 toggle 过——一旦操作，details 开合完全由用户决定，流式默认不再覆盖。 */
const userOverride = ref(false);
const userOpen = ref(false);
const open = computed(() => (userOverride.value ? userOpen.value : !!props.streaming));
const bodyRef = ref<HTMLDivElement | undefined>();

/** 流式期渲染体：超窗截尾（钉底可见的恰是尾部），前缀 … 指代溢出部分；
 *  非流式（含结束后）渲染全文——折叠态 details 子树不排版，全文布局只付一次。
 *  切点落在低代理上时右移一位，保住完整代理对（emoji 等），代价可容忍少 1 字符。 */
const streamingBody = computed(() => {
  if (!props.streaming || props.text.length <= STREAM_TAIL_CHARS) return props.text;
  const cut = props.text.length - STREAM_TAIL_CHARS;
  const code = props.text.charCodeAt(cut);
  const from = cut < props.text.length - 1 && code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut;
  return "…" + props.text.slice(from);
});

// 流式期：thinking-body 限高 320px + 钉底跟随（逐字增长时内部滚到底），让用户看到
// 最新生成的内容；否则视窗停在顶部，新内容在底部生成却看不到，需手动下拉内部滚动条。
// 结束后停止跟随，用户可自由上下滚看全文。
//
// 流式期 body 用 overflow:hidden 而非 auto（.thinking--streaming 类）——滚动陷阱根因：
// body 是嵌套滚动容器，思考上万字时内部滚动范围几千 px，滚轮落在其上会被整个吃掉
// （Chromium 只在嵌套容器滚到边界后才链式传给外层对话区），且 B 方案下思考 delta 结束
// → text 整块到达之间有长空窗，钉底已停、details 仍开，用户在块内上滚后所有向下滚轮
// 全被吞——对话定格在该轮位置。overflow:hidden 的盒子不是滚轮手势目标（滚轮直接穿透
// 链到对话区）但仍可编程滚动（钉底 scrollTop 赋值照常），流式期实时跟随模式下块内
// 手动滚动本就被钉底接管，不损失能力；流式结束/手动展开回到 overflow:auto 阅读模式。
/** 钉底帧句柄：非 null = 在途帧未消费（拒绝重复排程）。声明见
 *  .aide/design-notes/ThinkingBlock--schedulePin.md。 */
let pinnedHandle: (() => void) | null = null;

/** 思考块流式钉底的按帧合并器：把「思考正文滚到底」合并到每帧至多一次，
 *  同帧多条 delta 共享一次滚动定位（scrollHeight 读数强制排版，逐 delta 读
 *  等于逐 delta 付全文档布局）。测试环境（node/jsdom）可能无 rAF，退化 setTimeout。 */
function schedulePin(): void {
  if (!props.streaming || bodyRef.value === undefined || pinnedHandle !== null) return;
  if (typeof requestAnimationFrame !== "undefined") {
    const id = requestAnimationFrame(() => {
      pinnedHandle = null;
      if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
    });
    pinnedHandle = () => cancelAnimationFrame(id);
  } else {
    const id = setTimeout(() => {
      pinnedHandle = null;
      if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
    }, 16);
    pinnedHandle = () => clearTimeout(id);
  }
}
watch(() => props.text, schedulePin);
onUnmounted(() => {
  if (pinnedHandle !== null) {
    pinnedHandle();
    pinnedHandle = null;
  }
});
function onToggle(e: Event) {
  const target = e.target as HTMLDetailsElement;
  // 程序化 :open 变化也触发 toggle——此时 target.open 与 computed open 一致，不是
  // 用户操作，忽略；只有用户点击导致两者不一致时才接管（避免流式自动展开/折叠
  // 污染 userOverride，使结束折叠失效）。
  if (target.open === open.value) return;
  userOverride.value = true;
  userOpen.value = target.open;
}
</script>

<template>
  <details class="thinking" :class="{ 'thinking--streaming': streaming }" :open="open" @toggle="onToggle">
    <summary class="thinking-head">
      <span class="thinking-caret" aria-hidden="true"></span>
      <span class="thinking-label">思考</span>
      <span class="thinking-count">{{ truncated ? Math.round(truncated.originalBytes / 2) : text.length }} 字</span>
    </summary>
    <div ref="bodyRef" class="thinking-body">{{ streamingBody }}</div>
  </details>
</template>

<style scoped>
.thinking { margin: 2px 0; }

.thinking-head {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  padding: 2px 0;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.thinking-head::-webkit-details-marker { display: none; }

.thinking-caret {
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--aide-text-muted);
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.thinking[open] .thinking-caret { transform: rotate(90deg); }

.thinking-label { font-weight: 600; color: var(--aide-text-secondary); }
.thinking-count {
  font-size: 10.5px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}

.thinking-body {
  margin: 4px 0 6px;
  padding: 4px 10px;
  border-left: 2px solid color-mix(in srgb, var(--aide-agent-accent) 40%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
  white-space: pre-wrap;
  max-height: 320px;
  overflow: auto;
}

/* 流式期滚轮穿透：hidden 不是滚轮手势目标，滚轮直达对话区；钉底仍可编程滚动。
   详见组件头部注释（滚动陷阱根因）。阅读模式（非流式）保持 auto 原生内滚。 */
.thinking--streaming .thinking-body { overflow: hidden; }

@media (prefers-reduced-motion: reduce) {
  .thinking-caret { transition: none; }
}
</style>
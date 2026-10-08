<script setup lang="ts">
// 「本页目录」：文章右侧的一列，随滚动高亮当前章节，点击平滑跳转。
//
// 目录**读渲染出来的 DOM 标题**，不自己再解析一遍 Markdown：看到的就是列出的，
// 导入文档里的 `<h2 id>`（经 markdown.ts 白名单放行）与 `#` 标题自然同口径，
// 围栏代码块里的 `# 注释` 也不会混进来——没有第二份解析器要同步。
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  /** 渲染正文的容器（v-html 的那一层） */
  bodyEl: HTMLElement | null;
  /** 真正滚动的那一层（文章容器） */
  scrollEl: HTMLElement | null;
  /** 正文变化的指纹：它变了就重扫标题（v-html 重渲染会换掉所有节点） */
  rev: string;
}>();

interface Item {
  el: HTMLElement;
  level: number;
  text: string;
}

const items = ref<Item[]>([]);
const activeIdx = ref(0);

/** 只收 h1–h3：四级以下的标题放进目录是噪声，目录要短到一眼扫完。 */
function scan(): void {
  const root = props.bodyEl;
  if (!root) {
    items.value = [];
    return;
  }
  items.value = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3"))
    .map((el) => ({ el, level: Number(el.tagName[1]), text: (el.textContent ?? "").trim() }))
    .filter((it) => it.text !== "");
  syncActive();
}

/** 目录项缩进按「本篇出现的最高级」折算，而不是写死 h1 为 0：不少文档全篇只用 h2/h3。 */
const minLevel = computed(() => items.value.reduce((m, it) => Math.min(m, it.level), 6));

/** 当前章节 = 最后一个「顶边已越过阅读线」的标题；一个都没越过就是第一个。 */
const READ_LINE = 96;
function syncActive(): void {
  const sc = props.scrollEl;
  if (!sc || items.value.length === 0) {
    activeIdx.value = 0;
    return;
  }
  const top = sc.getBoundingClientRect().top;
  let idx = 0;
  items.value.forEach((it, i) => {
    if (it.el.getBoundingClientRect().top - top <= READ_LINE) idx = i;
  });
  // 滚到底：最后几节太短够不到阅读线，到底就算最后一节，否则末节永远点不亮
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) idx = items.value.length - 1;
  activeIdx.value = idx;
}

let raf = 0;
function onScroll(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    syncActive();
  });
}

let bound: HTMLElement | null = null;
function bind(): void {
  if (bound === props.scrollEl) return;
  bound?.removeEventListener("scroll", onScroll);
  bound = props.scrollEl;
  bound?.addEventListener("scroll", onScroll, { passive: true });
}

watch(
  () => [props.bodyEl, props.scrollEl, props.rev] as const,
  async () => {
    bind();
    await nextTick(); // v-html 在本轮更新里才换完节点
    scan();
  },
  { immediate: true, flush: "post" },
);

onBeforeUnmount(() => {
  bound?.removeEventListener("scroll", onScroll);
  if (raf) cancelAnimationFrame(raf);
});

function jump(it: Item, idx: number): void {
  activeIdx.value = idx; // 立即反馈：平滑滚动要几百毫秒，高亮不该等
  it.el.scrollIntoView({ behavior: "smooth", block: "start" });
}

const show = computed(() => items.value.length >= 2);
</script>

<template>
  <nav v-if="show" class="kb-outline" aria-label="本页目录">
    <div class="kb-outline-title">本页内容</div>
    <ul>
      <li v-for="(it, i) in items" :key="i">
        <button
          type="button"
          class="kb-outline-item"
          :class="{ on: i === activeIdx }"
          :style="{ paddingLeft: `${12 + (it.level - minLevel) * 12}px` }"
          :title="it.text"
          @click="jump(it, i)"
        >
          {{ it.text }}
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.kb-outline {
  flex: 0 0 216px;
  width: 216px;
  min-height: 0;
  overflow-y: auto;
  padding: 44px 16px 32px 8px;
  user-select: none;
}
.kb-outline-title {
  padding: 0 12px 10px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--aide-text-muted);
}
.kb-outline ul {
  margin: 0;
  padding: 0;
  list-style: none;
  /* 一条细线贯穿，当前项在线上压一段 accent——"你读到这儿了"的位置标记 */
  border-left: 1px solid var(--aide-border-subtle);
}
.kb-outline-item {
  position: relative;
  display: block;
  width: 100%;
  margin-left: -1px;
  padding-top: 5px;
  padding-bottom: 5px;
  padding-right: 8px;
  border: none;
  border-left: 1px solid transparent;
  background: none;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  color: var(--aide-text-muted);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--aide-ease-t), border-color var(--aide-ease-t);
}
.kb-outline-item:hover { color: var(--aide-text-primary); }
.kb-outline-item.on {
  color: var(--aide-text-primary);
  border-left-color: var(--aide-accent);
}
.kb-outline-item:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
</style>

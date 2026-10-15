<script setup lang="ts">
/**
 * 「LSP 补充」标记：grep 顺带作答这一次给模型附了什么（sidecar 广播的 `lsp_glance`）。
 *
 * 用户以前完全看不到这部分——LSP 有没有在帮忙、模型为什么突然知道某个函数在第几行，
 * 都无从得知。默认收起成一枚药丸，不占高度；点开列出每个名字的定义 / 引用，路径可点。
 * 内容与给模型的附注同源（同一个 hook 产出），只是换成中文、给人看的形状。
 */
import { computed, ref } from "vue";
import type { LspGlanceItem } from "@/types/chat";
import { useFileResolver } from "@/composables/useFileResolver";

const props = defineProps<{ items: LspGlanceItem[]; workspacePath?: string }>();

const open = ref(false);
const { openResolved } = useFileResolver();

const KIND_ZH: Record<string, string> = {
  function: "函数",
  method: "方法",
  class: "类",
  struct: "结构体",
  interface: "接口",
  enum: "枚举",
};
const kindZh = (k: string) => KIND_ZH[k] ?? (k && k !== "symbol" ? k : "");

const label = computed(() => {
  const full = props.items.find((i) => i.kind !== "summary");
  const tail = full?.kind === "definition" ? " · 附函数体" : full?.kind === "references" ? " · 附引用列表" : "";
  return `LSP 补充 · ${props.items.length} 个符号${tail}`;
});

function span(line: number, endLine?: number): string {
  return endLine && endLine > line ? `${line}–${endLine}` : `${line}`;
}

function go(file: string, line: number) {
  void openResolved(file, props.workspacePath, line);
}
</script>

<template>
  <div class="lg">
    <button
      type="button"
      class="lg-pill"
      :aria-expanded="open"
      v-tooltip="'语言服务器对这次搜索里的标识符给出的编译器级答案（已一并交给 agent）'"
      @click="open = !open"
    >
      {{ label }}
    </button>
    <ul v-if="open" class="lg-list">
      <li v-for="it in items" :key="it.kind + it.name" class="lg-item">
        <code class="lg-name">{{ it.name }}</code>

        <template v-if="it.kind === 'summary'">
          <template v-if="it.ambiguous">
            <span class="lg-meta">有 {{ it.ambiguous }} 个同名</span>
          </template>
          <span v-for="d in it.defs" :key="d.file + d.line" class="lg-def">
            <span v-if="kindZh(d.kind)" class="lg-meta">{{ kindZh(d.kind) }}</span>
            <a class="lg-path" @click="go(d.file, d.line)">{{ d.file }}:{{ span(d.line, d.endLine) }}</a>
          </span>
          <span v-if="it.refCount !== undefined" class="lg-meta">
            {{ it.refCount === 0 ? "没有任何引用（已确认）" : `${it.refCount} 处引用（${it.refFiles} 个文件）` }}
          </span>
        </template>

        <template v-else-if="it.kind === 'definition'">
          <span v-if="kindZh(it.symbolKind)" class="lg-meta">{{ kindZh(it.symbolKind) }}</span>
          <a class="lg-path" @click="go(it.file, it.line)">{{ it.file }}:{{ span(it.line, it.endLine) }}</a>
          <span class="lg-meta">已附函数体</span>
        </template>

        <template v-else>
          <span class="lg-meta">
            {{ it.total }} 处引用{{ it.shown.length < it.total ? `（附了前 ${it.shown.length} 条）` : "" }}
          </span>
          <ul class="lg-refs">
            <li v-for="r in it.shown" :key="r.file + r.line">
              <a class="lg-path" @click="go(r.file, r.line)">{{ r.file }}:{{ r.line }}</a>
              <span v-if="r.enclosing" class="lg-meta">在 {{ r.enclosing }}</span>
            </li>
          </ul>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lg {
  padding: 2px 10px 6px 26px;
  font-size: 11px;
}

.lg-pill {
  font-size: 10.5px;
  font-family: inherit;
  padding: 1px 8px;
  border-radius: 999px;
  cursor: pointer;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
}

.lg-pill:hover {
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
}

.lg-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lg-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  color: var(--aide-text-secondary);
}

.lg-name {
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
}

.lg-def {
  display: inline-flex;
  gap: 4px;
}

.lg-meta {
  color: var(--aide-text-muted);
}

.lg-path {
  font-family: var(--aide-font-mono);
  color: var(--aide-accent);
  cursor: pointer;
}

.lg-path:hover {
  text-decoration: underline;
}

.lg-refs {
  list-style: none;
  width: 100%;
  margin: 2px 0 0;
  padding: 0 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lg-refs li {
  display: flex;
  gap: 8px;
}
</style>

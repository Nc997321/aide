<script setup lang="ts">
// 文档头部的「关联项目」一行：用 AI 改这篇文档时，它能只读地参考哪些项目的记忆。
//
// 显示的是**生效**的关联：自己直接打的（可 × 摘掉）+ 从祖先文件夹继承来的（淡色、不能在这里摘，
// 注明来源）。关联到的工作区已经不在了，标成警示而不是悄悄丢掉——否则 AI 少了一份上下文，用户不知道。
// 不关联时 AI 只带「日常」记忆。
import { computed } from "vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { kbLinkMenuItems } from "@/menus/contextMenus";
import { effectiveLinks, useKbLinks } from "@/composables/useKbLinks";

const props = defineProps<{
  nodeId: string;
  /** 祖先链，**从根到父**（与面包屑同序）。继承按「最近的先」，所以内部会反过来用。 */
  crumbs: { id: string; title: string }[];
}>();

const { show: showMenu } = useContextMenu();
const links = useKbLinks();
void links.load();

const nearestFirst = computed(() => [...props.crumbs].reverse());
const chips = computed(() =>
  effectiveLinks(links.table.value, props.nodeId, nearestFirst.value.map((c) => c.id)).map((l) => {
    const p = links.resolve(l.key);
    const from = l.from === "direct" ? null : (props.crumbs.find((c) => c.id === l.from)?.title ?? "上层文件夹");
    return { ...p, from };
  }),
);

function openPicker(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const titleOf = (id: string) => props.crumbs.find((c) => c.id === id)?.title ?? "上层文件夹";
  const projects = links.menuProjects(props.nodeId, nearestFirst.value.map((c) => c.id), titleOf);
  showMenu(r.left, r.bottom + 2, kbLinkMenuItems(projects, (key) => void links.toggle(props.nodeId, key)));
}
</script>

<template>
  <div class="kb-linked" role="group" aria-label="关联项目">
    <span class="kb-linked-lead" title="用 AI 改这篇文档时，会只读地参考这些项目的记忆。不关联就只带日常记忆。">关联项目</span>
    <span
      v-for="c in chips"
      :key="c.key"
      class="kb-linked-chip"
      :class="{ 'kb-linked-chip--inherited': c.from, 'kb-linked-chip--missing': c.missing }"
      :title="c.missing ? '这个项目已不在工作区列表里，AI 读不到它的记忆' : c.from ? `继承自文件夹「${c.from}」，要取消请在那个文件夹上改` : c.path"
    >
      {{ c.label }}<template v-if="c.missing">（已不在）</template><template v-else-if="c.from">（来自「{{ c.from }}」）</template>
      <button
        v-if="!c.from"
        type="button"
        class="kb-linked-x"
        :aria-label="`不再关联 ${c.label}`"
        @click="links.toggle(nodeId, c.key)"
      >×</button>
    </span>
    <button type="button" class="kb-linked-add" @click="openPicker">{{ chips.length ? "＋" : "＋ 关联项目" }}</button>
  </div>
</template>

<style scoped>
.kb-linked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11.5px;
}
.kb-linked-lead {
  color: var(--aide-text-muted);
  margin-right: 2px;
}
.kb-linked-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 9px;
  border-radius: 10px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 28%, transparent);
}
.kb-linked-chip--inherited {
  padding-right: 9px;
  color: var(--aide-text-secondary);
  background: transparent;
  border-style: dashed;
  border-color: var(--aide-border);
}
.kb-linked-chip--missing {
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border-color: color-mix(in srgb, var(--aide-warning) 40%, transparent);
}
.kb-linked-x {
  appearance: none;
  border: 0;
  background: none;
  padding: 0 4px;
  font: inherit;
  line-height: 1.2;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
}
.kb-linked-x:hover { opacity: 1; }
.kb-linked-add {
  appearance: none;
  border: 1px dashed var(--aide-border);
  background: none;
  padding: 1px 9px;
  border-radius: 10px;
  font: inherit;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t), border-color var(--aide-ease-t);
}
.kb-linked-add:hover {
  color: var(--aide-accent);
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
}
.kb-linked-x:focus-visible,
.kb-linked-add:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
</style>

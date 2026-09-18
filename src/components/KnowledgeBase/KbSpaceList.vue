<script setup lang="ts">
// 空间列表：侧栏里「空间」那一段。
//
// 之前「创建空间」埋在成员管理页里，与「空间」这个一级概念不匹配——建空间的人
// 得先想到去成员页，而成员页是管理员才看得到的入口。现在创建与重命名都在这里。
//
// 行语法与 ./KbTree 一致（名字占满、副信息在右、⋯ 悬停浮出）。**没有复用同一个
// 组件**：空间没有层级、没有 kind，多出 key/可见性/角色三个字段，操作集也不同
//（只有重命名）。硬凑成一个组件只会让两边都长出对方的分支。
import { ref } from "vue";
import Icon from "@/components/Icon.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { useModal } from "@/composables/useModal";
import { kbSpaceMenuItems } from "@/menus/contextMenus";
import KbSpaceForm from "./KbSpaceForm.vue";
import type { KbSpace } from "./kbClient";

const { show: showMenu } = useContextMenu();
const modal = useModal();

const props = defineProps<{
  spaces: KbSpace[];
  activeId: string | null;
  busy: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  create: [key: string, name: string, visibility: "private" | "internal" | "public"];
  rename: [id: string, name: string];
}>();

/** 正在重命名的空间 id 与草稿。就地改名与树里是同一套，所以留在组件内。 */
const renaming = ref<string | null>(null);
const renameDraft = ref("");

/**
 * ⋯ 菜单走应用统一的 `ContextMenu`（Teleport 到 body + fixed + 视口边缘翻转）。
 * 侧栏的段落是 `overflow: auto` 的，行内绝对定位的浮层会被容器裁掉。
 */
function openMenu(e: MouseEvent, space: KbSpace): void {
  const at = e.currentTarget as HTMLElement;
  const r = at.getBoundingClientRect();
  showMenu(r.right, r.bottom + 2, kbSpaceMenuItems(() => startRename(space)));
}

function startRename(space: KbSpace): void {
  renaming.value = space.id;
  renameDraft.value = space.name;
}

function commitRename(): void {
  const id = renaming.value;
  if (!id) return;
  const name = renameDraft.value.trim();
  // 空名字直接取消：服务端也会拒，没必要为此跑一趟
  if (name) emit("rename", id, name);
  renaming.value = null;
}

/**
 * 新建空间走应用统一的对话框（`ModalDialog` 的 custom 模式）。
 *
 * 不用侧栏里的浮层：三个字段在 220px 里塞不下，而且浮层会被 `overflow: auto`
 * 的段落裁掉——实际表现就是只露出下半截。
 */
async function startCreate(): Promise<void> {
  const payload = await modal.custom<{
    key: string;
    name: string;
    visibility: "private" | "internal" | "public";
  }>({
    title: "新建空间",
    component: KbSpaceForm,
    width: "sm",
  });
  if (!payload) return; // 取消
  emit("create", payload.key, payload.name, payload.visibility);
}

/** 父层用 expose 调用（分组标题旁的 + 在父层模板里）。 */
defineExpose({ startCreate });

// 输入框挂载即聚焦
const vFocus = {
  mounted: (el: HTMLElement) => (el as HTMLInputElement).focus(),
};
</script>

<template>
  <div class="kb-spaces">
    <div
      v-for="s in props.spaces"
      :key="s.id"
      class="kb-spacerow"
      :class="{ on: s.id === props.activeId }"
      :data-space="s.id"
    >
      <input
        v-if="renaming === s.id"
        data-space-rename
        v-model="renameDraft"
        class="kb-inline-input"
        v-focus
        @keydown.enter="commitRename"
        @keydown.esc="renaming = null"
        @blur="commitRename"
      />
      <span v-else data-space-label class="kb-space-name" @click="emit('select', s.id)">
        {{ s.name }}
      </span>

      <!-- 角色**常驻**：不操作时也要知道自己在各空间里是什么身份。
           悬停时让位给 ⋯（见样式里的 :hover 规则）。 -->
      <span class="kb-space-role">{{ s.role ?? "—" }}</span>

      <span class="kb-row-actions">
        <button class="kb-rowbtn" data-kb-more title="更多" @click.stop="openMenu($event, s)">
          <Icon name="more" :size="11" />
        </button>
      </span>
    </div>

    <p v-if="props.spaces.length === 0" class="kb-none">还没有可见的空间</p>
  </div>
</template>

<style scoped>
.kb-spaces {
  position: relative;
}

.kb-spacerow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  cursor: pointer;
}
.kb-spacerow:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.kb-spacerow.on {
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
  color: var(--aide-text-primary);
}

.kb-space-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-space-role { flex: 0 0 auto; font-size: 10px; opacity: 0.55; }

.kb-row-actions {
  position: absolute;
  right: 4px;
  display: flex;
  opacity: 0;
  transition: opacity var(--aide-ease-t, 0.16s ease);
}

.kb-rowbtn {
  border: none;
  background: none;
  padding: 2px;
  display: inline-flex;
  color: var(--aide-text-muted);
  cursor: pointer;
  border-radius: 4px;
}
.kb-rowbtn:hover { color: var(--aide-text-primary); background: var(--aide-surface-active); }

.kb-inline-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 20px;
  padding: 0 5px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-accent);
  border-radius: 4px;
  outline: none;
}

.kb-none {
  margin: 4px 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
</style>

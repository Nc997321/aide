<script setup lang="ts">
// 空间列表：侧栏里「空间」那一段。
//
// 之前「创建空间」埋在成员管理页里，与「空间」这个一级概念不匹配——建空间的人
// 得先想到去成员页，而成员页是管理员才看得到的入口。现在创建与重命名都在这里。
//
// 行语法与 ./KbTree 一致（名字占满、副信息在右、⋯ 悬停浮出）。**没有复用同一个
// 组件**：空间没有层级、没有 kind，多出 key/可见性/角色三个字段，操作集也不同
//（只有重命名）。硬凑成一个组件只会让两边都长出对方的分支。
import { computed, ref } from "vue";
import Icon from "@/components/Icon.vue";
import type { KbSpace } from "./kbClient";

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

/** 当前打开 ⋯ 菜单的空间 id */
const menuFor = ref<string | null>(null);
/** 正在重命名的空间 id 与草稿 */
const renaming = ref<string | null>(null);
const renameDraft = ref("");
/** 新建浮层是否打开 */
const creating = ref(false);
const draftKey = ref("");
const draftName = ref("");
const draftVisibility = ref<"private" | "internal" | "public">("internal");

/**
 * 标识的合法性，与后端 `spaces.rs::validate_key` 同规则。
 *
 * **只为省一次必然失败的往返**，服务端仍是唯一权威——规则若哪天变了，
 * 这里不同步的后果只是「客户端放过去、服务端 400」，不是数据损坏。
 */
const KEY_RE = /^[a-z0-9-]{2,40}$/;

const canCreate = computed(
  () => KEY_RE.test(draftKey.value) && draftName.value.trim() !== "" && !props.busy,
);

function startRename(space: KbSpace): void {
  menuFor.value = null;
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

function startCreate(): void {
  menuFor.value = null;
  creating.value = true;
  draftKey.value = "";
  draftName.value = "";
  draftVisibility.value = "internal";
}

function commitCreate(): void {
  if (!canCreate.value) return;
  emit("create", draftKey.value.trim(), draftName.value.trim(), draftVisibility.value);
  creating.value = false;
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
      :class="{ on: s.id === props.activeId, 'menu-open': menuFor === s.id }"
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
           悬停时让位给 ⋯（见样式里的 .menu-open 规则）。 -->
      <span class="kb-space-role">{{ s.role ?? "—" }}</span>

      <span class="kb-row-actions">
        <button
          class="kb-rowbtn"
          data-kb-more
          title="更多"
          @click.stop="menuFor = menuFor === s.id ? null : s.id"
        >
          <Icon name="more" :size="11" />
        </button>
      </span>

      <div v-if="menuFor === s.id" data-kb-menu class="kb-menu">
        <!-- 只有重命名。key 改了会断链、可见性改动面太大，都不放进这个入口 -->
        <button @click="startRename(s)">重命名</button>
      </div>
    </div>

    <p v-if="props.spaces.length === 0" class="kb-none">还没有可见的空间</p>

    <!-- 220px 塞不下「标识/名称/可见性」三个字段，所以 + 开的是浮层 -->
    <div v-if="creating" data-space-form class="kb-popover">
      <h4>新建空间</h4>
      <label>标识（小写字母/数字/-，建后不可改）</label>
      <input v-model="draftKey" class="kb-field" spellcheck="false" placeholder="eng-handbook" v-focus />
      <label>名称</label>
      <input v-model="draftName" class="kb-field" placeholder="工程手册" />
      <label>可见性</label>
      <select v-model="draftVisibility" class="kb-field">
        <option value="private">私有（仅成员可见）</option>
        <option value="internal">内部（登录可见）</option>
        <option value="public">公开（所有人可读）</option>
      </select>
      <div class="kb-form-actions">
        <button class="kb-btn" @click="creating = false">取消</button>
        <button class="kb-btn primary" data-space-submit :disabled="!canCreate" @click="commitCreate">
          创建
        </button>
      </div>
    </div>
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
.kb-spacerow.menu-open { background: var(--aide-surface-hover); }

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
.kb-spacerow:hover .kb-row-actions,
.kb-spacerow.menu-open .kb-row-actions { opacity: 1; }

/* ⚠️ `.menu-open` 必须与 `:hover` 同规则：菜单一打开，鼠标就移到菜单上了，
   行本身不再是 :hover——只写 :hover 的话角色会冒回来跟 ⋯ 叠住。 */
.kb-spacerow:hover .kb-space-role,
.kb-spacerow.menu-open .kb-space-role { visibility: hidden; }

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

.kb-menu {
  position: absolute;
  right: 4px;
  top: 26px;
  z-index: 20;
  min-width: 120px;
  padding: 4px;
  background: rgba(20, 22, 32, 0.96);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm, 8px);
  box-shadow: var(--aide-shadow-md);
}
.kb-menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 6px 8px;
  border-radius: 4px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-secondary);
  cursor: pointer;
}
.kb-menu button:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }

.kb-popover {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  z-index: 30;
  padding: 10px;
  background: rgba(20, 22, 32, 0.97);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm, 8px);
  box-shadow: var(--aide-shadow-md);
}
.kb-popover h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--aide-text-secondary);
}
.kb-popover label {
  display: block;
  font-size: 10px;
  color: var(--aide-text-muted);
  margin: 0 0 3px;
}
.kb-field {
  width: 100%;
  height: 26px;
  margin-bottom: 8px;
  padding: 0 7px;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 5px;
  outline: none;
}
.kb-field:focus { border-color: var(--aide-accent); }

.kb-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.kb-btn {
  padding: 5px 10px;
  font: inherit;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--aide-border);
  background: none;
  color: var(--aide-text-secondary);
  cursor: pointer;
}
.kb-btn:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.kb-btn.primary {
  border-color: transparent;
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  font-weight: 500;
}
.kb-btn.primary:disabled { opacity: 0.45; cursor: default; }

.kb-none {
  margin: 4px 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
</style>

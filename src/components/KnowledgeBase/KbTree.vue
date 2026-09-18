<script setup lang="ts">
// 知识库目录树。
//
// 单层 v-for 渲染 `flatten()` 的结果——**不递归组件**：扁平行的缩进更自然，
// 深层树下也不会有意料之外的更新开销。
//
// 树的算法全在 ./docTree（唯一产地：排序、孤儿提升、成环保护、子树计数）。
// 本组件只做渲染与交互，不自己算层级，也不碰传输层。
//
// **受控组件**：折叠状态由父层持有（只有父层知道 localStorage 与当前空间），
// 这里只读 `collapsed` 并向上发 `toggle`。所以「点击后子树消失」不是本组件的
// 行为，测试要分两条写（点击发事件 / 给了折叠集合就不渲染）。
import { computed, ref } from "vue";
import Icon from "@/components/Icon.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { kbCreateItems, kbMoveMenuItems, kbNodeMenuItems } from "@/menus/contextMenus";
import { buildTree, flatten, type KbTreeNode } from "./docTree";
import type { KbDocumentSummary } from "./kbClient";

const { show: showMenu } = useContextMenu();

const props = defineProps<{
  documents: KbDocumentSummary[];
  activeId: string | null;
  /** 被折叠的节点 id。由父层给（只有它知道当前空间与 localStorage）。 */
  collapsed: ReadonlySet<string>;
  busy: boolean;
}>();

const emit = defineEmits<{
  open: [id: string];
  toggle: [id: string];
  /** 新建：父文件夹 id（null = 根）、类型、标题（标题在内联输入里收集，一起交出去） */
  create: [parentId: string | null, kind: "doc" | "folder", title: string];
  patch: [id: string, input: { title?: string; parentId?: string | null }];
  remove: [id: string];
}>();

/** 树容器。只用于 scrollToNode 里查 DOM。 */
const root = ref<HTMLElement | null>(null);

const tree = computed<KbTreeNode[]>(() => buildTree(props.documents));
const rows = computed(() => flatten(tree.value, props.collapsed));

/** 正在重命名的节点 id 与草稿 */
const renaming = ref<string | null>(null);
const renameDraft = ref("");
/** 正在新建的位置；null = 没有在新建 */
const creating = ref<{ parentId: string | null; kind: "doc" | "folder" } | null>(null);
const createDraft = ref("");

/** 所有文件夹，供「移动到…」选择器用（缩进表达层级）。 */
const folders = computed(() => {
  const out: { id: string; label: string }[] = [];
  const walk = (nodes: KbTreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (n.isFolder) out.push({ id: n.doc.id, label: `${"　".repeat(depth)}${n.doc.title}` });
      walk(n.children, depth + 1);
    }
  };
  walk(tree.value, 0);
  return out;
});

/** 自身 + 自身子树：不能作为移动目标（服务端会拒）。 */
function selfSubtreeOf(id: string): ReadonlySet<string> {
  const out = new Set<string>();
  const collect = (n: KbTreeNode): void => {
    out.add(n.doc.id);
    n.children.forEach(collect);
  };
  const walk = (nodes: KbTreeNode[]): boolean => {
    for (const n of nodes) {
      if (n.doc.id === id) {
        collect(n);
        return true;
      }
      if (walk(n.children)) return true;
    }
    return false;
  };
  walk(tree.value);
  return out;
}

/**
 * 行的 ⋯ 菜单。走应用统一的 `ContextMenu`（Teleport 到 body + fixed + 视口边缘
 * 翻转）——侧栏的文档段是 `overflow: auto` 的，行内绝对定位的菜单会被容器裁掉，
 * 靠底的行尤其明显。
 */
function openRowMenu(e: MouseEvent, row: { doc: KbDocumentSummary; isFolder: boolean }): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = r.right;
  const y = r.bottom + 2;
  showMenu(
    x,
    y,
    kbNodeMenuItems(
      { id: row.doc.id, title: row.doc.title },
      {
        onRename: (id, title) => startRename(id, title),
        onMove: (id) => openMover(id, x, y),
        onDelete: (id) => emit("remove", id),
      },
    ),
  );
}

/**
 * 「新建」的二选一菜单。挂在两处：分组标题旁的 `+`（`parentId = null`，建在根）
 * 与文件夹行上的 `+`（建在该文件夹里）。
 *
 * 父层（KnowledgeBase.vue）通过 expose 调它时得把点击事件传进来——菜单要贴着
 * 那个按钮开。
 */
function openCreateMenu(e: MouseEvent, parentId: string | null): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(
    r.right,
    r.bottom + 2,
    kbCreateItems({
      onNewFolder: () => startCreate(parentId, "folder"),
      onNewDoc: () => startCreate(parentId, "doc"),
    }),
  );
}

/** 「移动到…」是第二个菜单，开在与 ⋯ 菜单相同的位置。 */
function openMover(id: string, x: number, y: number): void {
  showMenu(
    x,
    y,
    kbMoveMenuItems(folders.value, selfSubtreeOf(id), (parentId) =>
      emit("patch", id, { parentId }),
    ),
  );
}

/** 新建行的缩进：跟它要落进去的那一层对齐（目标父的深度 + 1）。 */
const creatingDepth = computed(() => {
  const at = creating.value;
  if (!at?.parentId) return 0;
  return (rows.value.find((r) => r.doc.id === at.parentId)?.depth ?? 0) + 1;
});

function onLabelClick(row: { doc: KbDocumentSummary; isFolder: boolean }): void {
  // 文件夹只切换展开，不打开正文——正文区只可能显示文档
  if (row.isFolder) emit("toggle", row.doc.id);
  else emit("open", row.doc.id);
}

function startRename(id: string, title: string): void {
  renaming.value = id;
  renameDraft.value = title;
}

function commitRename(): void {
  const id = renaming.value;
  if (!id) return;
  const title = renameDraft.value.trim();
  // 空名字直接取消：服务端也会拒，没必要为此跑一趟
  if (title) emit("patch", id, { title });
  renaming.value = null;
}

function startCreate(parentId: string | null, kind: "doc" | "folder"): void {
  creating.value = { parentId, kind };
  createDraft.value = "";
}

function commitCreate(): void {
  const at = creating.value;
  if (!at) return;
  const title = createDraft.value.trim();
  if (title) emit("create", at.parentId, at.kind, title);
  creating.value = null;
}

/** 搜索跳转用：把某一行滚进视野。`CSS.escape` 防 id 里的特殊字符破坏选择器。 */
function scrollToNode(id: string): void {
  root.value
    ?.querySelector(`[data-kb-node="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

// 「新建」的两个 + 里，分组标题旁那个在父层模板里，只能靠 expose 够到
defineExpose({ openCreateMenu, scrollToNode });

// 输入框挂载即聚焦
const vFocus = {
  mounted: (el: HTMLElement) => (el as HTMLInputElement).focus(),
};
</script>

<template>
  <div ref="root" class="kb-tree">
    <div
      v-for="row in rows"
      :key="row.doc.id"
      class="kb-treerow"
      :class="{ on: row.doc.id === activeId, 'is-folder': row.isFolder }"
      :style="{ paddingLeft: `${6 + row.depth * 14}px` }"
      :data-kb-node="row.doc.id"
    >
      <!-- 折叠箭头只在文件夹上出现，且占固定槽位；文档留白。
           这条槽位的占与不占就是「层级」通道，与图标/字重那条「类型」通道互不干扰 -->
      <button
        v-if="row.isFolder && row.hasChildren"
        data-kb-caret
        class="kb-caret"
        :class="{ open: !collapsed.has(row.doc.id) }"
        :title="collapsed.has(row.doc.id) ? '展开' : '折叠'"
        @click.stop="emit('toggle', row.doc.id)"
      >
        <Icon name="caret" :size="11" />
      </button>
      <span v-else class="kb-caret-spacer" />

      <span class="kb-node-glyph"><Icon :name="row.isFolder ? 'folder' : 'file'" :size="12" /></span>

      <input
        v-if="renaming === row.doc.id"
        data-kb-rename
        v-model="renameDraft"
        class="kb-inline-input"
        v-focus
        @keydown.enter="commitRename"
        @keydown.esc="renaming = null"
        @blur="commitRename"
      />
      <span v-else data-kb-label class="kb-label" @click="onLabelClick(row)">
        {{ row.doc.title }}
      </span>

      <!-- 空文件夹标「空」：先回答「为什么这个展不开」，而不是给一个按不动的箭头 -->
      <span v-if="row.isFolder && !row.hasChildren" data-kb-empty class="kb-empty-mark">空</span>

      <span class="kb-row-actions">
        <button
          v-if="row.isFolder"
          data-kb-add
          class="kb-rowbtn"
          title="新建"
          @click.stop="openCreateMenu($event, row.doc.id)"
        >
          <Icon name="plus" :size="11" />
        </button>
        <button
          data-kb-more
          class="kb-rowbtn"
          title="更多"
          @click.stop="openRowMenu($event, row)"
        >
          <Icon name="more" :size="11" />
        </button>
      </span>

    </div>

    <!-- 新建中的内联输入行：缩进跟它要落进去的那一层对齐 -->
    <div v-if="creating" class="kb-treerow" :style="{ paddingLeft: `${6 + creatingDepth * 14}px` }">
      <span class="kb-caret-spacer" />
      <span class="kb-node-glyph">
        <Icon :name="creating.kind === 'folder' ? 'folder' : 'file'" :size="12" />
      </span>
      <input
        data-kb-new
        v-model="createDraft"
        class="kb-inline-input"
        :placeholder="creating.kind === 'folder' ? '文件夹名' : '文档标题'"
        v-focus
        @keydown.enter="commitCreate"
        @keydown.esc="creating = null"
        @blur="commitCreate"
      />
    </div>
  </div>
</template>

<style scoped>
.kb-tree {
  position: relative;
}

.kb-treerow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding-right: 6px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.kb-treerow:hover { background: var(--aide-surface-hover); }
.kb-treerow.on {
  background: color-mix(in srgb, var(--aide-accent) 16%, transparent);
  color: var(--aide-text-primary);
}

.kb-caret {
  flex: 0 0 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: transform var(--aide-ease-t, 0.16s ease), color var(--aide-ease-t, 0.16s ease);
}
.kb-caret.open { transform: rotate(90deg); }
.kb-treerow:hover .kb-caret { color: var(--aide-text-secondary); }
.kb-treerow.on .kb-caret { color: var(--aide-accent); }
.kb-caret-spacer { flex: 0 0 14px; }

.kb-node-glyph { flex: 0 0 auto; display: inline-flex; color: var(--aide-text-secondary); opacity: 0.75; }
.kb-treerow.is-folder .kb-node-glyph { opacity: 1; }
.kb-treerow.on .kb-node-glyph { color: var(--aide-accent); opacity: 1; }

/* ⚠️ 类型走「字形 + 字重」，不走明度差。早先让文档用更暗的灰，实际渲染出来
   像被禁用；而把文件夹提亮到 text-primary 又会跟选中态抢信号——那等于用同一条
   通道同时表类型和状态。字重是这里唯一不打架的区分手段。 */
.kb-label {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-treerow.is-folder > .kb-label { font-weight: 500; }
.kb-treerow.on > .kb-label { color: var(--aide-text-primary); }
.kb-treerow:hover > .kb-label { color: var(--aide-text-primary); }

.kb-empty-mark {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--aide-text-secondary);
  opacity: 0.6;
  padding-right: 2px;
}

/* 行动作占固定槽位，所以标题不会因悬停而位移 */
.kb-row-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity var(--aide-ease-t, 0.16s ease);
}
.kb-treerow:hover .kb-row-actions { opacity: 1; }

.kb-rowbtn {
  border: none;
  background: none;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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

</style>

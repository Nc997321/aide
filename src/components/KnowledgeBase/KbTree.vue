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
  /** 文件选择器上认的扩展名（**服务端返回的那份**，父层从 kb.formats 拿）。
   *  它只管对话框里的过滤；真正的拒绝在 uploadFile 里——两处不能各写一份格式表。 */
  accept?: string[];
}>();

const emit = defineEmits<{
  open: [id: string];
  toggle: [id: string];
  /** 新建：父文件夹 id（null = 根）、类型、标题（标题在内联输入里收集，一起交出去） */
  create: [parentId: string | null, kind: "doc" | "folder", title: string];
  patch: [id: string, input: { title?: string; parentId?: string | null }];
  remove: [id: string];
  /** 上传：父文件夹 id（null = 根）与用户选中的文件。传输与格式判定在父层，
   *  这里只负责「把文件选出来」。 */
  upload: [parentId: string | null, file: File];
}>();

/** 树容器。只用于 scrollToNode 里查 DOM。 */
const root = ref<HTMLElement | null>(null);

const tree = computed<KbTreeNode[]>(() => buildTree(props.documents));
const rows = computed(() => flatten(tree.value, props.collapsed));

/** 目录页右侧那一列：只给「月-日」，跨年的补上年。窄、静音、右对齐。 */
function fmtDate(raw: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return sameYear ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

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
      onUpload: () => pickFile(parentId),
    }),
  );
}

// ── 上传：只负责把文件选出来 ──
// 一个常驻的隐藏 `<input type=file>`：每次「上传文件…」把它点开，
// 选完把 value 清掉（同一个文件连选两次也要能触发 change）。
const fileEl = ref<HTMLInputElement | null>(null);
/** 这次上传要落进哪个父节点（null = 根） */
const uploadParent = ref<string | null>(null);

function pickFile(parentId: string | null): void {
  uploadParent.value = parentId;
  fileEl.value?.click();
}

function onFilePicked(): void {
  const el = fileEl.value;
  const file = el?.files?.[0];
  if (file) emit("upload", uploadParent.value, file);
  if (el) el.value = "";
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

// 「新建」的两个 + 里，分组标题旁那个在父层模板里，只能靠 expose 够到；
// `pickFile` 同理——索引页的空态里那个「上传一个文件…」也要够到同一个选择器。
defineExpose({ openCreateMenu, scrollToNode, pickFile });

// 输入框挂载即聚焦
const vFocus = {
  mounted: (el: HTMLElement) => (el as HTMLInputElement).focus(),
};
</script>

<template>
  <div ref="root" class="kb-tree">
    <!-- 隐藏的文件选择器：整个面板只有这一个（空态那个入口也走它） -->
    <input
      ref="fileEl"
      data-kb-file
      type="file"
      class="kb-file-input"
      :accept="(props.accept ?? []).map((e) => `.${e}`).join(',')"
      @change="onFilePicked"
    />

    <div
      v-for="row in rows"
      :key="row.doc.id"
      class="kb-treerow"
      :class="{ on: row.doc.id === activeId, 'is-folder': row.isFolder }"
      :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
      :data-kb-node="row.doc.id"
      tabindex="0"
      @click="onLabelClick(row)"
      @keydown.enter.prevent="row.isFolder ? emit('toggle', row.doc.id) : emit('open', row.doc.id)"
      @keydown.space.prevent="row.isFolder ? emit('toggle', row.doc.id) : emit('open', row.doc.id)"
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
        @click.stop
        @keydown.enter="commitRename"
        @keydown.esc="renaming = null"
        @blur="commitRename"
      />
      <span v-else data-kb-label class="kb-label">
        {{ row.doc.title }}
      </span>

      <!-- 空文件夹标「空」：先回答「为什么这个展不开」，而不是给一个按不动的箭头 -->
      <span v-if="row.isFolder && !row.hasChildren" data-kb-empty class="kb-empty-mark">空</span>

      <!-- 目录页的右侧栏：时间。列宽固定，所以整页的时间在右边对齐成一条竖线。
           文件夹没有「改于」的概念，不占这一列。 -->
      <time v-if="!row.isFolder && row.doc.updatedAt" class="kb-row-time">
        {{ fmtDate(row.doc.updatedAt) }}
      </time>

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
    <div v-if="creating" class="kb-treerow" :style="{ paddingLeft: `${8 + creatingDepth * 16}px` }">
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
/* 目录页，不是文件管理器：
   没有 hover 填充块、没有圆角卡片；层级靠缩进与字重，选中是唯一的底色。
   行高 30 / 缩进步长 16（都在模板的 paddingLeft 里算）。 */

.kb-tree {
  position: relative;
}

/* 它是**目录页**，不是文件列表：行高 44、标题 15px、右侧一列时间。
   整屏宽度下，这样读起来像一本书的目次，而不是一个管理系统的表格。 */
.kb-treerow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding-right: 8px;
  border-radius: var(--aide-radius-sm);
  font-size: 16px;
  cursor: pointer;
  user-select: none;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-treerow:hover { background: var(--aide-surface-hover); }
/* 与外壳、空间列表同一套选中配方：底色 + 左侧 accent 条 */
.kb-treerow.on {
  background: var(--aide-surface-active);
  color: var(--aide-text-primary);
  box-shadow: inset 2px 0 0 var(--aide-accent);
}
.kb-treerow:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-treerow.on:focus-visible { box-shadow: inset 2px 0 0 var(--aide-accent), var(--aide-accent-ring); }

.kb-caret {
  flex: 0 0 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  padding: 0;
  border-radius: 4px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: transform var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-caret.open { transform: rotate(90deg); }
.kb-treerow:hover .kb-caret { color: var(--aide-text-secondary); }
.kb-treerow.on .kb-caret { color: var(--aide-accent); }
.kb-caret:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-caret-spacer { flex: 0 0 16px; }

.kb-node-glyph { flex: 0 0 auto; display: inline-flex; color: var(--aide-text-secondary); opacity: 0.7; }
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
  font-size: 11.5px;
  color: var(--aide-text-muted);
  padding-right: 2px;
}

/* 右侧那一列：固定宽度 + 等宽数字，整页对齐成一条竖线 */
.kb-row-time {
  flex: 0 0 64px;
  text-align: right;
  font-size: 12px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 行动作占固定槽位，所以标题不会因悬停而位移 */
.kb-row-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--aide-ease-t);
}
.kb-treerow:hover .kb-row-actions,
.kb-treerow:focus-within .kb-row-actions { opacity: 1; }

.kb-rowbtn {
  border: none;
  background: none;
  padding: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--aide-text-muted);
  cursor: pointer;
  border-radius: var(--aide-radius-sm);
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.kb-rowbtn:hover { color: var(--aide-text-primary); background: var(--aide-surface-active); }
.kb-rowbtn:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }

/* 文件选择器只是个通道，不进布局 */
.kb-file-input { display: none; }

.kb-inline-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  font: inherit;
  font-size: 13px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-accent);
  border-radius: var(--aide-radius-sm);
  outline: none;
}
</style>

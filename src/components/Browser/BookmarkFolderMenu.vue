<script setup lang="ts">
// 收藏条上「文件夹按钮」弹出的菜单：列出该目录的书签；子目录出一行小标题、其内容缩进一层。
//
// **遮罩根挂 `v-overlay-layer` 不是可选项**：原生 WebView2 子视图浮在所有 HTML 之上、不受 z-index
// 约束（见 `BrowserPanel.vue` 顶部「物理约束」），不登记的话菜单下半截会被网页整个吃掉。
// 菜单开着时网页让位，但面板会在让位前拍一张定格画面铺在洞里（见 `BrowserPanel.vue` 的「定格画面」），
// 所以看上去页面还在、只是暂时不能交互——不是一块灰。
//
// **必须 Teleport 到 body**：`backdrop-filter` 会给绝对/固定定位后代创建**新的包含块**（glass 系
// 主题的面板正好挂着它），留在原地的话 `position: fixed` 会相对那个祖先定位，`inset: 0` 只盖住它。
// 同理也避开 `.bp-bm-list` 的 `overflow-x: auto` 裁切。
import { computed, onMounted, onUnmounted } from "vue";
import { vOverlayLayer } from "../../directives/overlayLayer";
import { flattenFolderMenu, type BookmarkFolder } from "../../utils/browser";
import Icon from "../Icon.vue";

const props = defineProps<{
  folder: BookmarkFolder;
  /** 菜单左上角的视口坐标（调用方按按钮的 rect 算好）。 */
  anchor: { left: number; top: number };
  /** `url → data URI` 的图标表（面板持有，这里只查）。缺键 = 该渲染默认图标。 */
  favicons: Record<string, string | undefined>;
}>();

const emit = defineEmits<{
  open: [url: string];
  close: [];
}>();

const rows = computed(() => flattenFolderMenu(props.folder));

/** 缩进：子目录的内容比它的标题行深一层（`depth` = 缩进档数）。 */
function indentOf(depth: number) {
  return { paddingLeft: `${10 + depth * 12}px` };
}

/** Esc 关菜单。**处理了就必须 preventDefault**（keyboard-consume 约定）——否则 PermissionDialog
 *  的 window 级 handler 会跟着响应，一次 Esc 关两层。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.defaultPrevented) {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <!-- 全屏透明遮罩：点外面关菜单（`@click.self` —— 菜单内部的点击不冒到这里来关）。 -->
    <div class="bp-fmenu-overlay" v-overlay-layer @click.self="emit('close')">
      <div
        class="bp-fmenu"
        role="menu"
        :aria-label="folder.name"
        :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"
      >
        <template v-for="(row, i) in rows" :key="i">
          <div v-if="row.kind === 'folder'" class="bp-fmenu__group" :style="indentOf(row.depth)">
            {{ row.label }}
          </div>
          <button
            v-else
            class="bp-fmenu__item"
            role="menuitem"
            :title="row.url"
            :style="indentOf(row.depth)"
            @click="emit('open', row.url)"
          >
            <img
              v-if="favicons[row.url]"
              class="bp-fmenu__icon"
              :src="favicons[row.url]"
              alt=""
            />
            <Icon v-else name="globe" :size="13" class="bp-fmenu__glyph" />
            <span class="bp-fmenu__label">{{ row.label }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style>
/* 视觉语言与 `src/ui/ADropdown.vue` 一致（同样的 token），但那个组件没有锚点定位、也没有分组行，
   硬塞进来会把它变成一个需要坐标的新契约——所以这里另起一个，只服务于收藏条。 */
.bp-fmenu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
}

.bp-fmenu {
  position: fixed;
  min-width: 180px;
  max-width: 360px;
  /* 长目录（真机里「工具」有十几个）必须限高滚动，否则菜单长出窗口。 */
  max-height: 60vh;
  overflow-y: auto;
  padding: 5px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.bp-fmenu__group {
  padding: 6px 10px 3px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.bp-fmenu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  text-align: left;
  border-radius: var(--aide-radius-sm);
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  cursor: pointer;
  transition: all var(--aide-ease-t);
}
.bp-fmenu__item:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* 省略号要落在标签上而不是整个按钮：图标得留在原位（`min-width: 0` 是 flex 下能收缩的前提）。 */
.bp-fmenu__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-fmenu__icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  object-fit: contain;
}

.bp-fmenu__glyph {
  flex: 0 0 auto;
  color: var(--aide-text-muted);
}
</style>

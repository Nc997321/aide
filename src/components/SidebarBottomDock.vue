<script setup lang="ts">
/** 侧栏底部固定入口区（滚动列表之外、状态栏之上）：
 *  收拢「没有子树、不构成分区树节点」的功能入口——插件（主区市场面板开关）
 *  与记忆观测台（模态触发器）。不再复用 SidebarSectionHead 的大导航行：
 *  那套 chevron + 计数 + ⋯ 的分区树语言对无子列表的入口是语义错位。
 *  形态对标紧凑「图标 + 文字」行（WorkBuddy 式底部导航组），全部颜色走
 *  var(--aide-*) 主题 token，明暗主题自适应。 */
import { computed } from "vue";
import { useMarketplace } from "../composables/useMarketplace";
import { useMemoryObservatory } from "../composables/useMemoryObservatory";
import { useContextMenu } from "../composables/useContextMenu";
import { marketplaceSectionMenuItems } from "../menus/contextMenus";

const { panelOpen, togglePanel, openPanel, installedPlugins, sources, refreshSource } =
  useMarketplace();
// 观测台与插件同范式：底部入口只管主区面板开关（模块级状态），不再走事件冒泡到 App
const { panelOpen: observatoryOpen, togglePanel: toggleObservatory } = useMemoryObservatory();
const { show } = useContextMenu();

/** 已安装插件数（0 时不占位，与旧侧栏入口同规则） */
const installedCount = computed(() => installedPlugins.value.size || undefined);

/** 右键 / ⋯ 菜单沿用原分区菜单：打开面板 + 刷新全部启用源 */
function onDockMenu(e: MouseEvent) {
  show(
    e.clientX,
    e.clientY,
    marketplaceSectionMenuItems(openPanel, () => {
      for (const s of sources.value.filter((x) => x.enabled)) {
        void refreshSource(s.id);
      }
    }),
  );
}
</script>

<template>
  <div class="sidebar-dock">
    <div
      class="dock-row"
      :class="{ on: panelOpen }"
      v-tooltip="'插件市场'"
      @click="togglePanel"
      @contextmenu.prevent="onDockMenu"
    >
      <svg class="dock-icon" viewBox="0 0 24 24" fill="none">
        <path
          d="M21 8L12 3L3 8V16L12 21L21 16V8Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path
          d="M3 8L12 13L21 8M12 13V21"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="dock-label">插件</span>
      <span v-if="installedCount" class="dock-count">{{ installedCount }}</span>
    </div>

    <div
      class="dock-row"
      :class="{ on: observatoryOpen }"
      v-tooltip="'记忆观测台'"
      @click="toggleObservatory"
    >
      <!-- 头脑（与观测台头部 Icon name="brain" 同一字形，此处是 24 网格内联版） -->
      <svg class="dock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
        <path d="M15 13a4.5 4.5 0 0 0-1.41 2.775"/>
        <path d="M9 13a4.5 4.5 0 0 1-1.41 2.775"/>
        <path d="M17.99 9.125a4.5 4.5 0 0 1 .001 5.75"/>
        <path d="M6.01 9.125a4.5 4.5 0 0 0-.001 5.75"/>
      </svg>
      <span class="dock-label">记忆观测台</span>
    </div>
  </div>
</template>

<style scoped>
.sidebar-dock {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
  border-top: 1px solid var(--aide-border-subtle);
}

.dock-row {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  /* 字号/字重对齐会话列表条目（.session-name 13px/500），底部区不再自成一套字号 */
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-secondary);
  transition: all 0.12s ease;
  user-select: none;
}

.dock-row:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
}

/* 面板开着 = 当前所在主区视图，accent 轻量标记（与工作区展开态同语言） */
.dock-row.on {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

.dock-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: color 0.12s;
}

.dock-row:hover .dock-icon,
.dock-row.on .dock-icon {
  color: inherit;
}

.dock-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-count {
  flex-shrink: 0;
  min-width: 18px;
  box-sizing: border-box;
  text-align: center;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: 8px;
}

.dock-row.on .dock-count {
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 14%, transparent);
}
</style>

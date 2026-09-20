<script setup lang="ts">
/** 侧栏顶部导航组（品牌区之下、分区树之上，WorkBuddy 式扁平分组）：
 *  首条「新增会话」——本行只向上 emit，不经手会话状态（会话创建由 SidebarLeft
 *  的 newSession 统一发起，与 Ctrl+N / 分区头 ⋯ 菜单同一入口）；
 *  其余四行 = 无子树的功能入口（插件 / 记忆观测台 / 知识库 / 浏览器），各自的模块级
 *  面板开关（浏览器那行同时受 Ctrl+Shift+B 控制，两处同一状态）。
 *  不复用 SidebarSectionHead 的大导航行：那套 chevron + 计数 + ⋯ 的
 *  分区树语言对无子列表的入口是语义错位；但字号/字重对齐分区头（13.5px/600），
 *  导航区与分区树各是一条视觉语言，不再自成一套字号。
 *  全部颜色走 var(--aide-*) 主题 token，明暗主题自适应。 */
import { computed } from "vue";
import { useMarketplace } from "../composables/useMarketplace";
import { useMemoryObservatory } from "../composables/useMemoryObservatory";
import { useKnowledgeBase } from "../composables/useKnowledgeBase";
import { useContextMenu } from "../composables/useContextMenu";
import { marketplaceSectionMenuItems } from "../menus/contextMenus";

const emit = defineEmits<{
  /** 「新增会话」行：会话创建逻辑归父级（与 Ctrl+N 同一条路径） */
  "new-session": [];
}>();

const { panelOpen, togglePanel, openPanel, installedPlugins, sources, refreshSource } =
  useMarketplace();
// 观测台与插件同范式：入口只管主区面板开关（模块级状态），不再走事件冒泡到 App
const { panelOpen: observatoryOpen, togglePanel: toggleObservatory } = useMemoryObservatory();
// 知识库：与上面两个同范式（模块级面板开关），但**不依赖 aide 的会话状态**——
// 它连的是独立进程 knowledge-server，没配对也能用（只要那个服务活着）。
const { panelOpen: kbOpen, togglePanel: toggleKb } = useKnowledgeBase();
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
  <div class="nav-group">
    <div
      class="nav-row"
      v-tooltip="'新开一个空白会话（Ctrl+N）'"
      @click="emit('new-session')"
    >
      <!-- 加号 + 对话气泡：与「会话」分区头同一字形语言，语义是"新开一段对话" -->
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 8v8"/>
        <path d="M8 12h8"/>
        <path d="M21 15C21 15.53 20.79 16.04 20.41 16.41C20.04 16.79 19.53 17 19 17H7L3 21V5C3 4.47 3.21 3.96 3.59 3.59C3.96 3.21 4.47 3 5 3H19C19.53 3 20.04 3.21 20.41 3.59C20.79 3.96 21 4.47 21 5V15Z"/>
      </svg>
      <span class="nav-label">新增会话</span>
    </div>

    <div
      class="nav-row"
      :class="{ on: panelOpen }"
      v-tooltip="'插件市场'"
      @click="togglePanel"
      @contextmenu.prevent="onDockMenu"
    >
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none">
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
      <span class="nav-label">插件</span>
      <span v-if="installedCount" class="nav-count">{{ installedCount }}</span>
    </div>

    <div
      class="nav-row"
      :class="{ on: observatoryOpen }"
      v-tooltip="'记忆观测台'"
      @click="toggleObservatory"
    >
      <!-- 头脑（与观测台头部 Icon name="brain" 同一字形，此处是 24 网格内联版） -->
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
        <path d="M15 13a4.5 4.5 0 0 0-1.41 2.775"/>
        <path d="M9 13a4.5 4.5 0 0 1-1.41 2.775"/>
        <path d="M17.99 9.125a4.5 4.5 0 0 1 .001 5.75"/>
        <path d="M6.01 9.125a4.5 4.5 0 0 0-.001 5.75"/>
      </svg>
      <span class="nav-label">记忆观测台</span>
    </div>

    <div class="nav-row" :class="{ on: kbOpen }" v-tooltip="'团队知识库'" @click="toggleKb">
      <!-- 书本（24 网格内联版，与上面两行同一字形语言） -->
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
      <span class="nav-label">知识库</span>
    </div>
  </div>
</template>

<style scoped>
.nav-group {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 10px 8px;
}

.nav-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  /* 字号/字重对齐分区头（.sec-head 13.5px/600）：导航区与分区树同一套字，
     层级差只靠缩进与引导线表达，不再靠字号分两套 */
  font-size: 13.5px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  transition: all var(--aide-ease-t);
  user-select: none;
}

.nav-row:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
}

/* 面板开着 = 当前所在主区视图，accent 轻量标记（与工作区展开态同语言） */
.nav-row.on {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

.nav-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: color var(--aide-ease-t);
}

.nav-row:hover .nav-icon,
.nav-row.on .nav-icon {
  color: inherit;
}

.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-count {
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

.nav-row.on .nav-count {
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 14%, transparent);
}
</style>

<script setup lang="ts">
/** 侧栏「插件」导航行：与「会话」「自动化」平级的根入口，复用 SidebarSectionHead
 *  大导航行（chevron + 图标 + 标签 + 右槽位 计数⇄⋯），视觉与交互完全一致。
 *  无子节点：chevron 展开态 = 主区市场面板开关（单击整行切换）；计数 = 已安装插件数；
 *  ⋯ 菜单 = 打开市场 / 刷新全部市场源。 */
import { computed } from "vue";
import { useMarketplace } from "../../composables/useMarketplace";
import { useContextMenu } from "../../composables/useContextMenu";
import { marketplaceSectionMenuItems } from "../../menus/contextMenus";
import SidebarSectionHead from "../SidebarSectionHead.vue";

const { panelOpen, togglePanel, openPanel, installedPlugins, sources, refreshSource } =
  useMarketplace();
const { show } = useContextMenu();

/** 与自动化分区同规则：0 时不占位（undefined） */
const installedCount = computed(() => installedPlugins.value.size || undefined);

/** ⋯ 菜单：打开面板 + 刷新全部启用源（与卡片上的单源 ⟳ 同一动作） */
function onSectionMenu(e: MouseEvent) {
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
  <div class="mkt-sec">
    <SidebarSectionHead
      label="插件"
      :count="installedCount"
      :expanded="panelOpen"
      @toggle="togglePanel"
      @menu="onSectionMenu"
    >
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none">
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
      </template>
    </SidebarSectionHead>
  </div>
</template>

<style scoped>
/* 与自动化分区相同的区隔节奏 */
.mkt-sec {
  margin-top: 2px;
}
</style>

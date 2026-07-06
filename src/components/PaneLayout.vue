<script setup lang="ts">
import { provide, toRef } from "vue";
import PaneSplit from "./panelayout/PaneSplit.vue";
import { WORKSPACE_PATH_KEY } from "./panelayout/keys";
import { usePaneLayout } from "../composables/usePaneLayout";

/**
 * 聊天区多 tab + 分屏的组织层：App.vue 的 panel-center 只放这一个组件。
 * 布局状态在 usePaneLayout（模块级单例），渲染递归在 panelayout/PaneSplit.vue，
 * 组内接线（tab 栏 + ChatPanel + useChatSession 绑定）在 panelayout/PaneGroup.vue。
 */
const props = defineProps<{ workspacePath: string }>();

provide(WORKSPACE_PATH_KEY, toRef(props, "workspacePath"));

const { layout } = usePaneLayout();
</script>

<template>
  <div class="pane-layout">
    <PaneSplit :node="layout.root" />
  </div>
</template>

<style scoped>
.pane-layout {
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>

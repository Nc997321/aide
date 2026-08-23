<script setup lang="ts">
/** 自动化主区壳：按 useAutomation.state.view 在详情与编辑器之间切换。
 *  App.vue 在 view 非 null 时挂载本组件（盖住 PaneLayout，聊天区 v-show 保活）。 */
import { useAutomation } from "../../composables/useAutomation";
import AutomationDetail from "./AutomationDetail.vue";
import AutomationTaskEditor from "./AutomationTaskEditor.vue";

const auto = useAutomation();
</script>

<template>
  <AutomationTaskEditor v-if="auto.state.view === 'editor'" />
  <AutomationDetail v-else />
</template>

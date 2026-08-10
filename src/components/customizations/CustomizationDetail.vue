<script setup lang="ts">
// 扩展条目详情门面：按 type 分派到对应专属 editor。
// name 不在此统一管理——不同类型 name 语义不同（MCP 是 settings.json key，Skill 是 frontmatter 字段），
// 各 editor 内部自管。宿主只负责透传 item 与事件。
import type { CustomizationType, CustomizationItem } from "../../types/customization";
import McpServerEditor from "./editors/McpServerEditor.vue";
import HookEditor from "./editors/HookEditor.vue";
import SkillEditor from "./editors/SkillEditor.vue";
import AgentEditor from "./editors/AgentEditor.vue";
import InstructionEditor from "./editors/InstructionEditor.vue";

defineProps<{ type: CustomizationType; item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();

const onUpdate = (d: Partial<CustomizationItem>) => emit("update", d);
const onDelete = () => emit("delete");
const onBack = () => emit("back");
</script>

<template>
  <McpServerEditor
    v-if="type === 'mcp_server'"
    :item="item"
    @update="onUpdate"
    @delete="onDelete"
    @back="onBack"
  />
  <HookEditor
    v-else-if="type === 'hook'"
    :item="item"
    @update="onUpdate"
    @delete="onDelete"
    @back="onBack"
  />
  <SkillEditor
    v-else-if="type === 'skill'"
    :item="item"
    @update="onUpdate"
    @delete="onDelete"
    @back="onBack"
  />
  <AgentEditor
    v-else-if="type === 'agent'"
    :item="item"
    @update="onUpdate"
    @delete="onDelete"
    @back="onBack"
  />
  <InstructionEditor
    v-else-if="type === 'instruction'"
    :item="item"
    @update="onUpdate"
    @delete="onDelete"
    @back="onBack"
  />
</template>
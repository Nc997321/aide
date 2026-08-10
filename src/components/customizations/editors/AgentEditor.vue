<script setup lang="ts">
import type { CustomizationItem } from "../../../types/customization";
defineOptions({ name: "AgentEditor" });
defineProps<{ item: CustomizationItem | null }>();
defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();
</script>
<template><div class="editor-placeholder" /></template>
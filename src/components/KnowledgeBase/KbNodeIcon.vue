<script setup lang="ts">
/**
 * 资料库目录树的节点图标：按类型着色的实心小图标（文件夹 / Markdown / 网页），
 * 取代早先统一的灰色描边「文件/文件夹」——一排灰线稿既压抑又分不出类型。
 *
 * 类型 → 色：文件夹 = info（蓝）、Markdown = success（绿）、网页 = syntaxKeyword（紫）。
 * 全部走主题槽位（不硬编码 hex），三套主题各自出色；方块内的字形用 bg-deep 反色刻出，
 * 亮/暗主题下都与实心色块有足够对比。
 *
 * Markdown / 网页两枚与文件树共用一份定义（utils/fileIcons.ts 的 MARKDOWN_ICON /
 * HTML_ICON，经 FileTypeIcon 渲染）——同一种文件在两处必须长得一样。
 *
 * 类型判定沿用 previewKindFor（预览分派的唯一产地），只有 markdown / html 两档，
 * 其余（含老服务端不带 mime）兜底按 markdown 画——与「老服务端按 markdown 兜底」一致。
 */
import { computed } from "vue";
import { previewKindFor } from "./previewKind";
import FileTypeIcon from "../FileTypeIcon.vue";
import { MARKDOWN_ICON, HTML_ICON } from "@/utils/fileIcons";

const props = withDefaults(
  defineProps<{
    folder?: boolean;
    /** 文档的 mime；缺省 = markdown */
    mime?: string;
    size?: number;
  }>(),
  { folder: false, mime: "text/markdown", size: 16 },
);

const kind = computed<"folder" | "markdown" | "html">(() => {
  if (props.folder) return "folder";
  return previewKindFor(props.mime) === "html" ? "html" : "markdown";
});
</script>

<template>
  <svg
    v-if="kind === 'folder'"
    class="kb-node-icon k-folder"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    data-kind="folder"
  >
    <path class="tone" fill-opacity="0.55" d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3.1l1.4 1.5h6.1a1.2 1.2 0 0 1 1.2 1.2v6.6a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
    <path class="tone" d="M1.5 7.4h13v4.9a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
  </svg>
  <FileTypeIcon
    v-else
    class="kb-node-icon"
    :icon="kind === 'html' ? HTML_ICON : MARKDOWN_ICON"
    :size="size"
    :data-kind="kind"
  />
</template>

<style scoped>
.kb-node-icon { flex: 0 0 auto; display: block; }
.tone { fill: currentColor; }
.k-folder { color: var(--aide-info); }
</style>

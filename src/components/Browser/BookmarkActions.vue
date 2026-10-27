<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from "vue";
import { vOverlayLayer } from "../../directives/overlayLayer";
import type { Bookmark } from "../../composables/browser/useBrowserBookmarks";
const props = defineProps<{ bookmark: Bookmark; bookmarks: Bookmark[]; x: number; y: number }>();
const emit = defineEmits<{ close: []; open: [url: string]; remove: [id: string]; move: [id: string, folders: string[]] }>();
const window = globalThis.window;
const moving = ref(false);
const newFolder = ref("");
const folders = computed(() => {
  const paths = new Map<string, string[]>();
  paths.set("[]", []);
  for (const b of props.bookmarks) for (let i = 1; i <= b.folders.length; i++) {
    const path = b.folders.slice(0, i); paths.set(JSON.stringify(path), path);
  }
  return [...paths.values()];
});
function move(path: string[]) { emit("move", props.bookmark.id, path); emit("close"); }
function key(e: KeyboardEvent) { if (e.key === "Escape") { e.preventDefault(); emit("close"); } }
onMounted(() => window.addEventListener("keydown", key));
onUnmounted(() => window.removeEventListener("keydown", key));
</script>
<template>
  <Teleport to="body">
    <div class="bp-fmenu-overlay" v-overlay-layer @click.self="emit('close')" @contextmenu.prevent.self="emit('close')">
      <div class="bp-fmenu" role="menu" aria-label="收藏操作" :style="{ left: `${Math.max(0, Math.min(x, window.innerWidth - 280))}px`, top: `${Math.max(0, Math.min(y, window.innerHeight * 0.4))}px`, width: '260px' }">
        <template v-if="!moving">
          <button class="bp-fmenu__item" role="menuitem" @click="emit('open', bookmark.url); emit('close')">打开</button>
          <button class="bp-fmenu__item" role="menuitem" @click="moving = true">移动到文件夹…</button>
          <button class="bp-fmenu__item" role="menuitem" @click="emit('remove', bookmark.id); emit('close')">删除收藏</button>
        </template>
        <template v-else>
          <button class="bp-fmenu__item" @click="moving = false">返回</button>
          <button v-for="path in folders" :key="JSON.stringify(path)" class="bp-fmenu__item" :disabled="JSON.stringify(path) === JSON.stringify(bookmark.folders)" @click="move(path)">{{ path.join(' / ') || '收藏栏（根目录）' }}</button>
          <form @submit.prevent="newFolder.trim() && move([...bookmark.folders, newFolder.trim()])">
            <input v-model="newFolder" class="bp-folder-input" placeholder="新建文件夹名称" aria-label="新建文件夹名称" />
            <button class="bp-fmenu__item" :disabled="!newFolder.trim()" type="submit">新建文件夹并移入</button>
          </form>
        </template>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
.bp-folder-input { width: 100%; padding: calc(var(--aide-space-unit) * 2); color: var(--aide-text-primary); background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong); border-radius: var(--aide-radius-sm); }
button:disabled { opacity: 0.5; cursor: default; }
</style>

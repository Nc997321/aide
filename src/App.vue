<script setup lang="ts">
import SidebarLeft from "./components/SidebarLeft.vue";
import TerminalPanel from "./components/TerminalPanel.vue";
import FileTree from "./components/FileTree.vue";
import ContextMenu from "./components/ContextMenu.vue";
import ModalDialog from "./components/ModalDialog.vue";
import FileViewer from "./components/FileViewer.vue";
import { ref, onMounted, onUnmounted } from "vue";

const leftWidth = ref(280);
const rightWidth = ref(300);
const isDraggingLeft = ref(false);
const isDraggingRight = ref(false);
const sidebarRef = ref<InstanceType<typeof SidebarLeft> | null>(null);
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const activeSessionId = ref("");

function onLeftResizeStart(e: MouseEvent) {
  isDraggingLeft.value = true;
  const startX = e.clientX;
  const startWidth = leftWidth.value;
  const onMove = (ev: MouseEvent) => {
    leftWidth.value = Math.max(200, Math.min(450, startWidth + ev.clientX - startX));
  };
  const onUp = () => {
    isDraggingLeft.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onRightResizeStart(e: MouseEvent) {
  isDraggingRight.value = true;
  const startX = e.clientX;
  const startWidth = rightWidth.value;
  const onMove = (ev: MouseEvent) => {
    rightWidth.value = Math.max(200, Math.min(500, startWidth - ev.clientX + startX));
  };
  const onUp = () => {
    isDraggingRight.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onSessionChanged(id: string) {
  activeSessionId.value = id;
}

async function onSessionUpdated() {
  // Reload sessions from Claude Code storage; if the current session was a
  // placeholder (new_xxx), the sidebar will auto-select the first real session.
  await sidebarRef.value?.loadSessions();
}

async function onFileTreeWsChanged(_path: string) {
  activeSessionId.value = "";
  await sidebarRef.value?.loadSessions();
}

async function onSidebarWsChanged(_path: string) {
  activeSessionId.value = "";
  await fileTreeRef.value?.loadRoot();
}

function handleKeydown(e: KeyboardEvent) {
  // Ctrl+N: new session
  if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    sidebarRef.value?.newSession();
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="app-layout">
    <!-- Left panel -->
    <div class="panel-left" :style="{ width: leftWidth + 'px' }">
      <SidebarLeft ref="sidebarRef" :active-session-id="activeSessionId" @session-changed="onSessionChanged" @workspace-changed="onSidebarWsChanged" />
    </div>

    <!-- Resize handle left -->
    <div
      class="resize-handle"
      :class="{ active: isDraggingLeft }"
      @mousedown="onLeftResizeStart"
    />

    <!-- Center panel -->
    <div class="panel-center">
      <TerminalPanel :session-id="activeSessionId" @session-updated="onSessionUpdated" />
    </div>

    <!-- Resize handle right -->
    <div
      class="resize-handle"
      :class="{ active: isDraggingRight }"
      @mousedown="onRightResizeStart"
    />

    <!-- Right panel -->
    <div class="panel-right" :style="{ width: rightWidth + 'px' }">
      <FileTree ref="fileTreeRef" @workspace-changed="onFileTreeWsChanged" />
    </div>

    <ContextMenu />
    <ModalDialog />
    <FileViewer />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100%;
  width: 100%;
  background-color: var(--bg-primary);
  user-select: none;
}

.panel-left {
  flex-shrink: 0;
  height: 100%;
  background-color: var(--bg-secondary);
  border-right: 1px solid var(--surface);
  display: flex;
  flex-direction: column;
}

.panel-center {
  flex: 1;
  height: 100%;
  min-width: 400px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-primary);
}

.panel-right {
  flex-shrink: 0;
  height: 100%;
  background-color: var(--bg-secondary);
  border-left: 1px solid var(--surface);
  display: flex;
  flex-direction: column;
}

.resize-handle {
  width: 3px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.15s;
  flex-shrink: 0;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle.active {
  background-color: var(--accent);
}
</style>

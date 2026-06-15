<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { sessionMenuItems } from "../menus/contextMenus";

interface Session {
  id: string;
  name: string;
  timestamp: number;
  last_message: string;
}

const props = defineProps<{
  activeSessionId: string;
}>();

const emit = defineEmits<{
  "session-changed": [id: string];
}>();

const sessions = ref<Session[]>([]);
const searchQuery = ref("");
const filteredSessions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return sessions.value;
  return sessions.value.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.last_message.toLowerCase().includes(q),
  );
});
const customExpanded = ref(false);
const loading = ref(true);

const customItems = [
  { name: "智能体" },
  { name: "技能" },
  { name: "指令" },
  { name: "钩构" },
  { name: "MCP 服务器" },
];

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return `${Math.floor(days / 7)}周前`;
}

async function loadSessions() {
  try {
    sessions.value = await invoke<Session[]>("list_sessions");
  } catch (_e) {
    sessions.value = [];
  }
  loading.value = false;

  // No sessions at all: auto-create the first one
  if (sessions.value.length === 0) {
    await newSession();
    return;
  }
  // Auto-select first session if none active (including placeholder new_ IDs)
  if (!props.activeSessionId || props.activeSessionId.startsWith("new_")) {
    emit("session-changed", sessions.value[0].id);
  }
}

const { show } = useContextMenu();
const { state: sessionState } = useSessionState();

function selectSession(id: string) {
  emit("session-changed", id);
}

async function renameSession(id: string, name: string) {
  try {
    await invoke("rename_session", { id, name });
    await loadSessions();
  } catch (_e) { /* ignore */ }
}

function onSessionContextMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  show(
    e.clientX,
    e.clientY,
    sessionMenuItems(id, (name: string) => renameSession(id, name), loadSessions),
  );
}

async function newSession() {
  const name = `新会话 ${new Date().toLocaleTimeString()}`;
  try {
    const s = await invoke<Session>("create_session", { name });
    sessions.value.unshift(s);
    emit("session-changed", s.id);
  } catch (_e) {
    const s: Session = {
      id: Date.now().toString(),
      name,
      timestamp: Date.now(),
      last_message: "",
    };
    sessions.value.unshift(s);
    emit("session-changed", s.id);
  }
}

onMounted(loadSessions);

defineExpose({ newSession, loadSessions });
</script>

<template>
  <div class="sidebar-left">
    <!-- Header -->
    <div class="sidebar-header">
      <span class="header-title">会话</span>
      <button class="new-btn" @click="newSession" title="新建会话 (Ctrl+N)">
        新 (Ctrl+N)
      </button>
    </div>

    <!-- Search box -->
    <div class="search-box">
      <input
        v-model="searchQuery"
        class="search-input"
        placeholder="搜索会话..."
      />
    </div>

    <!-- Session list -->
    <div class="session-list">
      <div v-if="loading" class="session-item muted">加载中...</div>
      <div
        v-else-if="filteredSessions.length === 0 && sessions.length > 0"
        class="session-item muted"
      >
        无匹配的会话
      </div>
      <div
        v-for="s in filteredSessions"
        :key="s.id"
        class="session-item"
        :class="{
          active: props.activeSessionId === s.id,
          running: sessionState[s.id] === 'running',
          waiting: sessionState[s.id] === 'waiting',
          attention: sessionState[s.id] === 'attention',
        }"
        @click="selectSession(s.id)"
        @contextmenu.prevent="onSessionContextMenu($event, s.id)"
      >
        <div class="session-name">{{ s.name }}</div>
        <div class="session-time">{{ timeAgo(s.timestamp) }}</div>
      </div>
    </div>

    <!-- Custom section -->
    <div class="custom-section">
      <div class="custom-header" @click="customExpanded = !customExpanded">
        <span class="arrow" :class="{ expanded: customExpanded }">&#x25B8;</span>
        <span>自定义</span>
      </div>
      <div v-if="customExpanded" class="custom-list">
        <div v-for="item in customItems" :key="item.name" class="custom-item">
          <span>{{ item.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sidebar-left {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--surface);
}

.header-title {
  font-weight: 600;
  font-size: 13px;
}

.new-btn {
  background: none;
  border: 1px solid var(--surface);
  color: var(--text-secondary);
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.new-btn:hover {
  background: var(--surface);
  color: var(--text-primary);
}

.search-box {
  padding: 8px 12px;
  border-bottom: 1px solid var(--surface);
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}
.search-input::placeholder {
  color: var(--text-muted);
}
.search-input:focus {
  border-color: var(--accent);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.session-item {
  padding: 8px 16px;
  cursor: pointer;
  border-left: 2px solid transparent;
  border-right: 2px solid transparent;
  transition: all 0.1s;
}

.session-item:hover {
  background: var(--surface);
}

.session-item.active {
  background: var(--surface);
  border-left-color: var(--accent);
}

/* Running: green shimmer sweeping right→left */
.session-item.running {
  position: relative;
  overflow: hidden;
}
.session-item.running::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(166, 227, 161, 0.06) 40%,
    rgba(166, 227, 161, 0.12) 50%,
    rgba(166, 227, 161, 0.06) 60%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sweep-right 2.5s ease-in-out infinite;
  pointer-events: none;
}
@keyframes sweep-right {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Waiting: subtle green right accent */
.session-item.waiting {
  border-right-color: var(--accent-green);
}

/* Attention: amber shimmer */
.session-item.attention {
  position: relative;
  overflow: hidden;
}
.session-item.attention::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(249, 226, 175, 0.06) 40%,
    rgba(249, 226, 175, 0.12) 50%,
    rgba(249, 226, 175, 0.06) 60%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sweep-right 1.5s ease-in-out infinite;
  pointer-events: none;
}

.session-item.muted {
  color: var(--text-muted);
  cursor: default;
  font-size: 12px;
  padding: 12px 16px;
}

.session-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.custom-section {
  border-top: 1px solid var(--surface);
  padding: 8px 0;
}

.custom-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
}

.custom-header:hover {
  color: var(--text-primary);
}

.arrow {
  font-size: 10px;
  transition: transform 0.15s;
}

.arrow.expanded {
  transform: rotate(90deg);
}

.custom-list {
  padding: 0 16px 4px;
}

.custom-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
}

.custom-item:hover {
  background: var(--surface);
  color: var(--text-primary);
}

.badge {
  background: var(--surface);
  color: var(--text-muted);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
}
</style>

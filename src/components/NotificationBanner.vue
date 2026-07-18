<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";

interface PendingSession {
  id: string;
  name: string;
  wsKey: string;
  wsName: string;
}

const props = defineProps<{
  sessions: PendingSession[];
  visible: boolean;
}>();

const emit = defineEmits<{
  navigate: [sessionId: string, wsKey: string];
  dismiss: [];
}>();

const show = ref(false);
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

function startAutoHide() {
  if (autoHideTimer) clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(() => {
    show.value = false;
    emit("dismiss");
  }, 8000);
}

function resetAutoHide() {
  if (autoHideTimer) clearTimeout(autoHideTimer);
  startAutoHide();
}

watch(() => props.visible, (v) => {
  show.value = v;
  if (v) startAutoHide();
});

onMounted(() => {
  if (props.visible) {
    show.value = true;
    startAutoHide();
  }
});

onUnmounted(() => {
  if (autoHideTimer) clearTimeout(autoHideTimer);
});

function handleClick(session: PendingSession) {
  show.value = false;
  emit("navigate", session.id, session.wsKey);
}

function handleDismiss() {
  show.value = false;
  emit("dismiss");
}
</script>

<template>
  <Transition name="banner-slide">
    <div v-if="show && sessions.length > 0" class="notification-banner" @mouseenter="resetAutoHide">
      <div class="banner-header">
        <span class="banner-icon">&#x1F514;</span>
        <span class="banner-title">会话已完成</span>
        <button class="banner-close" @click="handleDismiss" v-tooltip="'关闭'">&times;</button>
      </div>
      <div class="banner-sessions">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="banner-session"
          @click="handleClick(session)"
        >
          <div class="session-name">{{ session.name }}</div>
          <div class="session-ws">{{ session.wsName }}</div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.notification-banner {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  min-width: 280px;
  max-width: 400px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-info) 10%, transparent), color-mix(in srgb, var(--aide-info) 4%, transparent));
  border: 1px solid color-mix(in srgb, var(--aide-info) 25%, transparent);
  border-radius: var(--aide-radius-md);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  box-shadow: var(--aide-shadow-md), var(--aide-highlight-inset);
  overflow: hidden;
}

.banner-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--aide-border-subtle);
}

.banner-icon {
  font-size: 14px;
  color: var(--aide-info);
}

.banner-title {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.banner-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color var(--aide-ease-t);
}
.banner-close:hover {
  color: var(--aide-text-primary);
}

.banner-sessions {
  max-height: 150px;
  overflow-y: auto;
}

.banner-session {
  padding: 10px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--aide-border-subtle);
  transition: background var(--aide-ease-t);
}
.banner-session:last-child {
  border-bottom: none;
}
.banner-session:hover {
  background: var(--aide-surface-default);
}

.session-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-ws {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Transition */
.banner-slide-enter-active,
.banner-slide-leave-active {
  transition: transform var(--aide-ease-t), opacity var(--aide-ease-t);
}
.banner-slide-enter-from,
.banner-slide-leave-to {
  transform: translateX(-50%) translateY(-20px);
  opacity: 0;
}
.banner-slide-enter-to,
.banner-slide-leave-from {
  transform: translateX(-50%) translateY(0);
  opacity: 1;
}
</style>

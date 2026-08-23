<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConnState } from "../protocol";
import type { Session, Workspace } from "../types";

const props = defineProps<{
  connState: ConnState;
  sessions: Session[];
  liveSessions: Set<string>;
  refreshing: boolean;
  workspaces: Workspace[];
  /** null = 跟随桌面当前活动工作区（列表不带 key 拉取） */
  activeWorkspaceKey: string | null;
}>();

const emit = defineEmits<{
  open: [s: Session];
  newSession: [];
  refresh: [];
  workspaceChange: [key: string];
}>();

const sheetOpen = ref(false);
const activeWorkspace = computed(
  () => props.workspaces.find((w) => w.key === props.activeWorkspaceKey) ?? null,
);

function pick(key: string): void {
  emit("workspaceChange", key);
  sheetOpen.value = false;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / 周X / M/D */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  if (diff < 7 * 86_400_000) return WEEKDAYS[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<template>
  <div class="sv">
    <div class="sv-top">
      <h3>会话</h3>
      <span class="conn-pill">
        <span v-if="connState === 'authed'" class="dot ok"></span>
        <span v-else class="dot off"></span>
        {{ connState === "authed" ? "已连接" : "设备离线" }}
      </span>
      <button class="icon-btn" title="刷新" @click="emit('refresh')">
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          :class="{ spinning: refreshing }"
        ><path d="M13.6 8a5.6 5.6 0 1 1-1.65-3.95" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M13.8 1.6v3h-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    <!-- 工作区选择行：常驻显示当前工作区，点击弹出底部弹层切换 -->
    <div class="sv-ws">
      <button class="ws-chip" :aria-expanded="sheetOpen" @click="sheetOpen = true">
        <span class="ws-ic">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3.5c0-.55.45-1 1-1h3l1.6 1.6h5.4c.55 0 1 .45 1 1v7.4c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        </span>
        <span class="ws-name">{{ activeWorkspace ? activeWorkspace.name : "跟随桌面当前工作区" }}</span>
        <span class="ws-caret">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </button>
    </div>

    <div class="sv-list">
      <button v-for="s in sessions" :key="s.id" class="sv-item" @click="emit('open', s)">
        <div class="sv-row1">
          <span class="sv-name">{{ s.name || "未命名会话" }}</span>
          <span class="sv-time">{{ relTime(s.timestamp) }}</span>
        </div>
        <div class="sv-row2">
          <span class="sv-prev">{{ s.last_message }}</span>
          <span v-if="liveSessions.has(s.id)" class="sv-live"><span class="dot"></span>回复中</span>
        </div>
      </button>
      <p v-if="sessions.length === 0" style="text-align: center; color: var(--text-muted); font-size: 12px; padding-top: 40px">
        暂无会话，点右下角开始新会话
      </p>
    </div>

    <!-- 工作区选择弹层（底部 sheet） -->
    <div class="ws-mask" :class="{ show: sheetOpen }" @click.self="sheetOpen = false">
      <div class="ws-sheet">
        <div class="ws-head">
          <b>选择工作区</b>
          <small>会话按工作区隔离 · 新会话发往所选工作区</small>
        </div>
        <button
          v-for="w in workspaces"
          :key="w.key"
          class="ws-opt"
          :class="{ on: w.key === activeWorkspaceKey }"
          @click="pick(w.key)"
        >
          <span class="ws-ic">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 3.5c0-.55.45-1 1-1h3l1.6 1.6h5.4c.55 0 1 .45 1 1v7.4c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          </span>
          <span class="ws-name">{{ w.name }}</span>
          <svg class="ws-check" width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <p v-if="workspaces.length === 0" style="text-align: center; color: var(--text-muted); font-size: 11px; padding: 12px 0">
          正在加载工作区…
        </p>
      </div>
    </div>

    <button class="fab" title="新会话" @click="emit('newSession')">
      <svg width="22" height="22" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
    </button>
  </div>
</template>

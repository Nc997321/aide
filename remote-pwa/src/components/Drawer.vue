<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ConnState } from "@aide/sdk";
import type { Session, WorkspaceInfo } from "@aide/sdk/types";
import ProviderLogo from "./ProviderLogo.vue";

/**
 * 左侧抽屉（Kimi 式「历史会话」位）：设备卡 + 供应商徽标 + 工作区切换 +
 * 会话列表（搜索过滤）。数据与动作全部上抛 App（会话/工作区/供应商状态在
 * App 层），本组件只负责展示与本地过滤。
 *
 * 会话项无预览行：last_preview 是协议缺口（list_sessions 应答没有该字段，
 * 需 Rust 侧扩展），PWA v3 先不做。
 */
const props = defineProps<{
  open: boolean;
  connState: ConnState;
  sessions: Session[];
  liveSessions: Set<string>;
  refreshing: boolean;
  workspaces: WorkspaceInfo[];
  /** null = 跟随桌面当前活动工作区 */
  activeWorkspaceKey: string | null;
  /** 当前会话 id（列表高亮）；null = 新会话空白面板 */
  currentSessionId: string | null;
  /** 供应商徽标（App 层挑出：kind 驱动品牌 SVG，icon 回退字符，name 显示名） */
  provider: { kind: string; icon?: string; name: string };
}>();

const emit = defineEmits<{
  close: [];
  openSession: [s: Session];
  newSession: [];
  refresh: [];
  workspaceChange: [key: string];
  /** 供应商徽标 → 与顶栏 pill 同一个弹层（App 层） */
  openProviders: [];
  /** 断开连接：App 层 disconnect + 清凭据 + 回配对屏 */
  quit: [];
}>();

const query = ref("");

/** 搜索过滤：会话名包含（大小写不敏感）。 */
const filtered = computed(() => {
  const kw = query.value.trim().toLowerCase();
  if (!kw) return props.sessions;
  return props.sessions.filter((s) => (s.name || "").toLowerCase().includes(kw));
});

const activeWorkspace = computed(
  () => props.workspaces.find((w) => w.key === props.activeWorkspaceKey) ?? null,
);

// 工作区弹层（从原 SessionList 搬进抽屉）
const wsSheetOpen = ref(false);

function pickWorkspace(key: string): void {
  wsSheetOpen.value = false;
  if (key === props.activeWorkspaceKey) return;
  emit("workspaceChange", key);
}

// 抽屉重开时清搜索词（上次会话的过滤不跨次残留）
watch(
  () => props.open,
  (open) => { if (open) query.value = ""; },
);

const stateDot = computed(() => (props.connState === "authed" ? "ok" : props.connState === "connecting" ? "warn" : "off"));
const stateText = computed(() => {
  switch (props.connState) {
    case "authed": return "已连接 · 桌面 aide";
    case "connecting": return "重连中…";
    case "offline": return "设备离线";
    default: return "未连接";
  }
});

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
  <div class="dr-mask" :class="{ show: open }" @click.self="emit('close')">
    <aside class="dr-panel">
      <!-- 设备卡 -->
      <div class="dr-head">
        <div class="dr-id">
          <!-- src 动态绑定：vitest/jsdom 下静态资产路径会被转成 file:// 导致套件加载失败 -->
          <img :src="'/icon-512.png'" alt="aide" />
          <div class="dr-id-name">
            <b>桌面 aide</b>
            <small><span class="dot" :class="stateDot"></span>{{ stateText }}</small>
          </div>
          <button class="icon-btn" title="断开连接" @click="emit('quit')">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.7 4.3a5.2 5.2 0 1 0 6.6 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <button class="dr-badge" title="切换供应商" @click="emit('openProviders')">
          <ProviderLogo :kind="provider.kind" :icon="provider.icon" :size="12" />
          <span class="dr-badge-name">{{ provider.name }}</span>
          <svg width="9" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <!-- 工作区 chip（弹层搬进抽屉） -->
      <div class="dr-ws">
        <button class="ws-chip" :aria-expanded="wsSheetOpen" @click="wsSheetOpen = true">
          <span class="ws-ic">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3.5c0-.55.45-1 1-1h3l1.6 1.6h5.4c.55 0 1 .45 1 1v7.4c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
          </span>
          <span class="ws-txt">
            <b class="ws-name">{{ activeWorkspace ? activeWorkspace.name : "跟随桌面当前工作区" }}</b>
          </span>
          <span class="ws-caret">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
      </div>

      <div class="dr-sec">
        <b>历史会话</b>
        <button class="icon-btn" title="刷新" @click="emit('refresh')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" :class="{ spinning: refreshing }"><path d="M13.6 8a5.6 5.6 0 1 1-1.65-3.95" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M13.8 1.6v3h-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <div class="dr-list">
        <button
          v-for="s in filtered"
          :key="s.id"
          class="sv-item"
          :class="{ on: s.id === currentSessionId }"
          @click="emit('openSession', s)"
        >
          <div class="sv-row1">
            <span class="sv-name">{{ s.name || "未命名会话" }}</span>
            <span class="sv-time">{{ relTime(s.timestamp) }}</span>
          </div>
          <div v-if="liveSessions.has(s.id)" class="sv-row2">
            <span class="sv-live"><span class="dot"></span>回复中</span>
          </div>
        </button>
        <p v-if="filtered.length === 0" class="dr-none">
          {{ query.trim() ? "无匹配会话" : "暂无会话，点右上 ＋ 开始新会话" }}
        </p>
      </div>

      <div class="dr-search">
        <div class="dr-search-box">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <input v-model="query" type="text" placeholder="搜索会话" />
        </div>
      </div>

      <!-- 工作区选择弹层（底部 sheet，压在抽屉之上） -->
      <div class="ws-mask ws-mask-w" :class="{ show: wsSheetOpen }" @click.self="wsSheetOpen = false">
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
            @click="pickWorkspace(w.key)"
          >
            <span class="ws-ic">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 3.5c0-.55.45-1 1-1h3l1.6 1.6h5.4c.55 0 1 .45 1 1v7.4c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1v-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
            </span>
            <span class="ws-txt">
              <b class="ws-name">{{ w.name }}</b>
              <span v-if="w.missing" class="ws-desc">目录已失效</span>
            </span>
            <svg class="ws-check" width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <p v-if="workspaces.length === 0" class="dr-none">正在加载工作区…</p>
        </div>
      </div>
    </aside>
  </div>
</template>

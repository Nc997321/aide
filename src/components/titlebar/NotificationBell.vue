<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useNotifications } from "../../composables/useNotifications";
import { open } from "@tauri-apps/plugin-shell";
import type { AppNotification } from "../../types";

const { notifications, unreadCount, clearAll, markAllRead, dismiss, triggerAction } =
  useNotifications();

const open2 = ref(false);
const rootRef = ref<HTMLElement | null>(null);

function toggle() {
  open2.value = !open2.value;
  if (open2.value) markAllRead();
}

function onDocClick(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open2.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open2.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});

const badge = computed(() => {
  const c = unreadCount.value;
  if (c === 0) return null;
  return c > 9 ? "9+" : String(c);
});

const SEV_BAR: Record<string, string> = {
  error: "sev-bar sev-error",
  warning: "sev-bar sev-warning",
  info: "sev-bar sev-info",
};

function timeLabel(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function onAction(n: AppNotification) {
  if (n.action?.url) {
    void open(n.action.url);
  } else {
    triggerAction(n.id);
  }
}

// 渲染 body：把 <code>...</code> 转成内联 code 片段（纯文本+code，无 HTML 注入风险）
// body 是 app 内生成的受控字符串，但仍按纯文本处理，只把反引号段包成 <code>。
function bodyParts(body: string | undefined): Array<{ t: "text" | "code"; v: string }> {
  if (!body) return [];
  const parts: Array<{ t: "text" | "code"; v: string }> = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) parts.push({ t: "text", v: body.slice(last, m.index) });
    parts.push({ t: "code", v: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) parts.push({ t: "text", v: body.slice(last) });
  return parts;
}
</script>

<template>
  <div ref="rootRef" class="bell-wrap">
    <button
      class="bell-btn"
      :class="{ 'has-unread': unreadCount > 0 }"
      v-tooltip="'通知'"
      :aria-label="'通知'"
      :aria-expanded="open2"
      @click="toggle"
    >
      <svg class="bell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span v-if="badge" class="bell-badge">{{ badge }}</span>
    </button>

    <Transition name="notif-drop">
      <div v-if="open2" class="notif-panel" role="dialog" aria-label="通知中心">
        <div class="notif-header">
          <span class="notif-title">通知<span v-if="unreadCount > 0" class="notif-count">{{ unreadCount }}</span></span>
          <button class="notif-clear" @click="clearAll">全部清除</button>
        </div>
        <div class="notif-body">
          <div v-if="notifications.length === 0" class="notif-empty">暂无通知</div>
          <div v-for="n in notifications" :key="n.id" class="notif-row" :class="{ unread: !n.read }">
            <div :class="SEV_BAR[n.severity] || 'sev-bar sev-info'"></div>
            <div class="notif-row-inner">
              <div class="notif-row-top">
                <span class="notif-row-title">{{ n.title }}</span>
                <span class="notif-row-time">{{ timeLabel(n.timestamp) }}</span>
              </div>
              <div v-if="n.body" class="notif-row-body">
                <template v-for="(p, i) in bodyParts(n.body)" :key="i">
                  <code v-if="p.t === 'code'" class="inline-code">{{ p.v }}</code>
                  <span v-else>{{ p.v }}</span>
                </template>
              </div>
              <div class="notif-row-foot">
                <span class="src-tag">{{ n.source }}</span>
                <div class="notif-row-actions">
                  <button v-if="n.action" class="action-btn" @click="onAction(n)">{{ n.action.label }}</button>
                </div>
              </div>
            </div>
            <button class="notif-dismiss" v-tooltip="'忽略'" @click.stop="dismiss(n.id)">✕</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.bell-wrap { position: relative; display: flex; align-items: center; height: 100%; }

.bell-btn {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; margin: 0 4px;
  background: none; border: 1px solid transparent; border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted); cursor: pointer; position: relative; transition: all var(--aide-ease-t);
}
.bell-btn:hover { color: var(--aide-text-primary); background: var(--aide-surface-default); }
.bell-btn.has-unread { color: var(--aide-text-secondary); }
.bell-icon { width: 15px; height: 15px; }
.bell-badge {
  position: absolute; top: 3px; right: 3px;
  min-width: 14px; height: 14px; padding: 0 4px;
  background: var(--aide-danger); color: var(--aide-text-on-accent);
  font-size: 9px; font-weight: 700; line-height: 14px; text-align: center;
  border-radius: 7px; border: 1.5px solid var(--aide-bg-deep);
}

.notif-panel {
  position: absolute; top: calc(100% + 6px); right: 0;
  width: 360px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 900; overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
}
.notif-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aide-border);
  background: linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%), var(--aide-bg-raised);
}
.notif-title {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}
.notif-count { color: var(--aide-accent); margin-left: 6px; }
.notif-clear {
  background: none; border: none; color: var(--aide-text-muted);
  font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: var(--aide-radius-sm);
  font-family: inherit; transition: all 0.12s;
}
.notif-clear:hover { color: var(--aide-text-primary); background: var(--aide-surface-default); }

.notif-body { max-height: 420px; overflow-y: auto; }
.notif-empty { padding: 28px 16px; text-align: center; color: var(--aide-text-muted); font-size: 12px; }

.notif-row {
  display: flex; align-items: stretch; gap: 0;
  border-bottom: 1px solid var(--aide-border);
  transition: background 0.1s;
}
.notif-row:last-child { border-bottom: none; }
.notif-row:hover { background: color-mix(in srgb, var(--aide-surface-default) 50%, transparent); }

.sev-bar { width: 3px; flex-shrink: 0; align-self: stretch; }
.sev-error { background: var(--aide-danger); }
.sev-warning { background: var(--aide-warning); }
.sev-info { background: var(--aide-info); }

.notif-row-inner { flex: 1; min-width: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.notif-row-top { display: flex; align-items: center; gap: 8px; }
.notif-row-title {
  font-size: 12.5px; font-weight: 600; color: var(--aide-text-primary);
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.notif-row-time { font-size: 10px; color: var(--aide-text-muted); flex-shrink: 0; }
.notif-row-body { font-size: 11.5px; color: var(--aide-text-secondary); line-height: 1.5; word-break: break-word; }
.inline-code {
  background: var(--aide-surface-default); padding: 0 4px; border-radius: 3px;
  font-family: var(--aide-font-mono); font-size: 10.5px; color: var(--aide-text-secondary);
}
.notif-row-foot { display: flex; align-items: center; gap: 8px; margin-top: 1px; }
.src-tag {
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase;
  color: var(--aide-text-muted); background: var(--aide-surface-default);
  padding: 1px 6px; border-radius: 8px;
}
.notif-row-actions { display: flex; align-items: center; gap: 10px; }
.action-btn {
  font-size: 11px; color: var(--aide-accent); cursor: pointer;
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 22%, transparent);
  padding: 3px 10px; border-radius: var(--aide-radius-sm); font-family: inherit;
  transition: all 0.12s;
}
.action-btn:hover { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent); }

.notif-dismiss {
  width: 18px; height: 18px; margin: 0 6px; align-self: center;
  display: flex; align-items: center; justify-content: center;
  color: var(--aide-text-muted); cursor: pointer; border-radius: var(--aide-radius-sm);
  font-size: 12px; opacity: 0; transition: opacity 0.12s; background: none; border: none;
}
.notif-row:hover .notif-dismiss { opacity: 1; }
.notif-dismiss:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }

/* 下拉过渡 */
.notif-drop-enter-active, .notif-drop-leave-active { transition: opacity var(--aide-ease-t), transform var(--aide-ease-t); }
.notif-drop-enter-from, .notif-drop-leave-to { opacity: 0; transform: translateY(-4px); }

@media (prefers-reduced-motion: reduce) {
  .notif-drop-enter-active, .notif-drop-leave-active { transition: none; }
}
</style>
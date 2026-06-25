<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed } from "vue";
import { useSessionState } from "../composables/useSessionState";
import { useTerminalManager } from "../composables/useTerminalManager";
import { AToolbar, AStatusDot, AButton } from "../ui";
import { api } from "../api";
import "xterm/css/xterm.css";

const props = defineProps<{ sessionId: string; workspacePath: string }>();
const emit = defineEmits<{ "session-updated": [newId?: string] }>();

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Preview content ──

const stackRef = ref<HTMLDivElement>();
const previewRef = ref<HTMLDivElement>();
const previewHtml = ref("");

async function loadPreviewContent(sid: string) {
  if (sid.startsWith("new_")) {
    previewHtml.value = "";
    return;
  }
  try {
    const messages = await api.loadMessages(sid);
    const recent = messages.slice(-50);
    if (recent.length === 0) { previewHtml.value = ""; return; }
    const { marked } = await import("../utils/markdown");
    let html = "";
    for (const m of recent) {
      const who = m.role === "user" ? "You" : "Claude";
      html += `<div class="preview-msg preview-msg--${m.role}">`;
      html += `<div class="preview-msg__who">${who}</div>`;
      html += `<div class="preview-msg__body">`;
      if (m.role === "user") {
        html += `<div class="preview-text">${escapeHtml(m.content)}</div>`;
      } else {
        try {
          html += `<div class="preview-text">${marked.parse(m.content)}</div>`;
        } catch {
          html += `<div class="preview-text">${escapeHtml(m.content)}</div>`;
        }
      }
      html += `</div></div>`;
    }
    previewHtml.value = html;
    await nextTick();
    if (previewRef.value) {
      previewRef.value.scrollTop = previewRef.value.scrollHeight;
    }
  } catch (_) {
    previewHtml.value = "";
  }
}

// ── Terminal manager ──

const {
  liveDisplayIds,
  currentSid,
  showSession,
  startClaude,
  stopClaude,
  resetView,
  initPtyListener,
  initExitListener,
  initDragDrop,
  cleanup,
} = useTerminalManager(stackRef, previewRef, (newId) => emit("session-updated", newId), loadPreviewContent);

// ── Toolbar state ──

const { state: sessionState } = useSessionState();

const currentStatus = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "stopped" as const;
  return (sessionState[sid] || "stopped") as "stopped" | "running" | "waiting" | "attention";
});

const displayName = ref("");

const sessionName = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "";
  if (sid.startsWith("new_")) return "新会话";
  return displayName.value || sid.substring(0, 8);
});

const isLive = computed(() => liveDisplayIds.has(props.sessionId));

// ── Keyboard & click handlers ──

function tryStartClaude() {
  const sid = props.sessionId;
  if (sid && !liveDisplayIds.has(sid)) startClaude(sid);
}

function onPreviewKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") tryStartClaude();
}

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
  if (!previewRef.value || previewRef.value.style.display === "none") return;
  tryStartClaude();
}

function onPreviewClick() {
  tryStartClaude();
}

// ── Watch session changes ──

watch(() => props.workspacePath, () => {
  resetView();
});

watch(() => props.sessionId, async (newId) => {
  if (newId !== currentSid()) {
    showSession(newId);
    if (newId) await loadPreviewContent(newId);
  }
  // Look up display name for the toolbar
  if (newId && !newId.startsWith("new_")) {
    try {
      const sessions = await api.listSessions();
      const s = sessions.find(sess => sess.id === newId);
      displayName.value = s?.name || "";
    } catch { displayName.value = ""; }
  } else {
    displayName.value = "";
  }
});

// ── Lifecycle ──

onMounted(async () => {
  window.addEventListener("keydown", onWindowKeydown);
  await initPtyListener();
  await initExitListener();
  await initDragDrop();
  await nextTick();
  showSession(props.sessionId);
  await loadPreviewContent(props.sessionId);
});

function restartSession(sid: string) {
  stopClaude(sid);
  setTimeout(() => startClaude(sid), 300);
}

defineExpose({ restartSession, resetView });

onUnmounted(() => {
  window.removeEventListener("keydown", onWindowKeydown);
  cleanup();
});
</script>

<template>
  <div class="terminal-panel">
    <AToolbar>
      <template #left>
        <AStatusDot :status="currentStatus" />
        <span class="toolbar-session-name">{{ sessionName }}</span>
      </template>
      <template #right>
        <AButton v-if="!isLive" variant="ghost" size="sm" @click="tryStartClaude">
          ▶ 启动
        </AButton>
        <AButton v-if="isLive" variant="danger" size="sm" @click="stopClaude(props.sessionId)">
          ⏹ 停止
        </AButton>
      </template>
    </AToolbar>
    <div ref="stackRef" class="terminal-stack">
      <div
        ref="previewRef"
        class="terminal-container preview-container"
        tabindex="0"
        @keydown="onPreviewKeydown"
      >
        <div v-if="props.sessionId && props.sessionId.startsWith('new_')" class="preview-empty" @click="onPreviewClick">
          <div class="preview-empty__title">New Session</div>
          <div class="preview-empty__hint">Press Enter or click Start</div>
        </div>
        <template v-else-if="previewHtml">
          <div class="preview-messages" v-html="previewHtml"></div>
          <div class="preview-footer" @click="onPreviewClick">Press Enter to continue</div>
        </template>
        <div v-else class="preview-empty" @click="onPreviewClick">
          <div class="preview-empty__title">Session {{ (props.sessionId || '').substring(0, 8) }}</div>
          <div class="preview-empty__hint">Press Enter or click Start</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.terminal-stack { flex: 1; position: relative; }
.terminal-container { position: absolute; inset: 0; overflow: hidden; }
.terminal-container .xterm { padding: 8px; height: 100%; }
.terminal-container .xterm-viewport { scrollbar-width: thin; scrollbar-color: var(--aide-surface-default) transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar { width: 6px; }
.terminal-container .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb { background: var(--aide-surface-default); border-radius: 3px; }

/* ── File drop overlay ── */

.terminal-drop-overlay {
  position: absolute; inset: 0; z-index: 25;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--aide-bg-base) 85%, transparent);
  border: 2px dashed var(--aide-accent);
  border-radius: var(--aide-radius-md);
  margin: 8px;
  animation: drop-fade-in 0.15s ease-out;
  pointer-events: none;
}
.terminal-drop-overlay__inner {
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  color: var(--aide-accent);
  font-size: 14px; font-weight: 500;
}
.terminal-drop-overlay__inner svg { opacity: 0.8; }
@keyframes drop-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

/* ── Session loader overlay ── */

.session-loader {
  position: absolute; inset: 0; z-index: 20;
  display: flex; align-items: center; justify-content: center;
  background: var(--aide-bg-base); /* #1e1e2e — same as terminal */
  transition: opacity 0.3s ease, visibility 0.3s ease;
}
.session-loader--out { opacity: 0; visibility: hidden; pointer-events: none; }

.session-loader__glow {
  position: absolute;
  width: 260px; height: 260px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--aide-info) 10%, transparent) 0%, transparent 70%);
  animation: loader-glow-pulse 2.2s ease-in-out infinite;
}
@keyframes loader-glow-pulse {
  0%, 100% { transform: scale(0.92); opacity: 0.6; }
  50%      { transform: scale(1.06); opacity: 1; }
}

.session-loader__card {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}

/* Hex icon */
.session-loader__hex {
  font-size: 40px; line-height: 1;
  color: var(--aide-accent); /* #89b4fa */
  animation: loader-hex-float 3s ease-in-out infinite;
}
@keyframes loader-hex-float {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-5px); }
}

.session-loader__title {
  font-size: 18px; font-weight: 600; letter-spacing: 0.04em;
  color: var(--aide-text-primary);
}

.session-loader__sub {
  font-size: 12px; color: var(--aide-text-muted);
  display: flex; align-items: center; gap: 0;
}

/* Animated dots */
.session-loader__dots span {
  display: inline-block;
  animation: loader-dot-blink 1.4s infinite both;
  width: 0.5em; text-align: left;
}
.session-loader__dots span:nth-child(1) { animation-delay: 0.0s; }
.session-loader__dots span:nth-child(2) { animation-delay: 0.2s; }
.session-loader__dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes loader-dot-blink {
  0%, 80%, 100% { opacity: 0.2; }
  40%            { opacity: 1; }
}

/* Progress track */
.session-loader__track {
  width: 180px; height: 3px;
  background: var(--aide-surface-default); /* #313244 */
  border-radius: 3px; overflow: hidden;
}
.session-loader__bar {
  height: 100%; width: 35%;
  background: var(--aide-accent);
  border-radius: 3px;
  animation: loader-bar-shimmer 1.8s ease-in-out infinite;
}
@keyframes loader-bar-shimmer {
  0%   { transform: translateX(-60%); }
  100% { transform: translateX(320%); }
}

.preview-container {
  overflow-y: auto;
  outline: none;
  padding: 16px 20px;
}

.preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--aide-text-muted);
}
.preview-empty__title { font-size: 15px; color: var(--aide-text-secondary); }
.preview-empty__hint { font-size: 12px; }

.preview-messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.preview-footer {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--aide-surface-hover);
  text-align: center;
  font-size: 12px;
  color: var(--aide-text-muted);
}

.preview-msg__who {
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.preview-msg--user .preview-msg__who { color: var(--aide-accent); }
.preview-msg--claude .preview-msg__who { color: #cba6f7; /* Claude purple — brand color, intentionally not tokenized */ }

.preview-msg__body {
  font-size: 13px;
  line-height: 1.65;
  color: var(--aide-text-primary);
}

.preview-text h1 { font-size: 1.4em; font-weight: 600; margin: 1em 0 0.4em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.2em; }
.preview-text h1:first-child { margin-top: 0; }
.preview-text h2 { font-size: 1.2em; font-weight: 600; margin: 0.9em 0 0.3em; border-bottom: 1px solid var(--aide-surface-hover); padding-bottom: 0.15em; }
.preview-text h2:first-child { margin-top: 0; }
.preview-text h3 { font-size: 1.05em; font-weight: 600; margin: 0.8em 0 0.2em; }
.preview-text h3:first-child { margin-top: 0; }
.preview-text h4 { font-size: 1em; font-weight: 600; margin: 0.7em 0 0.2em; }

.preview-text p { margin: 0.4em 0; }
.preview-text a { color: var(--aide-accent); text-decoration: none; }
.preview-text a:hover { text-decoration: underline; }

.preview-text ul, .preview-text ol { padding-left: 1.5em; margin: 0.3em 0; }
.preview-text li { margin: 0.15em 0; }

.preview-text blockquote {
  margin: 0.4em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border-radius: 0 4px 4px 0;
}

.preview-text code {
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 0.88em;
  background: var(--aide-bg-deep);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--aide-warning);
}

.preview-text pre {
  margin: 0.6em 0;
  border-radius: 6px;
  overflow: hidden;
}
.preview-text pre code {
  display: block;
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border-radius: 6px;
  overflow-x: auto;
}

.preview-text table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 12px;
}
.preview-text th, .preview-text td {
  border: 1px solid var(--aide-surface-hover);
  padding: 6px 10px;
  text-align: left;
}
.preview-text th { background: var(--aide-bg-deep); font-weight: 600; }
.preview-text tr:nth-child(even) td { background: var(--aide-border-subtle); }

.preview-text hr {
  border: none;
  border-top: 1px solid var(--aide-surface-hover);
  margin: 0.8em 0;
}

.preview-text img { max-width: 100%; border-radius: 4px; }

.preview-text .hljs-keyword,
.preview-text .hljs-selector-tag,
.preview-text .hljs-type { color: #cba6f7; }
.preview-text .hljs-string,
.preview-text .hljs-addition,
.preview-text .hljs-regexp { color: #a6e3a1; }
.preview-text .hljs-number,
.preview-text .hljs-literal,
.preview-text .hljs-variable,
.preview-text .hljs-template-variable,
.preview-text .hljs-tag .hljs-attr { color: #fab387; }
.preview-text .hljs-comment,
.preview-text .hljs-quote { color: #6c7086; font-style: italic; }
.preview-text .hljs-title,
.preview-text .hljs-title.class_,
.preview-text .hljs-title.class_.inherited__,
.preview-text .hljs-title.function_ { color: #89b4fa; }
.preview-text .hljs-meta,
.preview-text .hljs-meta .hljs-keyword,
.preview-text .hljs-section { color: #89b4fa; }
.preview-text .hljs-attr,
.preview-text .hljs-attribute,
.preview-text .hljs-property { color: #89dceb; }
.preview-text .hljs-built_in,
.preview-text .hljs-symbol,
.preview-text .hljs-params { color: #f9e2af; }
.preview-text .hljs-tag,
.preview-text .hljs-selector-class,
.preview-text .hljs-selector-id { color: #f38ba8; }
.preview-text .hljs-emphasis { font-style: italic; }
.preview-text .hljs-strong { font-weight: bold; }
.preview-text .hljs-link { color: #89b4fa; text-decoration: underline; }
.preview-text .hljs-deletion { color: #f38ba8; }
</style>

<style scoped>
.terminal-panel { height: 100%; width: 100%; display: flex; flex-direction: column; position: relative; }
.toolbar-session-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

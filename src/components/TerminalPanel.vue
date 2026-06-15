<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, reactive, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { useSessionState } from "../composables/useSessionState";
import { Marked } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import plaintext from "highlight.js/lib/languages/plaintext";
import "xterm/css/xterm.css";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ "session-updated": [] }>();

interface BackendMsg { role: string; content: string; timestamp: number; }

// ── Markdown renderer setup (reuse marked + hljs, same as FileViewer) ──

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("plaintext", plaintext);

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      if (lang && hljs.getLanguage(lang)) {
        const result = hljs.highlight(text, { language: lang });
        return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`;
      }
      const result = hljs.highlightAuto(text);
      return `<pre><code class="hljs">${result.value}</code></pre>`;
    },
  },
});

// ── Preview content (HTML div, replaces xterm preview) ──

const stackRef = ref<HTMLDivElement>();
const previewRef = ref<HTMLDivElement>();
const previewMessages = ref<BackendMsg[]>([]);
let unlistenPty: UnlistenFn | null = null;

// ── Live terminals (one per running Claude) ──

interface LiveSession {
  div: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  observer: ResizeObserver;
}
const liveSessions = new Map<string, LiveSession>();

// ptyId → displayId for migrated sessions (new_xxx → real UUID)
const ptyToDisplay = new Map<string, string>();

// Reactive mirror for template
const liveDisplayIds = reactive(new Set<string>());

// Currently visible session
let currentSid = "";

// ── Session state tracking (shared with SidebarLeft) ──

const { setSessionState, removeSessionState } = useSessionState();
const periodicTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Read the last ~3 rendered lines from a live terminal's buffer. */
function terminalTailLines(ptyId: string): string {
  const ls = liveSessions.get(ptyId);
  if (!ls) return "";
  const buf = ls.terminal.buffer.active;
  const last = Math.max(0, buf.length - 3);
  const lines: string[] = [];
  for (let i = last; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

function startPeriodicCheck(ptyId: string) {
  if (periodicTimers.has(ptyId)) return;

  // First check after 2s (let Claude initialize)
  setTimeout(() => checkSessionState(ptyId), 2000);

  // Then check every 2s — authoritative state from .jsonl
  const timer = setInterval(() => checkSessionState(ptyId), 2000);
  periodicTimers.set(ptyId, timer);
}

function stopPeriodicCheck(ptyId: string) {
  const timer = periodicTimers.get(ptyId);
  if (timer) {
    clearInterval(timer);
    periodicTimers.delete(ptyId);
  }
}

async function checkSessionState(ptyId: string) {
  const displayId = ptyToDisplay.get(ptyId) || ptyId;

  // Permission prompt (check first — overrides everything)
  const tail = terminalTailLines(ptyId);
  if (/Do you want to proceed|\[y\/n\]|needs?\s+(your\s+)?permission/i.test(tail)) {
    setSessionState(displayId, "attention");
    return;
  }

  // Authoritative: .jsonl last event type
  // Only use it to CONFIRM "waiting" — never to force "running"
  try {
    const lastEvent = await invoke<string | null>("session_last_event", { sessionId: displayId });
    if (lastEvent === "assistant") {
      setSessionState(displayId, "waiting");
      return;
    }
  } catch (_) { /* fall through */ }

  // Fallback: if Claude shows `> ` prompt, confirm waiting
  if (/>\s*$/.test(tail.trimEnd())) {
    setSessionState(displayId, "waiting");
  }
}

// ── Terminal factory ──

function makeTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
    theme: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

// ── Show a session ──

function showSession(sid: string) {
  if (!sid || sid === currentSid) return;
  currentSid = sid;

  // Hide everything
  if (previewRef.value) previewRef.value.style.display = "none";
  for (const [, ls] of liveSessions) ls.div.style.display = "none";

  // Resolve PTY ID: is this display ID a migrated session?
  let ptyId = sid;
  if (!liveSessions.has(ptyId)) {
    for (const [pid, did] of ptyToDisplay) {
      if (did === sid) { ptyId = pid; break; }
    }
  }

  if (liveSessions.has(ptyId)) {
    // Live — show the session's own terminal
    const ls = liveSessions.get(ptyId)!;
    ls.div.style.display = "";
    nextTick(() => ls.fitAddon.fit());
  } else {
    // Preview — show HTML preview div
    if (previewRef.value) previewRef.value.style.display = "";
    loadPreviewContent(sid);
  }
}

// ── Preview content ──

async function loadPreviewContent(sid: string) {
  if (sid.startsWith("new_")) {
    previewMessages.value = [];
    return;
  }
  try {
    previewMessages.value = await invoke<BackendMsg[]>("load_messages", { sessionId: sid });
  } catch (_) {
    previewMessages.value = [];
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const previewHtml = computed(() => {
  if (previewMessages.value.length === 0) return "";
  let html = "";
  for (const m of previewMessages.value) {
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
  return html;
});

function onPreviewKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    const sid = props.sessionId;
    if (sid && !liveDisplayIds.has(sid)) startClaude();
  }
}

// ── Start Claude → create a live terminal ──

function startClaude() {
  const sid = props.sessionId;
  if (!sid || !stackRef.value || liveSessions.has(sid)) return;

  // Resolve PTY ID
  let ptyId = sid;
  for (const [pid, did] of ptyToDisplay) {
    if (did === sid) { ptyId = pid; break; }
  }
  if (liveSessions.has(ptyId)) return;

  // Create DOM element, append hidden, then show before opening xterm
  const div = document.createElement("div");
  div.className = "terminal-container";
  div.style.display = "none";
  stackRef.value.appendChild(div);

  // Hide preview div, show this div FIRST so it has correct dimensions
  if (previewRef.value) previewRef.value.style.display = "none";
  div.style.display = "";

  // Now create and open terminal — div is visible, dimensions are correct
  const { terminal, fitAddon } = makeTerminal();
  terminal.open(div);
  fitAddon.fit();

  // I/O bound directly to this session
  terminal.onData((data) => {
    invoke("pty_write", { sessionId: ptyId, data }).catch(() => {});
    // User pressed Enter → just sent a message → Claude will start processing
    if (data === "\r") {
      setSessionState(sid, "running");
    }
  });

  const observer = new ResizeObserver(() => {
    fitAddon.fit();
    invoke("pty_resize", { sessionId: ptyId, rows: terminal.rows, cols: terminal.cols }).catch(() => {});
  });
  observer.observe(div);

  liveSessions.set(ptyId, { div, terminal, fitAddon, observer });
  liveDisplayIds.add(sid);
  currentSid = sid;

  startPeriodicCheck(ptyId);
  // Default to waiting — session just opened, Claude isn't processing yet
  setSessionState(sid, "waiting");
  terminal.writeln("Starting Claude...\r");

  invoke("pty_spawn_claude", { sessionId: ptyId, rows: terminal.rows, cols: terminal.cols })
    .catch((e) => {
      terminal.writeln(`\r\nFailed: ${e}`);
      destroyLiveSession(ptyId);
    });

  if (ptyId.startsWith("new_")) {
    scheduleMigration(ptyId);
  }
}

function destroyLiveSession(ptyId: string) {
  const ls = liveSessions.get(ptyId);
  if (!ls) return;
  ls.observer.disconnect();
  ls.terminal.dispose();
  ls.div.remove();
  liveSessions.delete(ptyId);

  const displayId = ptyToDisplay.get(ptyId) || ptyId;
  liveDisplayIds.delete(displayId);
  ptyToDisplay.delete(ptyId);

  // Clean up state tracking
  removeSessionState(displayId);
  stopPeriodicCheck(ptyId);

  // If we were viewing this session, fall back to preview
  if (currentSid === displayId || currentSid === ptyId) {
    currentSid = "";
    showSession(displayId);
  }
}

// ── Stop Claude ──

function stopClaude() {
  const sid = props.sessionId;
  if (!sid) return;

  let ptyId = sid;
  if (!liveSessions.has(ptyId)) {
    for (const [pid, did] of ptyToDisplay) {
      if (did === sid) { ptyId = pid; break; }
    }
  }
  if (!liveSessions.has(ptyId)) return;

  invoke("pty_kill", { sessionId: ptyId }).catch(() => {});
  destroyLiveSession(ptyId);
}

// ── Migration: new_xxx → real UUID ──

async function scheduleMigration(placeholderId: string) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const sessions = await invoke<{ id: string }[]>("list_sessions");
    // Find the newly created session (not a placeholder, not already tracked)
    const real = sessions.find((s) =>
      !s.id.startsWith("new_") &&
      !liveSessions.has(s.id) &&
      !Array.from(ptyToDisplay.values()).includes(s.id),
    );
    if (real && liveSessions.has(placeholderId)) {
      ptyToDisplay.set(placeholderId, real.id);
      liveDisplayIds.delete(placeholderId);
      liveDisplayIds.add(real.id);

      // Migrate session state key (keep whatever state the PTY is in)
      removeSessionState(placeholderId);

      invoke("pty_rename_session", { oldId: placeholderId, newId: real.id }).catch(() => {});
    }
  } catch (_) { /* best effort */ }
  emit("session-updated");
}

// ── Session switching ──

watch(() => props.sessionId, (newId) => {
  if (newId && newId !== currentSid) {
    showSession(newId);
  }
});

// ── Lifecycle ──

onMounted(async () => {
  // pty-output → route directly to the right live terminal
  unlistenPty = await listen<string>("pty-output", (event) => {
    try {
      const p = JSON.parse(event.payload);
      liveSessions.get(p.session_id)?.terminal.write(p.data);
    } catch (_) {}
  });

  nextTick(() => showSession(props.sessionId));
});

onUnmounted(() => {
  unlistenPty?.();
  // Clean up all timers
  for (const [, timer] of periodicTimers) clearInterval(timer);
  periodicTimers.clear();
  // Destroy all live sessions
  for (const [ptyId] of liveSessions) {
    invoke("pty_kill", { sessionId: ptyId }).catch(() => {});
    const ls = liveSessions.get(ptyId)!;
    ls.observer.disconnect();
    ls.terminal.dispose();
  }
  liveSessions.clear();
  liveDisplayIds.clear();
  ptyToDisplay.clear();
});
</script>

<template>
  <div class="terminal-panel">
    <div ref="stackRef" class="terminal-stack">
      <div
        ref="previewRef"
        class="terminal-container preview-container"
        tabindex="0"
        @keydown="onPreviewKeydown"
      >
        <div v-if="props.sessionId && props.sessionId.startsWith('new_')" class="preview-empty">
          <div class="preview-empty__title">New Session</div>
          <div class="preview-empty__hint">Press Enter to start</div>
        </div>
        <div v-else-if="previewHtml" class="preview-messages" v-html="previewHtml"></div>
        <div v-else class="preview-empty">
          <div class="preview-empty__title">Session {{ (props.sessionId || '').substring(0, 8) }}</div>
          <div class="preview-empty__hint">Press Enter to start</div>
        </div>
      </div>
    </div>
    <button
      v-if="liveDisplayIds.has(props.sessionId)"
      class="close-btn"
      title="Stop Claude"
      @click="stopClaude"
    >&#x23F9;</button>
  </div>
</template>

<style>
/* Non-scoped — applies to dynamically created terminals too */
.terminal-stack { flex: 1; position: relative; }
.terminal-container { position: absolute; inset: 0; overflow: hidden; }
.terminal-container .xterm { padding: 8px; height: 100%; }
.terminal-container .xterm-viewport { scrollbar-width: thin; scrollbar-color: var(--surface) transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar { width: 6px; }
.terminal-container .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
.terminal-container .xterm-viewport::-webkit-scrollbar-thumb { background: var(--surface); border-radius: 3px; }

/* ── Preview content (HTML div, replaces xterm preview) ── */
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
  color: var(--text-muted);
}
.preview-empty__title { font-size: 15px; color: var(--text-secondary); }
.preview-empty__hint { font-size: 12px; }

.preview-messages {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 32px;
}

.preview-msg__who {
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.preview-msg--user .preview-msg__who { color: var(--accent); }
.preview-msg--claude .preview-msg__who { color: #cba6f7; }

.preview-msg__body {
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-primary);
}

/* Markdown rendered content inside preview messages */
.preview-text h1 { font-size: 1.4em; font-weight: 600; margin: 1em 0 0.4em; border-bottom: 1px solid var(--surface-hover); padding-bottom: 0.2em; }
.preview-text h1:first-child { margin-top: 0; }
.preview-text h2 { font-size: 1.2em; font-weight: 600; margin: 0.9em 0 0.3em; border-bottom: 1px solid var(--surface-hover); padding-bottom: 0.15em; }
.preview-text h2:first-child { margin-top: 0; }
.preview-text h3 { font-size: 1.05em; font-weight: 600; margin: 0.8em 0 0.2em; }
.preview-text h3:first-child { margin-top: 0; }
.preview-text h4 { font-size: 1em; font-weight: 600; margin: 0.7em 0 0.2em; }

.preview-text p { margin: 0.4em 0; }
.preview-text a { color: var(--accent); text-decoration: none; }
.preview-text a:hover { text-decoration: underline; }

.preview-text ul, .preview-text ol { padding-left: 1.5em; margin: 0.3em 0; }
.preview-text li { margin: 0.15em 0; }

.preview-text blockquote {
  margin: 0.4em 0;
  padding: 4px 12px;
  border-left: 3px solid var(--accent);
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 0 4px 4px 0;
}

.preview-text code {
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas", monospace;
  font-size: 0.88em;
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
  color: #fab387;
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
  color: var(--text-primary);
  background: var(--bg-tertiary);
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
  border: 1px solid var(--surface-hover);
  padding: 6px 10px;
  text-align: left;
}
.preview-text th { background: var(--bg-tertiary); font-weight: 600; }
.preview-text tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }

.preview-text hr {
  border: none;
  border-top: 1px solid var(--surface-hover);
  margin: 0.8em 0;
}

.preview-text img { max-width: 100%; border-radius: 4px; }

/* hljs overrides inside preview markdown code blocks */
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
.close-btn { position: absolute; top: 8px; right: 8px; background: var(--surface); border: 1px solid var(--surface-hover); color: var(--text-secondary); font-size: 12px; padding: 2px 8px; border-radius: 4px; cursor: pointer; opacity: 0.6; transition: opacity 0.15s, color 0.15s; z-index: 10; }
.close-btn:hover { opacity: 1; color: #f38ba8; }
</style>

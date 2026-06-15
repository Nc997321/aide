<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ "session-updated": [] }>();

interface BackendMsg { role: string; content: string; timestamp: number; }

// ── Preview terminal (shared, always exists) ──

const stackRef = ref<HTMLDivElement>();
const previewRef = ref<HTMLDivElement>();
let unlistenPty: UnlistenFn | null = null;
let previewTerminal: Terminal | null = null;
let previewFitAddon: FitAddon | null = null;
let previewObserver: ResizeObserver | null = null;

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

// ── Init preview terminal (once) ──

function initPreview() {
  if (!previewRef.value || previewTerminal) return;
  const { terminal, fitAddon } = makeTerminal();
  previewTerminal = terminal;
  previewFitAddon = fitAddon;
  terminal.open(previewRef.value);
  terminal.onData((data) => {
    if (data === "\r") {
      const sid = props.sessionId;
      if (sid && !liveDisplayIds.has(sid)) startClaude();
    }
  });
  nextTick(() => fitAddon.fit());

  previewObserver = new ResizeObserver(() => fitAddon.fit());
  previewObserver.observe(previewRef.value);
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
    // Preview — show shared preview terminal
    if (previewRef.value) previewRef.value.style.display = "";
    nextTick(() => previewFitAddon?.fit());
    showPreviewContent(sid);
  }
}

// ── Preview content ──

async function showPreviewContent(sid: string) {
  if (!previewTerminal) return;
  previewTerminal.clear();

  if (sid.startsWith("new_")) {
    previewTerminal.writeln("\r\n  New Session\r");
    previewTerminal.writeln("  Press Enter to start\r\n");
    return;
  }

  previewTerminal.writeln(`\r\n  Session ${sid.substring(0, 8)}\r\n`);

  try {
    const msgs = await invoke<BackendMsg[]>("load_messages", { sessionId: sid });
    for (const m of msgs) {
      const who = m.role === "user" ? "\x1b[34mYou\x1b[0m" : "\x1b[35mClaude\x1b[0m";
      previewTerminal.writeln(`  ${who}`);
      for (const line of m.content.split("\n")) {
        previewTerminal.writeln(`  ${line}`);
      }
      previewTerminal.writeln("");
    }
  } catch (_) {
    previewTerminal.writeln("  (messages unavailable)\r");
  }

  previewTerminal.writeln("  ─────────────────────\r");
  previewTerminal.writeln("  Press Enter to start\r\n");
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

  // Hide preview, show this div FIRST so it has correct dimensions
  if (previewRef.value) previewRef.value.style.display = "none";
  div.style.display = "";

  // Now create and open terminal — div is visible, dimensions are correct
  const { terminal, fitAddon } = makeTerminal();
  terminal.open(div);
  fitAddon.fit();

  // I/O bound directly to this session
  terminal.onData((data) => {
    invoke("pty_write", { sessionId: ptyId, data }).catch(() => {});
  });

  const observer = new ResizeObserver(() => {
    fitAddon.fit();
    invoke("pty_resize", { sessionId: ptyId, rows: terminal.rows, cols: terminal.cols }).catch(() => {});
  });
  observer.observe(div);

  liveSessions.set(ptyId, { div, terminal, fitAddon, observer });
  liveDisplayIds.add(sid);
  currentSid = sid;

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
  initPreview();

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
  previewObserver?.disconnect();
  previewTerminal?.dispose();
  previewTerminal = null;
});
</script>

<template>
  <div class="terminal-panel">
    <div ref="stackRef" class="terminal-stack">
      <div ref="previewRef" class="terminal-container" />
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
</style>

<style scoped>
.terminal-panel { height: 100%; width: 100%; display: flex; flex-direction: column; position: relative; }
.close-btn { position: absolute; top: 8px; right: 8px; background: var(--surface); border: 1px solid var(--surface-hover); color: var(--text-secondary); font-size: 12px; padding: 2px 8px; border-radius: 4px; cursor: pointer; opacity: 0.6; transition: opacity 0.15s, color 0.15s; z-index: 10; }
.close-btn:hover { opacity: 1; color: #f38ba8; }
</style>

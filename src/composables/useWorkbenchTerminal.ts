import { ref, watch, computed } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSettings } from "./useSettings";
import { catppuccinMochaTheme } from "../utils/xterm";

export interface WbTab {
  id: string;
  label: string;
  shellName: string;
  exited: boolean;
}

interface WbSession {
  id: string;
  label: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  div: HTMLDivElement;
  observer: ResizeObserver;
  spawned: boolean;
  exited: boolean;
  shellName: string;
}

// Module-level state shared across all useWorkbenchTerminal() calls.
const sessions = new Map<string, WbSession>();
const tabs = ref<WbTab[]>([]);
const activeId = ref("");
const visible = ref(false);
let containerEl: HTMLDivElement | null = null;
let nextIdx = 1;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unlistenExit: UnlistenFn | null = null;

let settingsRef: ReturnType<typeof useSettings>["settings"] | null = null;
let watchersInitialized = false;

function ensureSettingsWatchers() {
  if (watchersInitialized) return;
  watchersInitialized = true;
  const { settings } = useSettings();
  settingsRef = settings;
  watch(() => settings.fontSize, (v) => {
    for (const [, s] of sessions) {
      s.terminal.options.fontSize = v;
      s.fitAddon.fit();
    }
  });
  watch(() => settings.fontFamily, (v) => {
    for (const [, s] of sessions) {
      s.terminal.options.fontFamily = v;
    }
  });
}

function deriveShellName(path: string): string {
  if (!path) return "";
  const base = path.split(/[\\/]/).pop() || path;
  const lower = base.toLowerCase();
  if (lower === "pwsh.exe" || lower === "pwsh") return "PowerShell 7";
  if (lower === "powershell.exe" || lower === "powershell") return "PowerShell";
  if (lower === "bash.exe" || lower === "bash") return "bash";
  if (lower === "sh") return "sh";
  if (lower === "zsh") return "zsh";
  return base;
}

function syncTabs() {
  tabs.value = Array.from(sessions.values()).map(s => ({
    id: s.id,
    label: s.label,
    shellName: s.shellName,
    exited: s.exited,
  }));
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    for (const [, s] of sessions) {
      if (!s.spawned) continue;
      try {
        const data = await api.pollPtyOutput(s.id);
        if (data) s.terminal.write(data);
      } catch (_) { /* ignore */ }
    }
  }, 100);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function ensureExitListener() {
  if (unlistenExit) return;
  listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload);
      const s = sessions.get(p.session_id);
      if (s) {
        s.exited = true;
        s.spawned = false;
        syncTabs();
      }
    } catch (_) { /* ignore */ }
  }).then((fn) => { unlistenExit = fn; });
}

export function useWorkbenchTerminal() {
  ensureSettingsWatchers();

  const activeExited = computed(() => {
    const tab = tabs.value.find(t => t.id === activeId.value);
    return tab?.exited ?? false;
  });

  function init(container: HTMLDivElement) {
    containerEl = container;
  }

  function createSession(cwd: string, initialCommand?: string): string {
    if (!containerEl) return "";
    const id = `__wb_${nextIdx++}__`;
    const s = settingsRef!;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      theme: catppuccinMochaTheme,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const div = document.createElement("div");
    div.className = "wb-term-pane";
    div.style.display = "none";
    containerEl.appendChild(div);
    // Must be visible before open(): display:none causes offsetWidth=0 and wrong cols.
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();

    terminal.onData((data) => {
      api.ptyWrite(id, data).catch(() => {});
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);

    const session: WbSession = {
      id,
      label: initialCommand || `${nextIdx - 1}`,
      terminal,
      fitAddon,
      div,
      observer,
      spawned: false,
      exited: false,
      shellName: "",
    };
    sessions.set(id, session);
    switchTo(id);
    spawnShell(id, cwd, initialCommand);
    ensurePolling();
    ensureExitListener();

    return id;
  }

  function switchTo(id: string) {
    for (const [, s] of sessions) s.div.style.display = "none";
    const s = sessions.get(id);
    if (s) {
      s.div.style.display = "";
      s.fitAddon.fit();
      s.terminal.focus();
    }
    activeId.value = id;
  }

  function closeSession(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    api.ptyKill(id).catch(() => {});
    s.observer.disconnect();
    s.terminal.dispose();
    s.div.remove();
    sessions.delete(id);
    syncTabs();

    if (activeId.value === id) {
      const remaining = Array.from(sessions.keys());
      activeId.value = remaining.length > 0 ? remaining[remaining.length - 1] : "";
      if (activeId.value) switchTo(activeId.value);
    }

    if (sessions.size === 0) {
      stopPolling();
      visible.value = false;
    }
  }

  async function spawnShell(id: string, cwd: string, initialCommand?: string) {
    const s = sessions.get(id);
    if (!s || s.spawned) return;
    const stg = settingsRef!;
    try {
      await api.ptySpawnShell(id, s.terminal.rows, s.terminal.cols, cwd, stg.shellPath ?? "");
      s.shellName = stg.shellPath
        ? deriveShellName(stg.shellPath)
        : (navigator.platform.toLowerCase().includes("win") ? "PowerShell" : "bash");
      s.spawned = true;
      syncTabs();
      if (initialCommand) {
        // Give the shell a moment to print its prompt before we send input
        await new Promise<void>(r => setTimeout(r, 400));
        await api.ptyWrite(id, initialCommand + "\r");
      }
    } catch (e) {
      s.terminal.writeln(`\r\nFailed to start shell: ${e}`);
      s.exited = true;
      syncTabs();
    }
  }

  function changeCwd(cwd: string) {
    const s = sessions.get(activeId.value);
    if (!s || !s.spawned || !cwd) return;
    api.ptyWrite(s.id, `cd "${cwd}"\r`).catch(() => {});
  }

  async function show(cwd: string) {
    visible.value = true;
    if (sessions.size === 0) {
      createSession(cwd);
    } else {
      ensurePolling();
    }
    setTimeout(() => {
      const s = sessions.get(activeId.value);
      if (s) { s.fitAddon.fit(); s.terminal.focus(); }
    }, 200);
  }

  function hide() {
    visible.value = false;
  }

  async function toggle(cwd: string) {
    if (visible.value) hide();
    else await show(cwd);
  }

  function clear() {
    const s = sessions.get(activeId.value);
    if (s) s.terminal.clear();
  }

  async function restart(id: string, cwd: string) {
    const s = sessions.get(id);
    if (!s) return;
    s.exited = false;
    syncTabs();
    await spawnShell(id, cwd);
    s.terminal.focus();
  }

  function dispose() {
    stopPolling();
    unlistenExit?.();
    unlistenExit = null;
    for (const [id, s] of sessions) {
      api.ptyKill(id).catch(() => {});
      s.observer.disconnect();
      s.terminal.dispose();
      s.div.remove();
    }
    sessions.clear();
    tabs.value = [];
    activeId.value = "";
    containerEl = null;
  }

  return {
    visible,
    tabs,
    activeId,
    activeExited,
    init,
    createSession,
    switchTo,
    closeSession,
    show,
    hide,
    toggle,
    clear,
    changeCwd,
    restart,
    dispose,
  };
}

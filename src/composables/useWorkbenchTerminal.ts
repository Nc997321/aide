import { ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Terminal } from "xterm";
import type { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSettings } from "./useSettings";

const WORKBENCH_SESSION_ID = "__workbench__";

// Module-level singleton state — one persistent shell for the app lifetime.
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let containerDiv: HTMLDivElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unlistenExit: UnlistenFn | null = null;
let spawned = false;

const visible = ref(false);
const shellExited = ref(false);
const shellName = ref("");

function makeXtermTheme() {
  return {
    background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
    selectionBackground: "#585b70",
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5", brightWhite: "#a6adc8",
  };
}

/** Derive a display name from a resolved shell path. */
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

export function useWorkbenchTerminal() {
  const { settings } = useSettings();

  // Apply font size / family changes live.
  watch(() => settings.fontSize, (v) => {
    if (terminal) { terminal.options.fontSize = v; fitAddon?.fit(); }
  });
  watch(() => settings.fontFamily, (v) => {
    if (terminal) { terminal.options.fontFamily = v; }
  });

  function attachTerminal(t: Terminal, fa: FitAddon, div: HTMLDivElement) {
    terminal = t;
    fitAddon = fa;
    containerDiv = div;
    t.onData((data) => {
      api.ptyWrite(WORKBENCH_SESSION_ID, data).catch(() => {});
    });
    // First-time exit listener setup (once).
    if (!unlistenExit) {
      listen<string>("pty-exit", (event) => {
        try {
          const p = JSON.parse(event.payload);
          if (p.session_id === WORKBENCH_SESSION_ID) {
            shellExited.value = true;
            spawned = false;
            stopPolling();
          }
        } catch (_) { /* ignore */ }
      }).then((fn) => { unlistenExit = fn; });
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!terminal) return;
      try {
        const data = await api.pollPtyOutput(WORKBENCH_SESSION_ID);
        if (data) terminal.write(data);
      } catch (_) { /* ignore */ }
    }, 100);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function spawn(cwd: string) {
    if (!terminal || !fitAddon || spawned) return;
    shellExited.value = false;
    try {
      await api.ptySpawnShell(
        WORKBENCH_SESSION_ID,
        terminal.rows,
        terminal.cols,
        cwd,
        settings.shellPath ?? "",
      );
      // Display name: user-configured path wins, else generic label (actual
      // resolved name lives on the Rust side; we approximate from settings).
      shellName.value = settings.shellPath
        ? deriveShellName(settings.shellPath)
        : (navigator.platform.toLowerCase().includes("win") ? "PowerShell" : "bash");
      spawned = true;
      startPolling();
    } catch (e) {
      terminal.writeln(`\r\nFailed to start shell: ${e}`);
      shellExited.value = true;
    }
  }

  async function show(cwd: string) {
    visible.value = true;
    if (!spawned && !shellExited.value) {
      await spawn(cwd);
    } else if (spawned) {
      startPolling();
    }
    // Focus + refit after the slide-down animation reveals the container.
    setTimeout(() => {
      fitAddon?.fit();
      terminal?.focus();
    }, 200);
  }

  function hide() {
    visible.value = false;
    // Keep polling so the buffer drains while hidden.
  }

  async function toggle(cwd: string) {
    if (visible.value) hide();
    else await show(cwd);
  }

  function clear() {
    terminal?.clear();
  }

  function close() {
    // Kill the shell and collapse the panel. Next toggle respawns.
    api.ptyKill(WORKBENCH_SESSION_ID).catch(() => {});
    spawned = false;
    shellExited.value = false;
    stopPolling();
    visible.value = false;
  }

  /** User pressed Enter on the "shell exited" overlay → restart. */
  async function restart(cwd: string) {
    shellExited.value = false;
    await spawn(cwd);
    terminal?.focus();
  }

  function dispose() {
    stopPolling();
    unlistenExit?.();
    unlistenExit = null;
    api.ptyKill(WORKBENCH_SESSION_ID).catch(() => {});
    spawned = false;
    terminal = null;
    fitAddon = null;
    containerDiv = null;
  }

  return {
    visible,
    shellExited,
    shellName,
    attachTerminal,
    spawn,
    show,
    hide,
    toggle,
    clear,
    close,
    restart,
    dispose,
    // exposed for the component to read sizing
    getSessionId: () => WORKBENCH_SESSION_ID,
  };
}

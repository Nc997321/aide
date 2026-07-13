import { ref, watch, nextTick } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSettings } from "./useSettings";
import { buildXtermTheme } from "../utils/xterm";
import { themes } from "../themes";
import {
  setActiveWorkspace as coreSetActiveWorkspace,
  activeWorkspaceKey,
  genSessionId,
  addTab,
  removeTab,
  markExited,
  clearExited,
  killWorkspace,
  allSessionIds,
  workspaceKeyOf,
  setActiveTab,
  setShellName,
  tabs as coreTabs,
  activeId as coreActiveId,
  activeExited as coreActiveExited,
  resetWorkbenchState,
  type WbTabKind,
} from "./workbenchTerminalState";

// 仅保留 xterm/div 物理对象；tab 元数据/分组/激活全在核心
interface WbSession {
  id: string;
  workspaceKey: string;   // 冗余存一份，便于 display 判断 & dispose
  kind: WbTabKind;
  shellName: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  div: HTMLDivElement;
  observer: ResizeObserver;
  spawned: boolean;
}

const sessions = new Map<string, WbSession>();   // sessionId -> xterm/div
const visible = ref(false);
let containerEl: HTMLDivElement | null = null;
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
  watch(() => settings.theme, async () => {
    await nextTick();
    for (const [, s] of sessions) {
      if (s.terminal) {
        s.terminal.options.theme = buildXtermTheme(themes[settings.theme] || themes["warm-dark"]);
      }
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
      const p = JSON.parse(event.payload) as { session_id: string };
      // 物理对象：标记并清理 DOM
      const s = sessions.get(p.session_id);
      if (s) {
        s.spawned = false;
        // run tab 的 DOM 也保留到关闭按钮触发；shell 标 exited 让 UI 显示覆盖层
      }
      // 元数据：标 exited（核心 tabs 反映）
      markExited(p.session_id);
    } catch (_) { /* ignore */ }
  }).then((fn) => { unlistenExit = fn; });
}

export function useWorkbenchTerminal() {
  ensureSettingsWatchers();

  function init(container: HTMLDivElement) {
    containerEl = container;
  }

  function createSession(workspaceKey: string, cwd: string, initialCommand?: string): string {
    if (!containerEl) return "";
    const id = genSessionId(workspaceKey);
    const stg = settingsRef!;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: stg.fontSize,
      fontFamily: stg.fontFamily,
      theme: buildXtermTheme(themes[stg.theme || "warm-dark"]),
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const div = document.createElement("div");
    div.className = "wb-term-pane";
    div.style.display = "none";
    containerEl.appendChild(div);
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();

    terminal.onData((data) => { api.ptyWrite(id, data).catch(() => {}); });
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);

    const session: WbSession = { id, workspaceKey, kind: "shell", shellName: "", terminal, fitAddon, div, observer, spawned: false };
    sessions.set(id, session);
    addTab(workspaceKey, { id, label: initialCommand || "", shellName: "", exited: false, kind: "shell" });
    switchTo(id);
    spawnShell(id, cwd, initialCommand);
    ensurePolling();
    ensureExitListener();
    return id;
  }

  function switchTo(id: string) {
    for (const [, s] of sessions) s.div.style.display = "none";
    const wk = workspaceKeyOf(id);
    if (wk) setActiveTab(wk, id);
    const s = sessions.get(id);
    if (s && wk === activeWorkspaceKey() && visible.value) {
      s.div.style.display = "";
      s.fitAddon.fit();
      s.terminal.focus();
    }
  }

  function closeSession(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    const wk = s.workspaceKey;            // 先存，removeTab 后 workspaceKeyOf 查不到
    api.ptyKill(id).catch(() => {});
    s.observer.disconnect();
    s.terminal.dispose();
    s.div.remove();
    sessions.delete(id);
    removeTab(id);
    // 若删的是当前激活工作空间的 tab，切到该组剩下的最后一个（核心已回退 activeId；同步显示）
    const newActive = coreActiveId.value;
    if (newActive && wk === activeWorkspaceKey()) switchTo(newActive);
    if (allSessionIds().length === 0) {
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
      setShellName(id, s.shellName);
      s.spawned = true;
      if (initialCommand) {
        // Give the shell a moment to print its prompt before we send input
        await new Promise<void>(r => setTimeout(r, 400));
        await api.ptyWrite(id, initialCommand + "\r");
      }
    } catch (e) {
      s.terminal.writeln(`\r\nFailed to start shell: ${e}`);
      markExited(id);
    }
  }

  function attachSession(workspaceKey: string, id: string, label: string, clearFirst = false): void {
    ensureSettingsWatchers();
    const existing = sessions.get(id);
    if (existing) {
      existing.spawned = true;
      clearExited(id); // run 重启时把 exited 复位（核心已导出 clearExited）
      if (clearFirst) existing.terminal.clear();
      setActiveTab(workspaceKey, id);
      switchTo(id);
      ensurePolling();
      return;
    }
    if (!containerEl) return;
    const stg = settingsRef!;
    const terminal = new Terminal({
      cursorBlink: true, fontSize: stg.fontSize, fontFamily: stg.fontFamily,
      theme: buildXtermTheme(themes[stg.theme || "warm-dark"]), allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const div = document.createElement("div");
    div.className = "wb-term-pane";
    containerEl.appendChild(div);
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();
    terminal.onData((data) => { api.ptyWrite(id, data).catch(() => {}); });
    const observer = new ResizeObserver(() => {
      fitAddon.fit(); api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);
    const session: WbSession = { id, workspaceKey, kind: "run", shellName: "", terminal, fitAddon, div, observer, spawned: true };
    sessions.set(id, session);
    addTab(workspaceKey, { id, label, shellName: "", exited: false, kind: "run" });
    switchTo(id);
    ensurePolling();
    ensureExitListener();
    nextTick(() => { api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {}); });
  }

  async function show() {
    visible.value = true;
    ensurePolling();
    setTimeout(() => {
      const s = sessions.get(coreActiveId.value);
      if (s) { s.fitAddon.fit(); s.terminal.focus(); }
    }, 200);
  }

  function hide() { visible.value = false; }

  function toggle() {
    if (visible.value) hide();
    else show();
  }

  function clear() {
    const s = sessions.get(coreActiveId.value);
    if (s) s.terminal.clear();
  }

  async function restart(id: string, cwd: string) {
    const s = sessions.get(id);
    if (!s || s.kind !== "shell") return;   // run tab 不在此重启
    clearExited(id);
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
    resetWorkbenchState();
    containerEl = null;
  }

  function killWorkspaceTerminals(workspaceKey: string) {
    const ids = killWorkspace(workspaceKey); // 核心返回待 kill 的 id
    for (const id of ids) {
      const s = sessions.get(id);
      if (s) {
        api.ptyKill(id).catch(() => {});
        s.observer.disconnect();
        s.terminal.dispose();
        s.div.remove();
        sessions.delete(id);
      }
    }
  }

  return {
    visible,
    tabs: coreTabs,
    activeId: coreActiveId,
    activeExited: coreActiveExited,
    init,
    createSession,
    attachSession,
    switchTo,
    closeSession,
    show,
    hide,
    toggle,
    clear,
    restart,
    dispose,
    killWorkspaceTerminals,
    setActiveWorkspace: coreSetActiveWorkspace,
  };
}

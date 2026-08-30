import { ref, watch, nextTick } from "vue";
import { listen } from "../api";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSettings } from "./useSettings";
import { registerSearch, unregisterSearch, useTerminalSearch } from "./useTerminalSearch";
import { buildXtermTheme } from "../utils/xterm";
import { MONO_FONT_STACK } from "../utils/fonts";
import { windowsPtyConfig } from "../utils/platform";
import {
  setActiveWorkspace as coreSetActiveWorkspace,
  activeWorkspaceKey,
  genSessionId,
  addTab,
  removeTab,
  markExited,
  clearExited,
  isRunRestarting,
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
let pollTimerInterval = 0;
// 工作台可见性门控轮询频率:展开 100ms 保持实时,隐藏 500ms 降频。
// 隐藏期不停轮询:ConPTY 内核输出缓冲有限,完全不抽会让持续输出的子进程写满
// 缓冲后被背压阻塞(卡住构建/长输出);500ms 仍抽,IPC 量砍 80% 且无背压风险。
const POLL_INTERVAL_VISIBLE = 100;
const POLL_INTERVAL_HIDDEN = 500;
let unlistenExit: (() => void) | null = null;

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
  watch(() => settings.terminalFontFamily, (v) => {
    for (const [, s] of sessions) {
      s.terminal.options.fontFamily = v || MONO_FONT_STACK;
    }
  });
  watch(() => settings.theme, async () => {
    await nextTick();
    for (const [, s] of sessions) {
      if (s.terminal) {
        s.terminal.options.theme = buildXtermTheme();
      }
    }
    useTerminalSearch().refreshTheme();
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

function currentPollInterval(): number {
  return visible.value ? POLL_INTERVAL_VISIBLE : POLL_INTERVAL_HIDDEN;
}

function ensurePolling() {
  const want = currentPollInterval();
  if (pollTimer && pollTimerInterval === want) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    for (const [, s] of sessions) {
      if (!s.spawned) continue;
      try {
        const data = await api.pollPtyOutput(s.id);
        if (data) s.terminal.write(data);
      } catch (_) { /* ignore */ }
    }
  }, want);
  pollTimerInterval = want;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; pollTimerInterval = 0; }
}

function ensureExitListener() {
  if (unlistenExit) return;
  listen<string>("pty-exit", (event) => {
    try {
      const p = JSON.parse(event.payload) as { session_id: string; success?: boolean };
      // 物理对象：标记并清理 DOM
      const s = sessions.get(p.session_id);
      if (s) {
        // run 重启中收到的 pty-exit 是被 kill 的老进程发的（与新进程共用同一
        // session_id）——整条忽略：不写退出行、不置 spawned=false（否则停掉新
        // 进程轮询）、不 markExited。新进程的退出会另发一条 pty-exit。
        if (s.kind === "run" && isRunRestarting(s.id)) return;
        s.spawned = false;
        // run tab：不套 shell 的退出覆盖层（覆盖层会盖住程序输出且要交互重启），
        // 改为在 xterm 末尾直接写一行退出提示——程序自己的 BUILD SUCCESS/FAILURE
        // 已说明成败，这里只标「进程到此结束」的边界，让用户一眼看出已退出而非卡死。
        // 先尽力冲刷尾部输出再写退出行：Rust waiter 是先移除 session 再 emit，尾部
        // 可能尚未经过 100ms 轮询；spawned=false 后轮询不再碰此 session，由这里收尾。
        if (s.kind === "run") {
          void api.pollPtyOutput(s.id).then((tail) => {
            if (tail) s.terminal.write(tail);
            s.terminal.write("\r\n\x1b[36m[进程已退出]\x1b[0m\r\n");
          });
        }
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
    // ensureSettingsWatchers 在 useWorkbenchTerminal() 入口已执行，settingsRef 契约非空
    const stg = settingsRef!;

    const wpCfg = windowsPtyConfig();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: stg.fontSize,
      fontFamily: stg.terminalFontFamily || MONO_FONT_STACK,
      theme: buildXtermTheme(),
      allowProposedApi: true,
      ...(wpCfg ? { windowsPty: wpCfg } : {}),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    registerSearch(id, terminal);

    const div = document.createElement("div");
    div.className = "wb-term-pane";
    div.style.display = "none";
    containerEl.appendChild(div);
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();

    terminal.onData((data) => {
      api.ptyWrite(id, data).catch((e) => {
        // 高频路径静默 = 键击无声丢失，用户以为 shell 还活着。失败且 shell
        // 未被标记退出时，warn + 在 xterm 写一行可见反馈。
        const sess = sessions.get(id);
        if (sess && sess.spawned) {
          console.warn("[terminal] ptyWrite failed:", id, e);
          sess.terminal.writeln("\r\n\x1b[31m[终端写入失败]\x1b[0m");
        }
      });
    });
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
    api.ptyKill(id).catch((e) => console.warn("[terminal] ptyKill failed:", id, e));
    s.observer.disconnect();
    s.terminal.dispose();
    s.div.remove();
    sessions.delete(id);
    unregisterSearch(id);
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
    // 同 createSession：入口 ensureSettingsWatchers 已保证非空
    const stg = settingsRef!;
    try {
      await api.ptySpawnShell(id, s.terminal.rows, s.terminal.cols, cwd, stg.shellPath ?? "");
      const plat = navigator.platform.toLowerCase();
      s.shellName = stg.shellPath
        ? deriveShellName(stg.shellPath)
        : (plat.includes("win") ? "PowerShell" : plat.includes("mac") ? "zsh" : "bash");
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

  // attach 一个 run 专用终端 tab 到一个即将 spawn 的 PTY session（run 流程专用）。
  // 与 createSession 不同：此处 **不 spawn PTY**——run 流程的 spawn 由调用方
  // （useRunProcess）在拿到本函数返回的真实 cols 后再发起，让 ConPTY 从第一帧
  // 起即与 xterm 列宽一致，避免用固定 80 列 spawn 导致 spawn→resize 窗口期内
  // 长行被提前 wrap 割裂（割裂的输出会永久留在 buffer 里）。
  // 返回 fit 出的 {rows, cols}（下限 clamp），容器无宽度时返回 null。
  function attachSession(workspaceKey: string, id: string, label: string, clearFirst = false): { rows: number; cols: number } | null {
    ensureSettingsWatchers();
    const dimsOf = (t: Terminal) => ({ rows: Math.max(2, t.rows), cols: Math.max(10, t.cols) });
    const existing = sessions.get(id);
    if (existing) {
      existing.spawned = true;
      clearExited(id); // run 重启时把 exited 复位（核心已导出 clearExited）
      if (clearFirst) existing.terminal.clear();
      setActiveTab(workspaceKey, id);
      switchTo(id);
      ensurePolling();
      return dimsOf(existing.terminal);
    }
    if (!containerEl) return null;
    // 同 createSession：入口 ensureSettingsWatchers 已保证非空
    const stg = settingsRef!;
    const wpCfg2 = windowsPtyConfig();
    const terminal = new Terminal({
      cursorBlink: true, fontSize: stg.fontSize, fontFamily: stg.terminalFontFamily || MONO_FONT_STACK,
      theme: buildXtermTheme(), allowProposedApi: true,
      ...(wpCfg2 ? { windowsPty: wpCfg2 } : {}),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    registerSearch(id, terminal);
    const div = document.createElement("div");
    div.className = "wb-term-pane";
    containerEl.appendChild(div);
    div.style.display = "";
    terminal.open(div);
    fitAddon.fit();
    terminal.onData((data) => {
      api.ptyWrite(id, data).catch((e) => {
        // 同 createSession：高频路径失败必须有可见反馈，防键击无声丢失。
        const sess = sessions.get(id);
        if (sess && sess.spawned) {
          console.warn("[terminal] ptyWrite failed:", id, e);
          sess.terminal.writeln("\r\n\x1b[31m[终端写入失败]\x1b[0m");
        }
      });
    });
    const observer = new ResizeObserver(() => {
      fitAddon.fit(); api.ptyResize(id, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);
    // spawned=false：PTY 尚未 spawn（调用方稍后 runProcessStart + markSpawned）。
    // ensurePolling 自动跳过未 spawn session；poll_pty_output 对不存在 session
    // 返回空字符串，无写入副作用。
    const session: WbSession = { id, workspaceKey, kind: "run", shellName: "", terminal, fitAddon, div, observer, spawned: false };
    sessions.set(id, session);
    addTab(workspaceKey, { id, label, shellName: "", exited: false, kind: "run" });
    switchTo(id);
    ensurePolling();
    ensureExitListener();
    return dimsOf(terminal);
  }

  // run 流程 spawn 成功后由 useRunProcess 调用：开启该 session 的输出轮询。
  // 在 attachSession 之后再调，保证 ConPTY 用真实 cols 创建后才取数。
  function markSpawned(id: string) {
    const s = sessions.get(id);
    if (s) s.spawned = true;
  }

  async function show() {
    visible.value = true;
    ensurePolling();
    setTimeout(() => {
      const s = sessions.get(coreActiveId.value);
      if (s) { s.fitAddon.fit(); s.terminal.focus(); }
    }, 200);
  }

  function hide() {
    visible.value = false;
    ensurePolling();   // 切到隐藏低频:visible 已 false,ensurePolling 检测到频率变化重建 timer
  }

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
      api.ptyKill(id).catch((e) => console.warn("[terminal] ptyKill failed:", id, e));
      s.observer.disconnect();
      s.terminal.dispose();
      s.div.remove();
      unregisterSearch(id);
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
        api.ptyKill(id).catch((e) => console.warn("[terminal] ptyKill failed:", id, e));
        s.observer.disconnect();
        s.terminal.dispose();
        s.div.remove();
        sessions.delete(id);
        unregisterSearch(id);
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
    markSpawned,
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

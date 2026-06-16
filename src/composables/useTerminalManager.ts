import { reactive, nextTick } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSessionMonitor } from "./useSessionMonitor";

interface LiveSession {
  div: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  observer: ResizeObserver;
  loadingDiv: HTMLDivElement | null;
  loaderTimer: ReturnType<typeof setTimeout> | null;
}

export function useTerminalManager(
  stackRef: { value: HTMLDivElement | undefined },
  previewRef: { value: HTMLDivElement | undefined },
  onSessionUpdated: () => void,
  onShowPreview: (sid: string) => void,
) {
  const liveSessions = new Map<string, LiveSession>();
  const ptyToDisplay = new Map<string, string>();
  const liveDisplayIds = reactive(new Set<string>());
  let currentSid = "";

  const monitor = useSessionMonitor(liveSessions, ptyToDisplay);
  let unlistenPty: UnlistenFn | null = null;
  let unlistenExit: UnlistenFn | null = null;

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

  /** Build the loading overlay shown while the PTY session is spinning up */
  function createLoadingOverlay(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "session-loader";
    el.innerHTML = `
      <div class="session-loader__glow"></div>
      <div class="session-loader__card">
        <div class="session-loader__hex">&#x2B21;</div>
        <div class="session-loader__title">Claude</div>
        <div class="session-loader__sub">Starting session<span class="session-loader__dots"><span>.</span><span>.</span><span>.</span></span></div>
        <div class="session-loader__track"><div class="session-loader__bar"></div></div>
      </div>`;
    return el;
  }

  /** Remove the loading overlay with a brief fade, then dispose */
  function dismissLoader(ls: LiveSession) {
    if (ls.loaderTimer) { clearTimeout(ls.loaderTimer); ls.loaderTimer = null; }
    if (!ls.loadingDiv) return;
    ls.loadingDiv.classList.add("session-loader--out");
    const el = ls.loadingDiv;
    ls.loadingDiv = null;
    setTimeout(() => el.remove(), 350);
  }

  function resolvePtyId(sid: string): string {
    let ptyId = sid;
    if (!liveSessions.has(ptyId)) {
      for (const [pid, did] of ptyToDisplay) {
        if (did === sid) { ptyId = pid; break; }
      }
    }
    return ptyId;
  }

  function showSession(sid: string) {
    if (!sid || sid === currentSid) return;
    currentSid = sid;

    if (previewRef.value) previewRef.value.style.display = "none";
    for (const [, ls] of liveSessions) ls.div.style.display = "none";

    const ptyId = resolvePtyId(sid);

    if (liveSessions.has(ptyId)) {
      const ls = liveSessions.get(ptyId)!;
      ls.div.style.display = "";
      nextTick(() => ls.fitAddon.fit());
    } else {
      if (previewRef.value) {
        previewRef.value.style.display = "";
        previewRef.value.focus();
      }
      onShowPreview(sid);
    }
  }

  function startClaude(sid: string) {
    if (!sid || !stackRef.value || liveSessions.has(sid)) return;

    const ptyId = resolvePtyId(sid);
    if (liveSessions.has(ptyId)) return;

    const div = document.createElement("div");
    div.className = "terminal-container";
    div.style.display = "none";
    stackRef.value.appendChild(div);

    if (previewRef.value) previewRef.value.style.display = "none";
    div.style.display = "";

    const { terminal, fitAddon } = makeTerminal();
    terminal.open(div);
    fitAddon.fit();

    terminal.onData((data) => {
      api.ptyWrite(ptyId, data).catch(() => {});
      if (data === "\r") {
        const displayId = ptyToDisplay.get(ptyId) || ptyId;
        monitor.recordEnter(displayId);
        monitor.setSessionState(displayId, "running");
      }
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      api.ptyResize(ptyId, terminal.rows, terminal.cols).catch(() => {});
    });
    observer.observe(div);

    // Loading overlay while PTY spins up
    const loadingDiv = createLoadingOverlay();
    div.appendChild(loadingDiv);

    liveSessions.set(ptyId, { div, terminal, fitAddon, observer, loadingDiv, loaderTimer: null });
    liveDisplayIds.add(sid);
    currentSid = sid;

    monitor.startPeriodicCheck(ptyId);
    monitor.setSessionState(sid, "waiting");

    api.ptySpawnClaude(ptyId, terminal.rows, terminal.cols)
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
    if (ls.loaderTimer) clearTimeout(ls.loaderTimer);
    ls.observer.disconnect();
    ls.terminal.dispose();
    ls.div.remove();
    liveSessions.delete(ptyId);

    const displayId = ptyToDisplay.get(ptyId) || ptyId;
    liveDisplayIds.delete(displayId);
    ptyToDisplay.delete(ptyId);

    monitor.removeSessionState(displayId);
    monitor.stopPeriodicCheck(ptyId);

    if (currentSid === displayId || currentSid === ptyId) {
      currentSid = "";
      showSession(displayId);
    }
  }

  function stopClaude(sid: string) {
    if (!sid) return;
    const ptyId = resolvePtyId(sid);
    if (!liveSessions.has(ptyId)) return;
    api.ptyKill(ptyId).catch(() => {});
    destroyLiveSession(ptyId);
  }

  async function scheduleMigration(placeholderId: string) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const sessions = await api.listSessions();
      const real = sessions.find((s) =>
        !s.id.startsWith("new_") &&
        !liveSessions.has(s.id) &&
        !Array.from(ptyToDisplay.values()).includes(s.id),
      );
      if (real && liveSessions.has(placeholderId)) {
        ptyToDisplay.set(placeholderId, real.id);
        liveDisplayIds.delete(placeholderId);
        liveDisplayIds.add(real.id);
        monitor.removeSessionState(placeholderId);
        api.ptyRenameSession(placeholderId, real.id).catch(() => {});
      }
    } catch (_) { /* best effort */ }
    onSessionUpdated();
  }

  /** Seconds to keep the loader after first PTY data — bridges the gap
   *  between "PTY connected" and "Claude TUI actually rendered". */
  const LOADER_DISMISS_DELAY = 5000;

  async function initPtyListener() {
    unlistenPty = await listen<string>("pty-output", (event) => {
      try {
        const p = JSON.parse(event.payload);
        const ls = liveSessions.get(p.session_id);
        if (!ls) return;
        // Delay dismiss: Claude TUI may not be visible yet on first bytes.
        // Start a one-shot timer; kept alive across subsequent packets.
        if (ls.loadingDiv && !ls.loaderTimer) {
          ls.loaderTimer = setTimeout(() => dismissLoader(ls), LOADER_DISMISS_DELAY);
        }
        ls.terminal.write(p.data);
      } catch (_) {}
    });
  }

  /** Listen for PTY process exit (e.g. Ctrl+D twice) → same code path as ⏹ button */
  async function initExitListener() {
    unlistenExit = await listen<string>("pty-exit", (event) => {
      try {
        const p = JSON.parse(event.payload);
        const ptyId: string = p.session_id;
        if (!liveSessions.has(ptyId)) return;
        const displayId = ptyToDisplay.get(ptyId) || ptyId;
        stopClaude(displayId);
      } catch (_) {}
    });
  }

  function cleanup() {
    unlistenPty?.();
    unlistenExit?.();
    monitor.stopAll();
    for (const [ptyId] of liveSessions) {
      api.ptyKill(ptyId).catch(() => {});
      const ls = liveSessions.get(ptyId)!;
      ls.observer.disconnect();
      ls.terminal.dispose();
    }
    liveSessions.clear();
    liveDisplayIds.clear();
    ptyToDisplay.clear();
  }

  return {
    liveDisplayIds,
    currentSid: () => currentSid,
    showSession,
    startClaude,
    stopClaude,
    destroyLiveSession,
    initPtyListener,
    initExitListener,
    cleanup,
  };
}

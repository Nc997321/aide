import { reactive, nextTick, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSessionMonitor } from "./useSessionMonitor";
import { useSettings } from "./useSettings";
import { catppuccinMochaTheme } from "../utils/xterm";

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
  onSessionUpdated: (newId?: string) => void,
  onShowPreview: (sid: string) => void,
) {
  const liveSessions = new Map<string, LiveSession>();
  const ptyToDisplay = new Map<string, string>();
  const liveDisplayIds = reactive(new Set<string>());
  let currentSid = "";

  const { settings } = useSettings();
  const monitor = useSessionMonitor(liveSessions, ptyToDisplay);
  let unlistenExit: UnlistenFn | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Apply font size changes to all live terminals immediately
  watch(() => settings.fontSize, (newSize) => {
    for (const [, ls] of liveSessions) {
      ls.terminal.options.fontSize = newSize;
      ls.fitAddon.fit();
    }
  });

  // Apply font family changes to all live terminals immediately
  watch(() => settings.fontFamily, (newFamily) => {
    for (const [, ls] of liveSessions) {
      ls.terminal.options.fontFamily = newFamily;
    }
  });

  function makeTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: catppuccinMochaTheme,
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

    monitor.setSessionState(displayId, "stopped");
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
    // Wait 3 seconds for Claude Code to start and create its session
    // metadata file (~/.claude/sessions/<pid>.json).
    await new Promise((r) => setTimeout(r, 3000));
    if (!liveSessions.has(placeholderId)) return;

    const sinceMs = parseInt(placeholderId.replace("new_", ""), 10) || 0;
    let knownIds = new Set<string>();

    // Retry up to 3 times: the real session metadata may not be written
    // yet when the first attempt runs.  knownIds tracks all candidates
    // seen so far so that stale sessions from a previous run on the same
    // placeholder are excluded from later attempts.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!liveSessions.has(placeholderId)) return;
      try {
        const sessions = await api.listSessions();
        const candidates = sessions.filter((s) =>
          !s.id.startsWith("new_") &&
          !liveSessions.has(s.id) &&
          !Array.from(ptyToDisplay.values()).includes(s.id) &&
          !knownIds.has(s.id),
        );

        // Sort by timestamp descending, pick the newest candidate
        candidates.sort((a, b) => {
          const aMs = a.timestamp < 1_000_000_000_000
            ? a.timestamp * 1000 : a.timestamp;
          const bMs = b.timestamp < 1_000_000_000_000
            ? b.timestamp * 1000 : b.timestamp;
          return bMs - aMs;
        });
        const real = candidates[0];

        if (real) {
          const realMs = real.timestamp < 1_000_000_000_000
            ? real.timestamp * 1000 : real.timestamp;
          if (realMs > sinceMs && liveSessions.has(placeholderId)) {
            ptyToDisplay.set(placeholderId, real.id);
            liveDisplayIds.delete(placeholderId);
            liveDisplayIds.add(real.id);
            // IMPORTANT: do NOT call pty_rename_session on the Rust side.
            // The onData handler and ResizeObserver in startClaude() capture
            // the placeholder PTY key in their closures. Renaming on the Rust
            // side breaks input because pty_write("new_xxx") can no longer
            // find the PTY (it was moved to the real UUID in Rust's HashMap).
            onSessionUpdated(real.id);
            return; // migration complete
          }
        }

        // Record all known session IDs for exclusion in next attempt
        for (const s of sessions) {
          if (!s.id.startsWith("new_")) knownIds.add(s.id);
        }
      } catch (_) { /* best effort */ }

      // Wait before next retry (skip after last attempt)
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  /** Seconds to keep the loader after first PTY data — bridges the gap
   *  between "PTY connected" and "Claude TUI actually rendered". */
  const LOADER_DISMISS_DELAY = 5000;

  async function initPtyListener() {
    // Pull-based polling: frontend controls the data rate.
    //
    // Instead of the Rust side pushing IPC events (which can flood the
    // WebView event loop and freeze the main thread), the frontend polls
    // for PTY output every 100ms via a Tauri command. Each poll drains the
    // Rust-side buffer and writes the data to xterm.js.
    //
    // This guarantees the JS event loop is never overwhelmed:
    // - At most 10 polls/s per session
    // - Each poll returns bounded data (whatever accumulated in 100ms)
    // - xterm.js handles each chunk with its own internal async processing
    // - No unbounded queues, no event flooding, no main-thread freeze
    pollTimer = setInterval(async () => {
      for (const [ptyId, ls] of liveSessions) {
        try {
          const data = await api.pollPtyOutput(ptyId);
          if (data) {
            if (ls.loadingDiv && !ls.loaderTimer) {
              ls.loaderTimer = setTimeout(() => dismissLoader(ls), LOADER_DISMISS_DELAY);
            }
            ls.terminal.write(data);
          }
        } catch (_) {}
      }
    }, 100);
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
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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

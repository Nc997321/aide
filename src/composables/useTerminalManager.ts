import { reactive, nextTick, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { api } from "../api";
import { useSessionMonitor } from "./useSessionMonitor";
import { useSettings } from "./useSettings";
import { peekFileClipboard } from "./useFileClipboard";
import { resolvePastePayload } from "../utils/paste";
import { catppuccinMochaTheme } from "../utils/xterm";

interface LiveSession {
  div: HTMLDivElement;
  terminal: Terminal;
  fitAddon: FitAddon;
  observer: ResizeObserver;
  loadingDiv: HTMLDivElement | null;
  loaderTimer: ReturnType<typeof setTimeout> | null;
  /** True while the user is in an IME composition session (e.g. Chinese/Japanese input).
   *  Terminal writes are buffered until composition ends so the DOM doesn't shift under
   *  the IME candidate window, which would cause it to jump around. */
  isComposing: boolean;
  /** Accumulated PTY output received while isComposing is true. Flushed on compositionend. */
  pendingBuffer: string;
}

export function useTerminalManager(
  stackRef: { value: HTMLDivElement | undefined },
  previewRef: { value: HTMLDivElement | undefined },
  onSessionUpdated: (newId?: string) => void,
  onShowPreview: (sid: string) => void,
  onTerminalReady?: (terminal: Terminal) => void,
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

  // ── Ctrl+V / Cmd+V paste: files / images / in-app paths / text ──

  function isMac(): boolean {
    return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  }

  async function readClipboardText(): Promise<string> {
    try {
      return await navigator.clipboard.readText();
    } catch (_) {
      return "";
    }
  }

  /** Resolve the clipboard into a PTY payload string ("" = write nothing),
   *  short-circuiting so we only read the sources we actually need. */
  async function resolvePaste(ptyId: string): Promise<string> {
    const files = await api.clipboardReadFiles();
    if (files.length) return resolvePastePayload(files, null, null, "");

    const img = await api.clipboardReadImage();
    if (img) return resolvePastePayload([], img, null, "");

    const entry = peekFileClipboard();
    if (entry && entry.op === "copy") return resolvePastePayload([], null, entry, "");

    return resolvePastePayload([], null, null, await readClipboardText());
  }

  async function handlePaste(ptyId: string) {
    let payload = "";
    try {
      payload = await resolvePaste(ptyId);
    } catch (_) {
      return;
    }
    if (payload) api.ptyWrite(ptyId, payload).catch(() => {});
  }

  /** xterm key handler attached per live terminal. The ptyId is not known when
   *  the terminal is created (startClaude resolves it later), so it is read
   *  from a ref stashed on the terminal object at spawn time. */
  function makePasteKeyHandler(ptyIdRef: { current: string }) {
    return (e: KeyboardEvent): boolean => {
      if (e.type !== "keydown") return true;
      const isPaste = isMac()
        ? e.metaKey && (e.key === "v" || e.key === "V")
        : e.ctrlKey && (e.key === "v" || e.key === "V");
      if (!isPaste) return true;
      if (ptyIdRef.current) handlePaste(ptyIdRef.current);
      return false; // swallow xterm's default (\x16) / browser paste
    };
  }

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
    // ptyId is filled in by startClaude; the paste handler reads it lazily.
    const ptyIdRef = { current: "" };
    (terminal as unknown as { __aidePtyIdRef?: { current: string } }).__aidePtyIdRef = ptyIdRef;
    terminal.attachCustomKeyEventHandler(makePasteKeyHandler(ptyIdRef));
    onTerminalReady?.(terminal);
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
    currentSid = sid;

    if (previewRef.value) previewRef.value.style.display = "none";
    for (const [, ls] of liveSessions) ls.div.style.display = "none";

    if (!sid) {
      if (previewRef.value) previewRef.value.style.display = "";
      return;
    }

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

    // Bind the ptyId into the paste key handler stashed on this terminal.
    const ptyIdRef = (terminal as unknown as { __aidePtyIdRef?: { current: string } }).__aidePtyIdRef;
    if (ptyIdRef) ptyIdRef.current = ptyId;

    terminal.onData((data) => {
      api.ptyWrite(ptyId, data).catch(() => {});
      if (data === "\r") {
        const displayId = ptyToDisplay.get(ptyId) || ptyId;
        monitor.recordEnter(displayId);
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

    const ls: LiveSession = { div, terminal, fitAddon, observer, loadingDiv, loaderTimer: null, isComposing: false, pendingBuffer: "" };
    liveSessions.set(ptyId, ls);

    // IME composition tracking — pause terminal writes while user is composing
    // (e.g. typing Chinese/Japanese). Without this, each write() shifts the DOM
    // rows, causing the IME candidate window to jump to wrong positions.
    div.addEventListener("compositionstart", () => { ls.isComposing = true; }, true);
    div.addEventListener("compositionend", () => {
      ls.isComposing = false;
      if (ls.pendingBuffer) {
        ls.terminal.write(ls.pendingBuffer);
        ls.pendingBuffer = "";
      }
    }, true);
    liveDisplayIds.add(sid);
    currentSid = sid;

    monitor.startPeriodicCheck(ptyId);
    monitor.setSessionState(sid, "waiting");

    api.ptySpawnClaude(ptyId, terminal.rows, terminal.cols)
      .catch((e) => {
        const ls = liveSessions.get(ptyId);
        if (ls) dismissLoader(ls);
        const red = "\x1b[31m";
        const reset = "\x1b[0m";
        terminal.writeln(`\r\n${red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
        terminal.writeln(`${red}  无法启动 Claude Code${reset}`);
        terminal.writeln(`${red}  ${e}${reset}`);
        terminal.writeln(`${red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
        terminal.writeln("");
        terminal.writeln("请确认 claude 已安装并在 PATH 中。");
        terminal.writeln("按 Ctrl+L 刷新，或点击 ⏹ 停止。");
        monitor.setSessionState(sid, "stopped");
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
            // Atomically migrate session status + internal tracking state from
            // the placeholder key to the real UUID, so the title-bar count
            // stays correct and Enter/idle tracking continues uninterrupted.
            monitor.migrateState(placeholderId, real.id);
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
            if (ls.isComposing) {
              // Buffer writes during IME composition to prevent DOM shifts
              ls.pendingBuffer += data;
            } else {
              ls.terminal.write(data);
            }
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

  function resetView() {
    currentSid = "";
    if (previewRef.value) previewRef.value.style.display = "none";
    for (const [, ls] of liveSessions) ls.div.style.display = "none";
    if (previewRef.value) previewRef.value.style.display = "";
  }

  return {
    liveDisplayIds,
    currentSid: () => currentSid,
    showSession,
    startClaude,
    stopClaude,
    destroyLiveSession,
    resetView,
    initPtyListener,
    initExitListener,
    cleanup,
  };
}

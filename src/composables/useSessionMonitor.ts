import { useSessionState } from "./useSessionState";
import { api } from "../api";
import type { Terminal } from "xterm";

interface LiveSession {
  div: HTMLDivElement;
  terminal: Terminal;
  fitAddon: { fit(): void };
  observer: ResizeObserver;
}

export function useSessionMonitor(
  liveSessions: Map<string, LiveSession>,
  ptyToDisplay: Map<string, string>,
) {
  const { state: sessionState, setSessionState, removeSessionState } = useSessionState();
  const periodicTimers = new Map<string, ReturnType<typeof setInterval>>();
  const lastEnterMs = new Map<string, number>();
  const checking = new Set<string>(); // prevent concurrent checks for same session

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

  async function checkSessionState(ptyId: string) {
    // Skip if PTY has been destroyed
    if (!liveSessions.has(ptyId)) return;

    const displayId = ptyToDisplay.get(ptyId) || ptyId;
    const cur = sessionState[displayId];

    // Skip if already waiting
    if (cur === "waiting") return;
    // Prevent concurrent checks (async race between interval ticks)
    if (checking.has(displayId)) return;
    checking.add(displayId);

    try {
      const tail = terminalTailLines(ptyId);

      // 1) Permission prompt detection
      if (/Do you want to proceed|\[y\/n\]|needs?\s+(your\s+)?permission/i.test(tail)) {
        setSessionState(displayId, "attention");
        return;
      }

      // 2) JSONL event detection
      try {
        const info = await api.sessionLastEvent(displayId);

        // When the last event is user, Claude is still processing — but don't
        // return early.  Commands like /compact and /clear don't produce an
        // end_turn event; we must fall through to the terminal-prompt check.
        if (info.event_type === "assistant" && info.stop_reason === "end_turn") {
          const entered = lastEnterMs.get(displayId) || 0;
          const eventMs = info.timestamp ? new Date(info.timestamp).getTime() : 0;
          // Only accept end_turn events that occurred after the user pressed Enter
          if (entered === 0 || eventMs >= entered) {
            setSessionState(displayId, "waiting");
          }
          return;
        }
      } catch (_) { /* fall through */ }

      // 3) Terminal prompt fallback (broader pattern for TUI prompts)
      if (/[>❯]\s*$/.test(tail.trimEnd())) {
        setSessionState(displayId, "waiting");
        return;
      }

      // 4) Timeout fallback: if 30+ seconds since last Enter, assume idle
      const entered = lastEnterMs.get(displayId) || 0;
      if (entered > 0 && Date.now() - entered > 30000) {
        setSessionState(displayId, "waiting");
      }
    } finally {
      checking.delete(displayId);
    }
  }

  function startPeriodicCheck(ptyId: string) {
    if (periodicTimers.has(ptyId)) return;
    if (!liveSessions.has(ptyId)) return;
    setTimeout(() => checkSessionState(ptyId), 2000);
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

  function stopAll() {
    for (const [, timer] of periodicTimers) clearInterval(timer);
    periodicTimers.clear();
  }

  function recordEnter(displayId: string) {
    lastEnterMs.set(displayId, Date.now());
  }

  return {
    setSessionState,
    removeSessionState,
    startPeriodicCheck,
    stopPeriodicCheck,
    stopAll,
    recordEnter,
  };
}

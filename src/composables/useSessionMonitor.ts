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
  const { setSessionState, removeSessionState } = useSessionState();
  const periodicTimers = new Map<string, ReturnType<typeof setInterval>>();

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
    const displayId = ptyToDisplay.get(ptyId) || ptyId;

    const tail = terminalTailLines(ptyId);
    if (/Do you want to proceed|\[y\/n\]|needs?\s+(your\s+)?permission/i.test(tail)) {
      setSessionState(displayId, "attention");
      return;
    }

    try {
      const lastEvent = await api.sessionLastEvent(displayId);
      if (lastEvent === "assistant") {
        setSessionState(displayId, "waiting");
        return;
      }
    } catch (_) { /* fall through */ }

    if (/>\s*$/.test(tail.trimEnd())) {
      setSessionState(displayId, "waiting");
    }
  }

  function startPeriodicCheck(ptyId: string) {
    if (periodicTimers.has(ptyId)) return;
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

  return {
    setSessionState,
    removeSessionState,
    startPeriodicCheck,
    stopPeriodicCheck,
    stopAll,
  };
}

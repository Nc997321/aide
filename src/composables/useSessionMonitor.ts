import { useSessionState } from "./useSessionState";
import type { Terminal } from "xterm";

interface LiveSession {
  div: HTMLDivElement;
  terminal: Terminal;
  fitAddon: { fit(): void };
  observer: ResizeObserver;
}

// Permission/confirmation prompts pause the turn waiting for user choice.
const PERMISSION_RE = /Do you want to proceed|\[y\/n\]|needs?\s+(your\s+)?permission/i;

// How many consecutive unchanged snapshots before declaring idle.
// 3 ticks × 800ms = ~2.4s of silence required.
const IDLE_CONFIRM_TICKS = 3;

// Grace period after Enter before we start comparing snapshots.
// Gives Claude Code's TUI time to start rendering its first frame.
const STARTUP_GRACE_MS = 1500;

const CHECK_INTERVAL_MS = 800;

export function useSessionMonitor(
  liveSessions: Map<string, LiveSession>,
  ptyToDisplay: Map<string, string>,
) {
  const { state: sessionState, setSessionState, removeSessionState } = useSessionState();
  const periodicTimers = new Map<string, ReturnType<typeof setInterval>>();
  const lastEnterMs = new Map<string, number>();
  // Previous terminal tail snapshot — compared each tick to detect activity.
  const lastSnapshot = new Map<string, string>();
  // Count of consecutive ticks where the snapshot did not change.
  const idleStreak = new Map<string, number>();

  function terminalTail(ptyId: string, n: number): string {
    const ls = liveSessions.get(ptyId);
    if (!ls) return "";
    const buf = ls.terminal.buffer.active;
    const start = Math.max(0, buf.length - n);
    const lines: string[] = [];
    for (let i = start; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }

  function checkSessionState(ptyId: string) {
    if (!liveSessions.has(ptyId)) return;

    const displayId = ptyToDisplay.get(ptyId) || ptyId;
    const cur = sessionState[displayId];
    const tail = terminalTail(ptyId, 30);

    // 1) Permission prompt → attention
    if (PERMISSION_RE.test(tail)) {
      idleStreak.set(displayId, 0);
      lastSnapshot.set(displayId, tail);
      if (cur !== "attention") setSessionState(displayId, "attention");
      return;
    }

    // 2) Compare snapshot — did the terminal change since last tick?
    const prev = lastSnapshot.get(displayId) || "";
    lastSnapshot.set(displayId, tail);

    const changed = tail !== prev;

    if (changed) {
      idleStreak.set(displayId, 0);
      // Only set running if there was a recent Enter (Claude genuinely started).
      // lastEnterMs is cleared when we transition to waiting, so user typing
      // after Claude finishes will NOT re-trigger running.
      if (cur !== "running" && cur !== "attention" && lastEnterMs.has(displayId)) {
        setSessionState(displayId, "running");
      }
      return;
    }

    // 3) Snapshot unchanged — terminal is quiet. Decide if idle long enough.
    if (cur !== "running" && cur !== "attention") return;

    const entered = lastEnterMs.get(displayId) || 0;
    if (entered > 0 && Date.now() - entered < STARTUP_GRACE_MS) return;

    const streak = (idleStreak.get(displayId) || 0) + 1;
    idleStreak.set(displayId, streak);
    if (streak >= IDLE_CONFIRM_TICKS) {
      setSessionState(displayId, "waiting");
      lastEnterMs.delete(displayId);
    }
  }

  function startPeriodicCheck(ptyId: string) {
    if (periodicTimers.has(ptyId)) return;
    if (!liveSessions.has(ptyId)) return;
    const timer = setInterval(() => checkSessionState(ptyId), CHECK_INTERVAL_MS);
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
    idleStreak.set(displayId, 0);
    lastSnapshot.delete(displayId);
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

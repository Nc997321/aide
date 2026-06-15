import { reactive } from "vue";

export type SessionStatus = "stopped" | "running" | "waiting" | "attention";

// Module-level reactive singleton — shared across TerminalPanel and SidebarLeft
const state = reactive<Record<string, SessionStatus>>({});

export function useSessionState() {
  function setSessionState(id: string, status: SessionStatus) {
    state[id] = status;
  }

  function removeSessionState(id: string) {
    delete state[id];
  }

  return { state, setSessionState, removeSessionState };
}

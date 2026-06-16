import { watch } from "vue";
import { useSessionState, type SessionStatus } from "./useSessionState";
import { useWindowFocus } from "./useWindowFocus";
import { useSettings } from "./useSettings";
import { api } from "../api";

export function useNotification() {
  const { state: sessionState } = useSessionState();
  const { isFocused } = useWindowFocus();
  const { settings, loaded } = useSettings();

  const prevStates = new Map<string, SessionStatus>();
  const nameCache = new Map<string, string>();
  let projectName = "";

  async function getSessionName(id: string): Promise<string> {
    if (nameCache.has(id)) return nameCache.get(id)!;
    try {
      const sessions = await api.listSessions();
      for (const s of sessions) {
        nameCache.set(s.id, s.name);
      }
      return nameCache.get(id) || id;
    } catch (_) {
      return id;
    }
  }

  async function getProjectName(): Promise<string> {
    if (projectName) return projectName;
    try {
      const info = await api.getProjectInfo();
      projectName = info.name;
      return projectName;
    } catch (_) {
      return "Aide";
    }
  }

  async function fireNotification(id: string) {
    const [title, body] = await Promise.all([getProjectName(), getSessionName(id)]);
    try {
      api.notifySend(title, `${body} 已回复`);
    } catch (_) { /* notification not available */ }
  }

  watch(
    sessionState,
    (newStates) => {
      // Step 1: detect transitions BEFORE updating prevStates
      const transitions: Array<{ id: string; prev: SessionStatus | undefined }> = [];
      for (const [id, status] of Object.entries(newStates)) {
        const prev = prevStates.get(id);
        if (prev !== status) {
          transitions.push({ id, prev });
        }
      }

      // Step 2: always update prevStates (even if guards skip notification)
      for (const [id, status] of Object.entries(newStates)) {
        prevStates.set(id, status as SessionStatus);
      }

      // Step 3: guards
      if (!loaded.value || !settings.notificationsEnabled || isFocused.value) return;

      // Step 4: fire for running/attention → waiting transitions
      for (const { id, prev } of transitions) {
        const current = newStates[id];
        if (current === "waiting" && (prev === "running" || prev === "attention")) {
          fireNotification(id);
        }
      }
    },
    { deep: true },
  );
}

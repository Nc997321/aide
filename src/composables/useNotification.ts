import { watch, reactive } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionState, type SessionStatus } from "./useSessionState";
import { useWindowFocus } from "./useWindowFocus";
import { useSettings } from "./useSettings";
import { api } from "../api";

// Module-level reactive set of sessions that completed while app was unfocused
export const pendingSessions = reactive(new Set<string>());

export function clearPending(ids?: string[]) {
  if (ids) {
    for (const id of ids) pendingSessions.delete(id);
  } else {
    pendingSessions.clear();
  }
}

let progressClearTimer: ReturnType<typeof setTimeout> | null = null;

function setTaskbarProgress(status: string, progress?: number) {
  if (progressClearTimer) {
    clearTimeout(progressClearTimer);
    progressClearTimer = null;
  }
  try {
    const state: Record<string, unknown> = { status };
    if (progress !== undefined) state.progress = progress;
    getCurrentWindow().setProgressBar(state as never);
  } catch (_) {}
}

function flashTaskbar() {
  try {
    getCurrentWindow().requestUserAttention(2);
  } catch (_) {}
}

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

  async function fireNotification(id: string, status: SessionStatus) {
    const [title, body] = await Promise.all([getProjectName(), getSessionName(id)]);
    if (status === "attention") {
      pendingSessions.add(id);
      try {
        api.notifySend(title, `${body} 需要确认`, id);
      } catch (_) {}
    } else {
      pendingSessions.add(id);
      try {
        api.notifySend(title, `${body} 已回复`, id);
      } catch (_) {}
    }
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

      // Step 3: taskbar progress (always, regardless of focus/settings)
      for (const { id, prev } of transitions) {
        const current = newStates[id];
        if (current === "running") {
          setTaskbarProgress("indeterminate");
        } else if (current === "attention") {
          setTaskbarProgress("paused");
          flashTaskbar();
        } else if (current === "waiting" && (prev === "running" || prev === "attention")) {
          setTaskbarProgress("normal", 100);
          flashTaskbar();
          progressClearTimer = setTimeout(() => setTaskbarProgress("none"), 3000);
        } else if (current === "stopped") {
          setTaskbarProgress("none");
        }
      }

      // Step 4: system notification (only when unfocused + enabled)
      if (!loaded.value || !settings.notificationsEnabled || isFocused.value) return;

      for (const { id, prev } of transitions) {
        const current = newStates[id];
        if (current === "attention" && prev === "running") {
          fireNotification(id, "attention");
        } else if (current === "waiting" && (prev === "running" || prev === "attention")) {
          fireNotification(id, "waiting");
        }
      }
    },
    { deep: true },
  );
}

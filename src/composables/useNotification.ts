import { watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSessionState, type SessionStatus } from "./useSessionState";
import { useWindowFocus } from "./useWindowFocus";
import { useSettings } from "./useSettings";
import { api } from "../api";

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
  } catch (_) { /* 任务栏 API 不可用时静默（非关键平台集成，失败不影响主流程） */ }
}

function flashTaskbar() {
  try {
    getCurrentWindow().requestUserAttention(2);
  } catch (_) { /* 任务栏 API 不可用时静默（同上） */ }
}

export function useNotification() {
  const { state: sessionState } = useSessionState();
  const { isFocused } = useWindowFocus();
  const { settings, loaded } = useSettings();

  const prevStates = new Map<string, SessionStatus>();
  const nameCache = new Map<string, string>();
  let projectName = "";

  async function getSessionName(id: string): Promise<string> {
    if (nameCache.has(id)) return nameCache.get(id) ?? "";
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
      // 无显式工作区时 name 为 ""——通知标题回退应用名
      projectName = info.name || "Aide";
      return projectName;
    } catch (_) {
      return "Aide";
    }
  }

  /** 工作区根路径取末段做通知标题（跨平台分隔符），空则回退应用名。 */
  function workspaceBasename(root: string): string {
    const trimmed = root.replace(/[\\/]+$/, "");
    const seg = trimmed.split(/[\\/]/).pop() ?? "";
    return seg || "Aide";
  }

  async function fireNotification(id: string, status: SessionStatus) {
    // 按会话真实所属工作区显示：send_message 注册的进程内路由反查；
    // 查不到（从未 send / finalize 换 key 后未再 send）回退当前工作区旧行为。
    const info = await api.sessionNotificationInfo(id).catch(() => null);
    const [title, body] = info
      ? [workspaceBasename(info.workspace), info.name]
      : await Promise.all([getProjectName(), getSessionName(id)]);
    const suffix = status === "attention" ? "需要确认" : "已回复";
    try {
      // sessionId 随通知暂存到 Rust：点击 toast 唤起窗口后据此定位会话
      await api.notifySend(title, `${body} ${suffix}`, id);
    } catch (_) { /* 系统通知 API 不可用时静默（通知是增强体验，失败不阻断主流程） */ }
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

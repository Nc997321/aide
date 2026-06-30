import { ref, readonly } from "vue";
import { api } from "../api";
import type { RecentSession, RecentFile } from "../types";

// 模块级单例：会话全局、文件按当前工作区展示。
const sessions = ref<RecentSession[]>([]);
const files = ref<RecentFile[]>([]);
const currentWsKey = ref("");
const currentWsName = ref("");

export function useRecent() {
  async function refresh(): Promise<void> {
    if (!currentWsKey.value) {
      sessions.value = [];
      files.value = [];
      return;
    }
    try {
      const v = await api.listRecent(currentWsKey.value);
      sessions.value = v.sessions;
      files.value = v.files;
    } catch {
      // 保留旧值，不阻断 UI
    }
  }

  /** 记录最近会话（显式传 ws，支持跨工作区选择）。 */
  async function recordSession(
    wsKey: string,
    wsName: string,
    sessionId: string,
    name: string,
  ): Promise<void> {
    try {
      await api.recordRecentSession(wsKey, wsName, sessionId, name);
      await refresh();
    } catch {
      // best effort
    }
  }

  /** 记录最近文件（用当前工作区）。 */
  async function recordFile(path: string, name: string): Promise<void> {
    if (!currentWsKey.value) return;
    try {
      await api.recordRecentFile(currentWsKey.value, path, name);
      await refresh();
    } catch {
      // best effort
    }
  }

  /** 工作区切换时调用，刷新当前工作区的最近文件。 */
  async function setCurrentWs(wsKey: string, wsName: string): Promise<void> {
    currentWsKey.value = wsKey;
    currentWsName.value = wsName;
    await refresh();
  }

  async function clear(category?: "sessions" | "files"): Promise<void> {
    try {
      await api.clearRecent(category);
      await refresh();
    } catch {
      // best effort
    }
  }

  return {
    sessions: readonly(sessions),
    files: readonly(files),
    currentWsKey: readonly(currentWsKey),
    currentWsName: readonly(currentWsName),
    refresh,
    recordSession,
    recordFile,
    setCurrentWs,
    clear,
  };
}

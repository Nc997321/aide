import { watch } from "vue";
import { usePaneLayout } from "../usePaneLayout";
import { useSettings } from "../useSettings";
import { api } from "../../api";
import { parseSnapshot } from "./tree";

/**
 * 布局持久化胶水：把 usePaneLayout 的快照按工作区键控存进 settings.paneLayouts。
 *
 * 单独成层的原因：usePaneLayout 保持不 import Tauri（api/settings 都会拉起
 * @tauri-apps 依赖链），布局语义可脱离宿主单测；落盘/恢复这点脏活集中在这里。
 *
 * 防御式恢复：快照结构非法 / 引用的会话已删光 → 静默回退单组空白 tab。
 */

const SAVE_DEBOUNCE_MS = 500;

let currentWsPath = "";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 恢复期间布局树在批量变更，watch 不该把中间态写回设置 */
let suspended = false;
let installed = false;

export function usePaneLayoutPersistence() {
  const pl = usePaneLayout();
  const { settings, update } = useSettings();

  function persistNow() {
    if (!currentWsPath) return;
    const snap = pl.serialize();
    const layouts: Record<string, unknown> = { ...(settings.paneLayouts ?? {}) };
    if (snap) layouts[currentWsPath] = snap;
    else delete layouts[currentWsPath];
    void update({ paneLayouts: layouts });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNow();
  }

  /** App.vue onMounted 调一次：布局任何变更（含聚焦/激活切换）debounce 落盘。 */
  function install() {
    if (installed) return;
    installed = true;
    watch(
      () => pl.layout,
      () => {
        if (suspended || !currentWsPath) return;
        scheduleSave();
      },
      { deep: true },
    );
  }

  /**
   * 工作区切换（含启动首个工作区）：旧布局立即落盘，恢复新工作区的快照。
   * 调用时机在 api.setWorkspace 之后——listSessions 已指向新工作区。
   */
  async function switchWorkspace(wsPath: string) {
    if (!wsPath || wsPath === currentWsPath) return;
    if (currentWsPath) flushSave();
    currentWsPath = wsPath;

    suspended = true;
    try {
      const parsed = parseSnapshot((settings.paneLayouts ?? {})[wsPath]);
      if (!parsed) {
        pl.reset();
        return;
      }
      // 剔除已不存在的会话；列表拿不到（异常）时保守全保留，
      // 打开不存在的会话只是空面板，不致命。
      let valid: Set<string> | undefined;
      try {
        valid = new Set((await api.listSessions()).map((s) => s.id));
      } catch {
        valid = undefined;
      }
      pl.restore(parsed, valid);
    } finally {
      suspended = false;
    }
  }

  return { install, switchWorkspace, flushSave };
}

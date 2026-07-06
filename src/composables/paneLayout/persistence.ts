import { watch } from "vue";
import { usePaneLayout } from "../usePaneLayout";
import { useSettings } from "../useSettings";
import { useSessionNames } from "../useSessionNames";
import { useSessionWorkspaces } from "../useSessionWorkspaces";
import { api } from "../../api";
import { listSnapshotTabs, parseSnapshot } from "./tree";

/**
 * 布局持久化胶水：全局唯一一份布局快照（混合 tab——不同工作区的会话同屏并存，
 * 切换活动工作区不再动布局），存在 settings.paneLayouts 的固定键下。
 *
 * 单独成层的原因：usePaneLayout 保持不 import Tauri（api/settings 都会拉起
 * @tauri-apps 依赖链），布局语义可脱离宿主单测；落盘/恢复这点脏活集中在这里。
 *
 * 防御式恢复：快照结构非法（含 v1 旧格式）→ 静默保持空白布局；逐工作区校验
 * 会话仍存在，校验接口失败的那个工作区保守全保留（开到已删会话只是空面板）。
 */

const GLOBAL_LAYOUT_KEY = "__global__";
const SAVE_DEBOUNCE_MS = 500;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 恢复期间布局树在批量变更，watch 不该把中间态写回设置 */
let suspended = false;
let installed = false;

export function usePaneLayoutPersistence() {
  const pl = usePaneLayout();
  const { settings, update } = useSettings();

  function persistNow() {
    const snap = pl.serialize();
    // 只写全局键：v1 时代按工作区分份的旧键一并淘汰，不迁移（结构已不兼容）
    void update({ paneLayouts: snap ? { [GLOBAL_LAYOUT_KEY]: snap } : {} });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** App.vue onMounted 调一次：布局任何变更（含聚焦/激活切换）debounce 落盘。 */
  function install() {
    if (installed) return;
    installed = true;
    watch(
      () => pl.layout,
      () => {
        if (suspended) return;
        scheduleSave();
      },
      { deep: true },
    );
  }

  /**
   * 启动时恢复全局布局（settings 已加载、活动工作区已确定之后调一次）。
   * 快照里的名字/工作区归属先种进注册表——tab 标签和 sidecar cwd 不依赖
   * 侧栏对各工作区的懒加载。
   */
  async function restoreAtStartup() {
    const parsed = parseSnapshot((settings.paneLayouts ?? {})[GLOBAL_LAYOUT_KEY]);
    if (!parsed) return; // 无快照/旧格式/损坏：保持初始空白布局

    const tabs = listSnapshotTabs(parsed);
    const names = useSessionNames();
    const sws = useSessionWorkspaces();
    for (const t of tabs) {
      if (t.name) names.setName(t.sessionId, t.name);
      if (t.wsKey && t.wsPath) sws.setWorkspace(t.sessionId, { wsKey: t.wsKey, wsPath: t.wsPath });
    }

    // 逐工作区校验会话仍存在；无归属的 tab 对照当前活动工作区
    const valid = new Set<string>();
    const byWs = new Map<string, string[]>();
    for (const t of tabs) byWs.set(t.wsKey ?? "", [...(byWs.get(t.wsKey ?? "") ?? []), t.sessionId]);
    for (const [wsKey, sids] of byWs) {
      try {
        const list = wsKey
          ? await api.listSessionsForWorkspace(wsKey)
          : await api.listSessions();
        const alive = new Set(list.map((s) => s.id));
        for (const sid of sids) if (alive.has(sid)) valid.add(sid);
      } catch {
        for (const sid of sids) valid.add(sid); // 校验不可用：保守全保留
      }
    }

    suspended = true;
    try {
      pl.restore(parsed, valid);
    } finally {
      suspended = false;
    }
  }

  return { install, restoreAtStartup };
}

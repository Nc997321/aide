import { ref } from "vue";
import { visibleWorkspaces } from "@aide/sdk/utils/dailyWorkspace";
import { api } from "../api";
import type { WorkspaceInfo } from "../types";

// 模块级单例：工作区列表与激活 key 是跨组件共享状态
const workspaces = ref<WorkspaceInfo[]>([]);
const activeKey = ref<string | null>(null);

export function useWorkspaces() {
  /** 重新拉取工作区列表（后端按显式注册表返回，见 workspace/registry）。
   *  副作用注意：失败会把共享列表清空——所有消费方（侧栏/选择器）同步回落
   *  空态；重新触发拉取即重试。WorkspacePicker 收口后也经此刷新。 */
  async function refresh() {
    try {
      // 日常目录对 UI 隐身：**唯一过滤点**在这里（SDK 的 visibleWorkspaces）。
      // 侧栏分区与 WorkspacePicker 都经这份列表，渲染期不要再滤一次。
      workspaces.value = visibleWorkspaces(await api.listWorkspaces());
    } catch (_e) {
      workspaces.value = [];
    }
  }

  /** 登记一个磁盘目录为工作区并立即切换（后端建目录 + 设激活 + 自动 unhide）。
   *  返回新的 WorkspaceInfo；失败抛错由调用方处理 UI。 */
  async function openFolder(path: string): Promise<WorkspaceInfo> {
    const info = await api.createWorkspace(path);
    await refresh();
    activeKey.value = info.key;
    return info;
  }

  /** 移除工作区：hide=软隐藏保留会话；delete=删目录+会话。
   *  若移除的是当前激活，后端已清空，前端同步回落。 */
  async function removeWorkspace(key: string, mode: "hide" | "delete") {
    await api.removeWorkspace(key, mode);
    await refresh();
    if (activeKey.value === key) activeKey.value = null;
  }

  return { workspaces, activeKey, refresh, openFolder, removeWorkspace };
}

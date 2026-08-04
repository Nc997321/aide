import { ref } from "vue";
import { api } from "../api";
import { useLsp } from "./useLsp";

/** 工作区 LSP 设置前端侧：开关 + 排除目录。权威值在后端 state JSON。 */
export function useWorkspaceLsp(workspaceRoot: string) {
  const { enableLsp, disableLsp, isLspOn } = useLsp();
  const enabled = ref(isLspOn(workspaceRoot));
  const excludes = ref<string[]>([]);
  const excludesDirty = ref(false);

  async function setEnabled(v: boolean) {
    enabled.value = v;
    if (v) await enableLsp(workspaceRoot);
    else await disableLsp(workspaceRoot);
  }

  async function saveExcludes(dirs: string[]) {
    await api.workspaceSetLspExcludes(workspaceRoot, dirs);
    excludes.value = dirs;
    excludesDirty.value = false;
    // 改排除集需重拉 server：disable→enable 完成（spec §5.4）
    if (enabled.value) {
      await disableLsp(workspaceRoot);
      await enableLsp(workspaceRoot);
    }
  }

  return { enabled, excludes, excludesDirty, setEnabled, saveExcludes };
}

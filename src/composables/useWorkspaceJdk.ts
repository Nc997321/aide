import { ref } from "vue";
import { api } from "../api";

/**
 * 工作区级 JDK 单例：一个工作区 = 一个 JDK（Maven/Gradle 反应堆构建只有启动
 * mvn/gradle 的那一个 JDK，per-module 选 JDK 是错误粒度——2026-08-08 拍板）。
 * 权威值在后端 state.json workspace_jdks[key]；"" = 系统默认（PATH java，不注入）。
 *
 * 读写都按工作区路径走（后端 path_to_key 归一），不用 useWorkspaces.activeKey
 * （那是 SDK 目录名编码，点号被替换成横杠，与 path_to_key 保留点号的形态对不上）。
 *
 * 消费方：LspIndicator「本工作区 JDK」选择器（setJdk）、RunConfigsDialog 只读
 * 展示、useRunProcess 启动注入（jdkHome → env.JAVA_HOME）。
 * 驱动方：App.vue 在工作区切换编排点调 loadFor（与 loadRunConfigs 同点）。
 */
const jdkHome = ref<string>("");
let currentRoot = "";

async function loadFor(root: string): Promise<void> {
  currentRoot = root;
  if (!root) {
    jdkHome.value = "";
    return;
  }
  const v = await api.workspaceGetJdk(root).catch(() => "");
  // 工作区切换竞态：响应回来时用户已切走 → 丢弃陈旧值
  if (currentRoot !== root) return;
  jdkHome.value = v;
}

/** 设当前工作区 JDK（"" = 系统默认）。乐观更新，所有消费方同读一个 ref。 */
async function setJdk(path: string): Promise<void> {
  if (!currentRoot) return;
  jdkHome.value = path;
  await api.workspaceSetJdk(currentRoot, path).catch(() => {});
}

export function useWorkspaceJdk() {
  return { jdkHome, loadFor, setJdk };
}

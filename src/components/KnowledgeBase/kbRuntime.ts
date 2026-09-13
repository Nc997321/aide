// 知识库凭据 → 主进程单向镜像（`~/.aide/knowledge.json` → sidecar 内置工具 aide-knowledge）。
//
// localStorage 是唯一真相源（kbClient 的 getBaseUrl/getToken）。**凭据每次变更都要跟一次**，
// 现有调用点：
//   src/main.ts（应用启动，覆盖"上次登录过、本次没开面板"）
//   useKnowledgeBase 的 init / login / setup / join / logout
// 新增变更点（比如以后换存储介质）必须同步加推送，否则 agent 侧会拿着旧凭据。
//
// 失败不抛：调用方是 fire-and-forget，抛出去会变成未处理拒绝刷日志；而推送失败只
// 影响 agent 侧工具可用性，知识库面板本身照常工作。
import { api } from "@/api";
import { getBaseUrl, getToken } from "./kbClient";

export async function pushKnowledgeRuntime(): Promise<void> {
  try {
    await api.setKnowledgeRuntimeConfig({ baseUrl: getBaseUrl(), token: getToken() });
  } catch (e) {
    console.warn("[knowledge] 凭据推送给主进程失败——agent 侧知识库工具将不可用", e);
  }
}

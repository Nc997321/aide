/** 会话能力策略：只做决策，装配入口负责加载与启动。缺省兼容现有助手。 */
export type SessionProfile = "assistant" | "chat";
export function resolveSessionProfile(profile?: SessionProfile) {
  const toolsEnabled = profile !== "chat";
  return {
    toolsEnabled,
  };
}

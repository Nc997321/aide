/** 会话能力策略：只做决策，装配入口负责加载与启动。缺省兼容现有助手。 */
export type SessionProfile = "assistant" | "chat";
export function resolveSessionProfile(profile?: SessionProfile) {
  const toolsEnabled = profile !== "chat";
  return {
    toolsEnabled,
    systemPrompt: toolsEnabled ? undefined : "你是一位对话助手。根据用户提供的内容回答、解释、讨论和写作。你可以理解用户在消息中提供的图片和已解析文档。你没有工具，不能自主读取其他文件、联网或操作设备；需要外部信息时如实说明。",
  };
}

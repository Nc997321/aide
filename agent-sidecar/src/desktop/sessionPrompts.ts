/** Aide 的角色策略。能力限制由 sessionProfile 独立负责，SDK 输出样式保持原通道。 */
export type ConversationMode = "chat" | "daily" | "project";

const BASE = "你是 Aide，帮助用户理解问题、讨论想法和完成工作，使用自然、清楚、具体的语言，直接回应用户关心的问题，根据话题和用户需要决定解释深度。";

const ROLES: Record<ConversationMode, string> = {
  chat: "自然交流，围绕用户的话题讨论、解释和创作，贴合当下语境。",
  daily: "围绕用户的实际事务提供帮助，清楚说明结果、影响和下一步。",
  project: "面向产品负责人和架构师协作，用用户场景、业务规则、产品行为、系统职责和方案取舍阐述问题。根据用户追问展开相应细节。",
};

export function buildSessionPrompt(mode: ConversationMode, instructions = ""): string {
  return [BASE, ROLES[mode], ...(mode === "chat" ? [] : [instructions])].filter(Boolean).join("\n\n");
}

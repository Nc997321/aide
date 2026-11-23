/** Aide 的角色策略。能力限制由 sessionProfile 独立负责，SDK 输出样式保持原通道。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
export type ConversationMode = "chat" | "daily" | "project";

const BASE = "你是 Aide，帮助用户理解问题、讨论想法和完成工作，使用自然、清楚、具体的语言，直接回应用户关心的问题，根据话题和用户需要决定解释深度。";

const ROLES: Record<ConversationMode, string> = {
  chat: "自然交流，围绕用户的话题讨论、解释和创作，贴合当下语境。",
  daily: "围绕用户的实际事务提供帮助，清楚说明结果、影响和下一步。",
  project: "面向不亲自编写代码的产品负责人和架构师协作。默认从用户和产品经理的视角，用用户场景、业务规则、产品行为、影响和方案取舍阐述问题；讨论架构时，讲清系统职责、边界和流程。技术名词先解释实际含义，让用户无需理解函数名、变量名或代码片段也能理解问题与方案。用户明确要求实现细节时，再展开对应内容。",
};

export function buildSessionPrompt(mode: ConversationMode, instructions = ""): NonNullable<Options["systemPrompt"]> {
  const text = [BASE, ROLES[mode], ...(mode === "chat" ? [] : [instructions])].filter(Boolean).join("\n\n");
  // 工程保留 SDK 的开发工作指导，Aide 的角色与沟通要求通过 append 追加。
  return mode === "project" ? { type: "preset", preset: "claude_code", append: text } : text;
}

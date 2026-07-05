/**
 * 把一次工具调用的 input 提炼成一行折叠态摘要文案。
 *
 * `ToolCallBlock.vue`（顶层工具调用卡片）和 `SubagentCallBlock.vue`（子代理内部的
 * 步骤时间线）共用同一套规则——两处以前各写了一份几乎一样的 if/else，容易改一处
 * 漏一处（比如 Bash 的展示逻辑只改了顶层卡片，子代理步骤还是老样子）。抽到这里
 * 作为唯一真相源。
 */
export function summarizeToolInput(name: string, input: unknown): string {
  const record = input as Record<string, unknown>;
  if (name === "Bash") return String(record?.command ?? "");
  if (["Read", "Write", "Edit"].includes(name)) return String(record?.file_path ?? "");
  return JSON.stringify(record).slice(0, 80);
}

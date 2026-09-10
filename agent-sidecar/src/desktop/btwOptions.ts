/** 由 btwMode / taskTools 构造 query() options 的增量部分(纯函数,可单测)。
 *  - 非 btw:无增量(主对话路径不受影响)
 *  - btw 问答支线(轻量/完整):仅 persistSession:false(阅后即弃,不落盘)。
 *    轻量支线绝不能再 tools:[]/allowedTools:[]——工具列表是请求前缀的一部分,
 *    改了前缀 prompt cache 必崩,fork 支线每次全价重读主会话历史(2026-08-09
 *    实锤五处前缀分歧之一)。「纯问答」语义由行为层实现:policy hook 全 deny
 *    + prompt 尾部指令(见 session-worker.ts),请求前缀与主会话逐字节一致。
 *  - btw 任务支线(git-commit 等,fork_from 空=全新会话):没有主会话缓存可吃,
 *    目标转为前缀最小化——tools/allowedTools 收成白名单,MCP 工具一并禁掉
 *    (tools 白名单只限内建,MCP 工具要靠 allowedTools 挡)。 */
export function btwQueryOverrides(btwMode: boolean, taskTools?: string[]): {
  persistSession?: false;
  tools?: string[];
  allowedTools?: string[];
} {
  if (!btwMode) return {};
  if (taskTools?.length) {
    return { persistSession: false, tools: taskTools, allowedTools: taskTools };
  }
  return { persistSession: false };
}

/** 构造 resume/fork 选项。shouldFork=true 时 fork 到新 session id(主会话 JSONL
 *  不被改动)。无 session id(全新会话)返回空对象——btw 任务支线(fork_from 空)
 *  正是走这条路成为全新会话。 */
export function forkResumeOptions(
  sessionId: string,
  shouldFork: boolean,
): { resume: string; forkSession?: true } | Record<string, never> {
  if (!sessionId) return {};
  return shouldFork ? { resume: sessionId, forkSession: true } : { resume: sessionId };
}

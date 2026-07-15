/** 由 btwMode / lightweightMode 构造 query() options 的增量部分(纯函数,可单测)。
 *  - 非 btw:无增量(主对话路径不受影响)
 *  - btw 完整:persistSession:false(阅后即弃,不落盘)
 *  - btw 轻量:再加 tools:[] + allowedTools:[](禁用所有工具 → 纯问答 + 省 token) */
export function btwQueryOverrides(btwMode: boolean, lightweight: boolean): {
  persistSession?: false;
  tools?: never[];
  allowedTools?: never[];
} {
  if (!btwMode) return {};
  if (lightweight) return { persistSession: false, tools: [], allowedTools: [] };
  return { persistSession: false };
}

/** 构造 resume/fork 选项。shouldFork=true 时 fork 到新 session id(主会话 JSONL
 *  不被改动)。无 session id(全新会话)返回空对象。 */
export function forkResumeOptions(
  sessionId: string,
  shouldFork: boolean,
): { resume: string; forkSession?: true } | Record<string, never> {
  if (!sessionId) return {};
  return shouldFork ? { resume: sessionId, forkSession: true } : { resume: sessionId };
}

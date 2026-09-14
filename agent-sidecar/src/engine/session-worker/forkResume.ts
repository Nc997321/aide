/** 构造 resume/fork 选项（纯函数，可单测）。
 *  shouldFork=true 时 fork 到新 session id（源会话 JSONL 不被改动）。
 *  无 session id（全新会话）返回空对象。 */
export function forkResumeOptions(
  sessionId: string,
  shouldFork: boolean,
): { resume: string; forkSession?: true } | Record<string, never> {
  if (!sessionId) return {};
  return shouldFork ? { resume: sessionId, forkSession: true } : { resume: sessionId };
}

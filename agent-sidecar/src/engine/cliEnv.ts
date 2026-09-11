// CLI 子进程 env 组装（session-worker.ts 拆分批 3 迁出，纯移动）：
// 白名单透传 → per-session 覆盖 → automation 会话目录 → effort 显式删除 → 固定注入。
import { cliSubagentModelEnvValue } from "./subagentModelDefault.js";

export interface CliEnvParams {
  processEnv: NodeJS.ProcessEnv;
  /** per-session provider 连接参数覆盖（send.env 通道，见 applySendRuntimeConfig）。 */
  envOverrides: Record<string, string>;
  /** automation.session_dir（协议一等字段）：非空时 CLAUDE_CONFIG_DIR 指向隔离配置根。 */
  automationSessionDir?: string | undefined;
}

/** 构造传给 claude CLI 子进程的显式 env。 */
export function buildCliEnv(p: CliEnvParams): Record<string, string | undefined> {
  const cliEnv: Record<string, string | undefined> = { ...p.processEnv };
  for (const k of [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL",
    // 注意：CLAUDE_CODE_EFFORT_LEVEL 刻意不透传——它会压过 applyFlagSettings、
    // 并与 options.effort 就高合并（2026-08-01 smoke 实锤），会让会话内
    // effort 切换被 env 搅乱。effort 只走 options.effort + applyFlagSettings。
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
  ]) {
    if (p.processEnv[k]) cliEnv[k] = p.processEnv[k];
  }
  // per-session env 覆盖（provider 连接参数）
  for (const [k, v] of Object.entries(p.envOverrides)) {
    if (v) cliEnv[k] = v;
  }
  // 会话目录：协议一等字段（automation.session_dir）优先于透传/env。
  // automation 任务的子进程 CLAUDE_CONFIG_DIR 指向作用域隔离配置根，
  // 转录落 <sessionDir>/projects/<cwd 编码>/，不进全局 projects
  //（list_workspaces 全量扫描那里，混进去即侧栏污染，2026-09-07）。
  // 注意指令加载(loadAideInstructions)仍读全局——指令是用户全局配置，
  // 隔离的只是子进程自己的写盘位置。
  if (p.automationSessionDir) {
    cliEnv.CLAUDE_CONFIG_DIR = p.automationSessionDir;
  }
  // {...process.env} 的扩散和 envOverrides 都可能带进 CLAUDE_CODE_EFFORT_LEVEL
  // （用户全局 env / Rust provider 注入），必须在最后显式删除。
  delete cliEnv.CLAUDE_CODE_EFFORT_LEVEL;
  cliEnv.CLAUDE_CODE_SUBAGENT_MODEL = cliSubagentModelEnvValue(p.processEnv);
  // SDK 0.3.233 起 Todo/task 工具(TaskCreate/TaskGet/TaskUpdate/TaskList/
  // TodoWrite)在新模型(Opus 4.8/Sonnet 5/Fable 5)上不再默认进工具面——Aide
  // 的 TaskListPanel 与轮间 TODO 覆盖逻辑依赖它们，显式 env 保持默认可用。
  // 选 env 而非 query.tools：只恢复这一组的默认地位，不触碰 tools 白名单
  // (btw taskTools/automation 收窄语义不变，白名单没列的照样不注入)。
  cliEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
  return cliEnv;
}

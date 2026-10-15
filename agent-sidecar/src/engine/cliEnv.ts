// CLI 子进程 env 组装（session-worker.ts 拆分批 3 迁出，纯移动）：
// 进程 env 为底 → per-session 覆盖 → automation 会话目录 → effort 显式删除 → 思考值注入 → 固定注入。
import { cliSubagentModelEnvValue } from "./subagentModelDefault.js";

/** 关思考的请求体补丁：CLI 只对**它自己名单里**的模型名才发 thinking 参数，名单外整个字段
 *  丢掉，而兼容端点「没有该字段 = 默认开推理」——于是只剩展示层隐藏、token 照烧。
 *  这个 env 绕过名单直接写请求体，且**不依赖供应商认 Claude 名**（模型名保持精确真名）。
 *  实测见 agent-sidecar/probe-extra-body.ts（5 臂）与
 *  docs/discussions/2026-09-19-thinking-disable-on-third-party-endpoints.md。 */
const THINKING_DISABLED_BODY = '{"thinking":{"type":"disabled"}}';

export interface CliEnvParams {
  processEnv: NodeJS.ProcessEnv;
  /** per-session provider 连接参数覆盖（send.env 通道，见 applySendRuntimeConfig）。 */
  envOverrides: Record<string, string>;
  /** 子进程配置根覆盖：automation.session_dir 或 send.config_dir（协议一等字段）。
   *  非空时 CLAUDE_CONFIG_DIR 指向隔离配置根。 */
  configDirOverride?: string | undefined;
  /** 本条 query 是否关思考。**唯一推导点**是 thinkingPolicy.thinkingDisabledFor，
   *  同一值也喂给 queryOptions 的 thinking 选项——两处各推一遍会劈叉。 */
  thinkingDisabled: boolean;
}

/** 本会话的生效环境 = 进程 env 为底 + 本条 send 的 env 覆盖（空值不覆盖）。
 *  **供应商参数只该从这里读**（地址 / 模型映射 / 子代理模型…）：它们是会话属性，
 *  随每条 send 现带；sidecar 进程 env 里没有（Host 启动 sidecar 时刻意不写，见 Rust
 *  `runtime::env::runtime_process_env`）。直接读 process.env 会读不到，或读到用户
 *  shell 泄漏进来的无关值。 */
export function sessionEnvOf(
  processEnv: NodeJS.ProcessEnv,
  envOverrides: Record<string, string>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...processEnv };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v) env[k] = v;
  }
  return env;
}

/** 构造传给 claude CLI 子进程的显式 env。 */
export function buildCliEnv(p: CliEnvParams): Record<string, string | undefined> {
  const cliEnv = sessionEnvOf(p.processEnv, p.envOverrides);
  // 会话目录：协议一等字段（automation.session_dir / send.config_dir）优先于透传/env。
  // automation 任务的子进程 CLAUDE_CONFIG_DIR 指向作用域隔离配置根，
  // 转录落 <sessionDir>/projects/<cwd 编码>/，不进全局 projects
  //（list_workspaces 全量扫描那里，混进去即侧栏污染，2026-09-07）。
  // 注意指令加载(loadAideInstructions)仍读全局——指令是用户全局配置，
  // 隔离的只是子进程自己的写盘位置。
  if (p.configDirOverride) {
    cliEnv.CLAUDE_CONFIG_DIR = p.configDirOverride;
  }
  // {...process.env} 的扩散和 envOverrides 都可能带进 CLAUDE_CODE_EFFORT_LEVEL
  // （用户全局 env / Rust provider 注入），必须在最后显式删除。
  delete cliEnv.CLAUDE_CODE_EFFORT_LEVEL;
  // 关思考：EXTRA_BODY 是**硬覆盖**（SDK 要 adaptive 也照样被改写成 disabled，探针 E 臂），
  // 而上面 {...process.env} 与 envOverrides 都可能把这个键带进来——用户全局 env、Rust
  // provider 注入、或别处忘了清。残留一次就静默吃掉**每个**会话的思考，所以先删再按需设，
  // 且值只认我们这份常量（不被残留值改写）。与 CLAUDE_CODE_EFFORT_LEVEL 同一个坑。
  delete cliEnv.CLAUDE_CODE_EXTRA_BODY;
  if (p.thinkingDisabled) cliEnv.CLAUDE_CODE_EXTRA_BODY = THINKING_DISABLED_BODY;
  // 子代理模型按**本会话**的供应商配置折算（此刻 cliEnv 还是未改写的会话环境）；
  // 读 processEnv 的话拿到的是 sidecar 启动那一刻的值，切供应商后就是别家的。
  cliEnv.CLAUDE_CODE_SUBAGENT_MODEL = cliSubagentModelEnvValue(cliEnv);
  // SDK 0.3.233 起 Todo/task 工具(TaskCreate/TaskGet/TaskUpdate/TaskList/
  // TodoWrite)在新模型(Opus 4.8/Sonnet 5/Fable 5)上不再默认进工具面——Aide
  // 的 TaskListPanel 与轮间 TODO 覆盖逻辑依赖它们，显式 env 保持默认可用。
  // 选 env 而非 query.tools：只恢复这一组的默认地位，不触碰 tools 白名单
  // (automation 收窄语义不变，白名单没列的照样不注入)。
  cliEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
  // 凭据相关 env 不进 CLI 子进程：Bash 工具会继承它，模型跑 `env` 即得凭据文件
  // 绝对路径，再 cat 即得 token——这正是设计 spec §3 否决「凭据走 env」的理由。
  // aide-knowledge 的 MCP 工具在 sidecar 进程内执行（type:"sdk"），不需要它。
  delete cliEnv.AIDE_KB_CONFIG_FILE;
  return cliEnv;
}

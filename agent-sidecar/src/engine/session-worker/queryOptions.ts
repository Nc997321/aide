// query() spawn options 装配（session-worker.ts 拆分批 3 迁出，纯移动）。
// ⚠️ 字段与展开链的顺序是承重语义：forkResumeOptions → automationQueryOverrides
// （tools 白名单 + 护栏）——改动别乱序。parts 按 M2 分组（runtime/workspace/branch/model/fork），
// 对象化沿 mapper.ts MapperDeps 先例（宽装配函数的注入形状）。
import type { Options, PermissionMode, EffortLevel, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { CODEGRAPH_ALLOW_RULE } from "../../extensions/codegraphTools.js";
import { DOCS_ALLOW_RULE } from "../../extensions/docsMcp.js";
import { KNOWLEDGE_READ_RULES } from "../../extensions/knowledgeMcp.js";
import { BROWSER_ALLOW_RULES } from "../../extensions/browserMcp.js";
import { buildPluginsOption, buildDispatchPluginsOption } from "../../extensions/dispatchPlugins.js";
import { forkResumeOptions } from "./forkResume.js";
import { automationQueryOverrides, type AutomationConfig } from "../../desktop/automation.js";
import { resolveClaudeExe } from "../claudeExe.js";
import type { PreparedQueryContext } from "./queryContext.js";

export interface QuerySpawnParts {
  runtime: {
    abortController: AbortController;
    /** permModes.current 在 PermissionModeController.apply 里按白名单校验后才写，
     *  调用方断言为 SDK 字面量联合（含 auto/dontAsk）只表达"必然是合法值"。 */
    permissionMode: PermissionMode;
    canUseTool: CanUseTool;
    /** query 前置准备产物（instructions/hooks/mcpServers 终装）。 */
    ctx: PreparedQueryContext;
    cliEnv: Record<string, string | undefined>;
  };
  workspace: {
    trusted: boolean;
    /** effectiveCwd（cwd ?? worker.cwd ?? ""）：plugins 解析用。 */
    cwd: string;
    /** startLoop 入参 cwd（options.cwd 首选）。 */
    cwdParam: string | undefined;
    /** worker.cwd（兜底）。 */
    cwdWorker: string | undefined;
    /** 本会话已授权的附加目录（@目录 账本，见 attachDirs.ts）。空/缺省 = 不落字段。 */
    additionalDirs?: string[];
  };
  branch: {
    automationConfig: AutomationConfig | undefined;
  };
  model: {
    /** 已翻回 SDK 别名的模型（"" = 不带 model 字段）；内部一律用真名。 */
    sdkModel: string;
    /** 会话级 effort（"" = 不带；spawn 通道，会话中切换走 applyFlagSettings）。 */
    effort: string;
    thinkingEnabled: boolean;
  };
  fork: {
    resumeSource: string;
    shouldFork: boolean;
  };
}

export function buildSpawnQueryOptions(p: QuerySpawnParts): Options {
  return {
    abortController: p.runtime.abortController,
    permissionMode: p.runtime.permissionMode,
    allowDangerouslySkipPermissions: true,
    canUseTool: p.runtime.canUseTool,
    settingSources: [],
    // 受限模式（!trusted）：strictMcpConfig 忽略项目 .mcp.json 等外部 MCP 配置；
    // buildDispatchPluginsOption 不注入项目级散装 plugin（项目 skills/agents
    // 不进 agent）。user 级不受影响。
    ...(p.workspace.trusted ? {} : { strictMcpConfig: true }),
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: p.runtime.ctx.instructions,
    },
    // 知识库只放行**读**工具（工具级规则）——写工具走权限弹窗，见 knowledgeMcp.ts。
    // 浏览器三个工具全放行：`browser_eval` 与 Bash 同信任级别，且只要它放行，单独给其余
    // 工具挂闸门就是装饰性的（见 browserMcp.ts 的论证）。唯一真控制 = AIDE_BROWSER_TOOLS=off。
    // 两组都必须是**工具级**规则（server 级前缀会把同 server 的其余工具一起放行）。
    allowedTools: [
      "Agent",
      "Task",
      CODEGRAPH_ALLOW_RULE,
      DOCS_ALLOW_RULE,
      ...KNOWLEDGE_READ_RULES,
      ...BROWSER_ALLOW_RULES,
    ],
    // 自动化运行全关：每次都是全新会话，精简基座 = 省钱 + 行为确定。
    // 主对话/侧问保持 "all"/全量：侧问走主会话存活的 query，根本不重建这些选项。
    skills: p.branch.automationConfig ? [] : "all",
    plugins: p.branch.automationConfig
      ? []
      : [...buildPluginsOption(), ...buildDispatchPluginsOption(p.workspace.cwd, p.workspace.trusted)],
    hooks: p.runtime.ctx.hooks,
    // 终装链（内建+用户 → automation 白名单过滤 → 会话级头注入）见 queryContext.ts。
    mcpServers: p.runtime.ctx.mcpServers,
    // 主会话开 partial：让 thinking_delta 逐字流式（mapper 只放 thinking_delta，
    // text 仍走整块，避开历史 partial 卡死坑，见 2026-08-07-thinking-streaming-design）。
    includePartialMessages: !p.branch.automationConfig,
    // 下发给 SDK 的是它自己那份 value（别名）；内部一律用真名。
    ...(p.model.sdkModel ? { model: p.model.sdkModel } : {}),
    // effort 的 spawn 通道（会话中切换走 set_effort → applyFlagSettings）。
    ...(p.model.effort ? { effort: p.model.effort as EffortLevel } : {}),
    // 请求可读思考文本：Claude 官方模型 thinking.display 默认 omitted（block
    // 在但 text 空），显式 summarized 才回可读摘要。GLM 等第三方不一定认此
    // 参数但无害——主线程思考展示的兜底保险（诊断见 docs/mockups/）。
    // 思考开关（send.thinking_enabled 下发，「设置→通用」）：请求层只在这里
    // spawn 时生效——官方 API 关思考靠这里（请求体无 thinking 字段）；ollama
    // 等兼容端点不认 thinking 参数（无字段=模型自决，推理模型必出思考块，
    // 2026-08-21 mock 端点实锤），API 层关不掉，靠 mapSdkMessage 的
    // showThinking 展示层剥除兜底。与 effort 解耦（2026-08-21 决策：effort 切换
    // 不再联动 thinking）。
    thinking: p.branch.automationConfig
      ? { type: "disabled" }
      : p.model.thinkingEnabled
        ? { type: "adaptive", display: "summarized" }
        : { type: "disabled" },
    ...(p.workspace.cwdParam ? { cwd: p.workspace.cwdParam } : {}),
    ...(p.workspace.cwdWorker && !p.workspace.cwdParam ? { cwd: p.workspace.cwdWorker } : {}),
    // 附加目录（@目录 账本，见 attachDirs.ts）：空/缺省不落字段。只给文件访问权、
    // 不加载对方仓配置——这个性质挂在下面的 settingSources: [] 上（方案 F4 实测）。
    ...(p.workspace.additionalDirs?.length
      ? { additionalDirectories: p.workspace.additionalDirs }
      : {}),
    ...(resolveClaudeExe()
      ? { pathToClaudeCodeExecutable: resolveClaudeExe() }
      : {}),
    ...forkResumeOptions(p.fork.resumeSource, p.fork.shouldFork),
    // 任务支线(tools 白名单)在此覆盖前面的统一 allowedTools;问答支线
    // 只带 persistSession:false,不碰工具列表(缓存前缀红线)。
    // 自动化:tools 收成白名单 + maxTurns/maxBudgetUsd 护栏透传。
    ...automationQueryOverrides(p.branch.automationConfig),
    env: p.runtime.cliEnv,
  };
}

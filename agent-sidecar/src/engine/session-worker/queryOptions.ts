// query() spawn options 装配（session-worker.ts 拆分批 3 迁出，纯移动）。
// ⚠️ 字段与展开链的顺序是承重语义：forkResumeOptions → btwQueryOverrides（任务
// 支线在此覆盖统一 allowedTools）→ automationQueryOverrides（tools 白名单 +
// 护栏）——改动别乱序。parts 按 M2 分组（runtime/workspace/branch/model/fork），
// 对象化沿 mapper.ts MapperDeps 先例（宽装配函数的注入形状）。
import type { Options, PermissionMode, EffortLevel, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { CODEGRAPH_ALLOW_RULE } from "../../extensions/codegraphTools.js";
import { DOCS_ALLOW_RULE } from "../../extensions/docsMcp.js";
import { KNOWLEDGE_READ_RULES } from "../../extensions/knowledgeMcp.js";
import { buildPluginsOption, buildDispatchPluginsOption } from "../../extensions/dispatchPlugins.js";
import { forkResumeOptions, btwQueryOverrides } from "../../desktop/btwOptions.js";
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
  };
  branch: {
    btwMode: boolean;
    /** btw 任务支线白名单（非空 = 任务支线：skills/plugins/codegraph 全关）。 */
    taskTools: string[] | undefined;
    automationConfig: AutomationConfig | undefined;
    lightweightMode: boolean;
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
    // allowedTools 统一:问答支线(轻量/完整)与主会话同形,保持前缀一致;
    // btw 任务支线由 btwQueryOverrides 在后方覆盖成白名单。
    // 知识库只放行**读**工具（工具级规则）——写工具走权限弹窗，见 knowledgeMcp.ts。
    allowedTools: ["Agent", "Task", CODEGRAPH_ALLOW_RULE, DOCS_ALLOW_RULE, ...KNOWLEDGE_READ_RULES],
    // btw 任务支线:skills/plugins 全关——全新会话没有缓存可吃,
    // 前缀最小化(skill 清单/plugin 自带 MCP 工具都不进上下文)。
    // 轻量 btw 保持 "all"/全量:与主会话前缀对齐吃 prompt cache。
    // 自动化运行同理全关：每次都是全新会话，精简基座 = 省钱 + 行为确定。
    skills: p.branch.taskTools || p.branch.automationConfig ? [] : "all",
    plugins: p.branch.taskTools || p.branch.automationConfig
      ? []
      : [...buildPluginsOption(), ...buildDispatchPluginsOption(p.workspace.cwd, p.workspace.trusted, p.branch.lightweightMode)],
    hooks: p.runtime.ctx.hooks,
    // 终装链（内建+用户 → automation 白名单过滤 → 会话级头注入）见 queryContext.ts。
    mcpServers: p.runtime.ctx.mcpServers,
    // 主会话开 partial：让 thinking_delta 逐字流式（mapper 只放 thinking_delta，
    // text 仍走整块，避开历史 partial 卡死坑，见 2026-08-07-thinking-streaming-design）。
    // btw 轻量支线保持 partial=off（mapper 的子代理隔离守卫也对 btw 生效）。
    includePartialMessages: !p.branch.btwMode && !p.branch.automationConfig,
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
    // showThinking 展示层剥除兜底。btw 支线恒 disabled（轻量问答省 token）；
    // 与 effort 解耦（2026-08-21 决策：effort 切换不再联动 thinking）。
    thinking: p.branch.btwMode || p.branch.automationConfig
      ? { type: "disabled" }
      : p.model.thinkingEnabled
        ? { type: "adaptive", display: "summarized" }
        : { type: "disabled" },
    ...(p.workspace.cwdParam ? { cwd: p.workspace.cwdParam } : {}),
    ...(p.workspace.cwdWorker && !p.workspace.cwdParam ? { cwd: p.workspace.cwdWorker } : {}),
    ...(resolveClaudeExe()
      ? { pathToClaudeCodeExecutable: resolveClaudeExe() }
      : {}),
    ...forkResumeOptions(p.fork.resumeSource, p.fork.shouldFork),
    // 任务支线(tools 白名单)在此覆盖前面的统一 allowedTools;问答支线
    // 只带 persistSession:false,不碰工具列表(缓存前缀红线)。
    ...btwQueryOverrides(p.branch.btwMode, p.branch.taskTools),
    // 自动化:tools 收成白名单 + maxTurns/maxBudgetUsd 护栏透传。
    ...automationQueryOverrides(p.branch.automationConfig),
    env: p.runtime.cliEnv,
  };
}

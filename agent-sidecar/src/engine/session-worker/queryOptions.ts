// query() spawn options 装配（session-worker.ts 拆分批 3 迁出，纯移动）。
// ⚠️ 字段与展开链的顺序是承重语义：forkResumeOptions → automationQueryOverrides
// （tools 白名单 + 护栏）——改动别乱序。parts 按 M2 分组（runtime/workspace/branch/model/fork），
// 对象化沿 mapper.ts MapperDeps 先例（宽装配函数的注入形状）。
import type { Options, PermissionMode, EffortLevel, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { LSP_ALLOW_RULE } from "../../extensions/lspTools.js";
import { DOCS_ALLOW_RULE } from "../../extensions/docsMcp.js";
import { KNOWLEDGE_READ_RULES } from "../../extensions/knowledgeMcp.js";
import { MEMORY_READ_RULES } from "../crossMemory.js";
import { BROWSER_ALLOW_RULES } from "../../extensions/browserMcp.js";
import { buildPluginsOption, buildDispatchPluginsOption, type SdkPluginConfig } from "../../extensions/dispatchPlugins.js";
import { retireBuiltinLspPlugins } from "../../extensions/lspRetire.js";
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
    /** 该工作区配得上 LSP 的语言（主进程算好下发）。与 trust 同为 LSP 总闸的输入，
     *  C3 用它决定要不要退役内置 LSP 插件——见 pluginDirs。 */
    lspLanguages: string[];
  };
  branch: {
    automationConfig: AutomationConfig | undefined;
  };
  model: {
    /** 已翻回 SDK 别名的模型（"" = 不带 model 字段）；内部一律用真名。 */
    sdkModel: string;
    /** 会话级 effort（"" = 不带；spawn 通道，会话中切换走 applyFlagSettings）。 */
    effort: string;
    /** 本条 query 是否关思考。来自 thinkingPolicy.thinkingDisabledFor——**唯一推导点**，
     *  同一个值也喂给 cliEnv（EXTRA_BODY 注入），别在这里再推一遍。 */
    thinkingDisabled: boolean;
  };
  fork: {
    resumeSource: string;
    shouldFork: boolean;
  };
}

/** `--plugin-dir` 列表装配。automation 全关（前缀最小化）。
 *
 *  C3：aide-lsp 接管时剔掉声明 LSP 的市场插件——内置 LSP 通道退役，否则同一仓库会起
 *  第二份语言服务器，且它在冷窗口那句平铺直叙的 "No references found" 会把 aide-lsp
 *  的诚实状态信号抵消掉（见 lspRetire.ts）。
 *
 *  闸门读 `process.env`：与 `lspMcpRegistration` 收到的 processEnv 是同一份，
 *  **不是** cliEnv（两者白名单不同，AIDE_LSP_TOOLS 只在进程环境里稳定可见）。 */
function pluginDirs(p: QuerySpawnParts): SdkPluginConfig[] {
  const all = [
    ...buildPluginsOption(),
    ...buildDispatchPluginsOption(p.workspace.cwd, p.workspace.trusted),
  ];
  return retireBuiltinLspPlugins(all, {
    trusted: p.workspace.trusted,
    lspLanguages: p.workspace.lspLanguages,
    env: process.env,
  });
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
      DOCS_ALLOW_RULE,
      // LSP 工具同属只读、不弹窗。即便本工作区没挂载 aide-lsp（四档闸门没过），
      // 这条规则也只是永不匹配。
      LSP_ALLOW_RULE,
      ...KNOWLEDGE_READ_RULES,
      // 跨工作区记忆只读，同样是工具级规则。
      ...MEMORY_READ_RULES,
      ...BROWSER_ALLOW_RULES,
    ],
    // 会话 cwd 是 Aide 自持属性（wsPath 档案 / ChangeLog 基线 / Host 目录探测都认它）。
    // EnterWorktree 会在会话中途改 cwd——档案对不上 = 「跑错项目」，且 UI 看不见。
    // disallowedTools 把工具从模型上下文里整个摘掉（不依赖权限模式，auto/bypass 下也拦得住）。
    // 只拦会话级切换；Agent 工具的 isolation:"worktree" 只动子代理 cwd，不在此列。
    // 要放开须先把 worktree 做成一等工作区概念（新会话 + wsPath 指向它），别在这里删。
    disallowedTools: ["EnterWorktree", "ExitWorktree"],
    // 自动化运行全关：每次都是全新会话，精简基座 = 省钱 + 行为确定。
    // 主对话/侧问保持 "all"/全量：侧问走主会话存活的 query，根本不重建这些选项。
    skills: p.branch.automationConfig ? [] : "all",
    plugins: p.branch.automationConfig ? [] : pluginDirs(p),
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
    // 值来自 thinkingDisabled（唯一推导点 thinkingPolicy.ts：automation 恒关、否则档位
    // 说了算）。注意这一项**只对 CLI 认识的模型名有效**——名单外的名字 CLI 会把整个字段
    // 丢掉，靠 cliEnv 注入的 CLAUDE_CODE_EXTRA_BODY 补上（2026-09-19 实测，见
    // docs/discussions/2026-09-19-thinking-disable-on-third-party-endpoints.md）。
    // 与 effort 解耦（2026-08-21 决策：effort 切换不再联动 thinking）。
    thinking: p.model.thinkingDisabled
      ? { type: "disabled" }
      : { type: "adaptive", display: "summarized" },
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

// query() 前置准备（session-worker.ts 拆分批 3 迁出，纯移动）：内建 MCP
// （codegraph/docs）注册、Aide 指令加载、内建+用户 hooks 终装、mcpServers 终装
// （含 automation 白名单过滤与会话级头注入）。deps 对象化沿 mapper.ts 的
// MapperDeps 先例（宽装配函数的注入形状，审查 P1 修复模式）。
import type { ChatEvent } from "../types.js";
import { codegraphMcpRegistration } from "../../extensions/codegraphTools.js";
import { docsMcpRegistration } from "../../extensions/docsMcp.js";
import { knowledgeMcpRegistration } from "../../extensions/knowledgeMcp.js";
import { buildBuiltinHooks, type HookBuildContext, type BuiltinHookManifest } from "../../extensions/builtinHooks/index.js";
import { loadUserMcpServers, loadUserHooks, assembleMcpServers, assembleHooks } from "../userExtensions.js";
import { applyMcpHeaders, type McpHeaderMap } from "../sessionMetadata.js";
import { filterMcpServers, type AutomationConfig } from "../../desktop/automation.js";
import { loadAideInstructions } from "../instructions.js";

export interface QueryContextDeps {
  /** effectiveCwd（worker 已解析：cwd ?? this.cwd ?? ""）。 */
  cwd: string;
  trusted: boolean;
  codegraphEnabled: boolean;
  processEnv: NodeJS.ProcessEnv;
  emit: (e: ChatEvent) => void;
  /** btw 任务支线白名单：非空时 codegraph/docs 跳过注册（前缀最小化）。 */
  taskTools: string[] | undefined;
  automationConfig: AutomationConfig | undefined;
  mcpHeaders: McpHeaderMap | undefined;
  /** builtinHooks 的会话适配器（worker 建闭包桥接 private 成员：
   *  policy/stopEffort/modelSwitchGuard/metadata）。 */
  session: HookBuildContext["session"];
}

export interface PreparedQueryContext {
  instructions: string;
  /** hooks 终装（内建在前、用户追加；内建 policy 恒为 PreToolUse[0]，不可越过）。
   *  any 面沿 userExtensions.assembleHooks 既有返回形状（历史欠账，本批不收紧，X1 例外注释在案）。 */
  hooks: Record<string, any>;
  hookManifest: BuiltinHookManifest[];
  /** mcpServers 终装：内建(codegraph/docs) + 用户配置 → automation 白名单过滤
   *  → 会话级头注入。any 面沿 assembleMcpServers 既有返回形状（同上）。 */
  mcpServers: Record<string, any>;
}

export async function prepareQueryContext(deps: QueryContextDeps): Promise<PreparedQueryContext> {
  // codegraph agent 工具：默认注册（AIDE_CODEGRAPH_TOOLS=off 关闭）。
  // handler 闭包持有本会话的 emit（经 DeltaCoalescer，红线）与 cwd。
  // btw 任务支线(taskTools,全新会话)跳过:任务用不上代码索引,前缀最小化。
  // 轻量 btw 不再跳过——问答支线要保持与主会话请求前缀逐字节一致,
  // 少注册 MCP 工具 = 工具列表不同 = prompt cache 必崩(2026-08-09 实锤);
  // 模型误调由 policy hook 的轻量全 deny 兜底,不会卡。
  // 挂载还随工作区索引开关（codegraph_enabled，主进程下发，每工作区默认关）。
  const codegraphMcp = deps.taskTools
    ? null
    : codegraphMcpRegistration(
        deps.cwd,
        deps.emit,
        deps.processEnv,
        deps.trusted,
        deps.codegraphEnabled,
      );
  // 文档工具(docx + pdf):注册条件=任务支线跳过、!trusted 跳过、AIDE_DOCX_TOOLS=off
  // 跳过——**不跟随 codegraph_enabled**（docx/pdf 不扫盘不建索引，见 docsMcp.ts）。
  // 无 emit 参数——docx/pdf 一次性同步解析,不像 codegraph 要 IPC 客户端。
  const docsMcp = deps.taskTools
    ? null
    : docsMcpRegistration(deps.cwd, deps.processEnv, deps.trusted);
  // 知识库读写（P1 只有读工具）：注册条件=任务支线跳过、!trusted 跳过、
  // AIDE_KB_TOOLS=off 跳过。**未登录也挂**——凭据每次调用现读，未配置时工具返回
  // 「去知识库面板登录」的引导文本（设计 spec §5.1）。无 emit 参数：直连知识库
  // 的 HTTP，不走主进程 IPC（不像 codegraph）。
  const knowledgeMcp = knowledgeMcpRegistration(deps.processEnv, deps.trusted, deps.taskTools);

  // Aide 指令加载：不依赖 SDK 文件系统 setting source，自己读 global + project
  // CLAUDE.md 追加到 preset system prompt。settingSources 必须为空，否则 SDK
  // 仍会去读 .claude/settings*.json，与 Aide 独立设置体系冲突。
  const instructions = await loadAideInstructions(
    deps.cwd,
    deps.processEnv.CLAUDE_CONFIG_DIR ?? "",
    deps.trusted,
  );
  // 内建 hooks 统一走 builtinHooks 注册表：policy 恒为 PreToolUse[0]
  // （权威前置层，用户 hook 不可越过），subagentModel/skillGuard
  // 按条件挂载。builtinHookManifest 经清单通道回传前端（Task 3 接线）。
  const { hooks: builtinHooks, manifest: builtinHookManifest } = buildBuiltinHooks({
    cwd: deps.cwd,
    env: deps.processEnv,
    session: deps.session,
  });
  // 用户扩展（settings.json 的 mcpServers/hooks）：mcpServers 与 codegraph 按
  // name 共存；hooks 内建在前、用户追加（内建 policy 恒为 PreToolUse[0]，不可越过）。
  const userMcp = loadUserMcpServers();
  // command 型条目在这里编译成 HookCallback（F4：SDK hooks 通道只认函数）；
  // cwd 注入 hook 子进程工作目录。
  const userHooks = loadUserHooks({ cwd: deps.cwd });

  // mcpServers 终装：内建(codegraph/docs) + 用户配置 → automation 白名单过滤
  //（未预授权的连接器不挂载——其工具对模型根本不存在，第一层收口；policy hook
  // 白名单裁决是第二层）→ 会话级头注入。applyMcpHeaders 只动 http/sse 条目
  //（内建 sdk 型天然不受影响）；桌面路径 mcpHeaders=undefined 时零拷贝直通
  //（见 sessionMetadata.ts）。
  const assembledMcp = assembleMcpServers(
    { ...(codegraphMcp ?? {}), ...(docsMcp ?? {}), ...(knowledgeMcp ?? {}) },
    userMcp,
  );
  const mcpServers = applyMcpHeaders(
    deps.automationConfig
      ? filterMcpServers(assembledMcp, deps.automationConfig.mcpAllowlist)
      : assembledMcp,
    deps.mcpHeaders,
  );

  return {
    instructions,
    hooks: assembleHooks(builtinHooks, userHooks),
    hookManifest: builtinHookManifest,
    mcpServers,
  };
}

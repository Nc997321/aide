// query() 前置准备（session-worker.ts 拆分批 3 迁出，纯移动）：内建 MCP
// （docs / knowledge / browser / lsp）注册、Aide 指令加载、内建+用户 hooks 终装、mcpServers 终装
// （含 automation 白名单过滤与会话级头注入）。deps 对象化沿 mapper.ts 的
// MapperDeps 先例（宽装配函数的注入形状，审查 P1 修复模式）。
import type { ChatEvent } from "../types.js";
import { docsMcpRegistration } from "../../extensions/docsMcp.js";
import { knowledgeMcpRegistration } from "../../extensions/knowledgeMcp.js";
import type { KbScopeStore } from "../../extensions/knowledge/scope.js";
import { browserMcpRegistration } from "../../extensions/browserMcp.js";
import { lspMcpRegistration } from "../../extensions/lspTools.js";
import { lspToolsMounted, type LspGate } from "../../extensions/lspGate.js";
import { buildBuiltinHooks, type HookBuildContext, type BuiltinHookManifest } from "../../extensions/builtinHooks/index.js";
import { loadUserMcpServers, loadAppMcp, loadUserHooks, assembleMcpServers, assembleHooks } from "../userExtensions.js";
import { filterMcpServers, type AutomationConfig } from "../../desktop/automation.js";
import { loadAideInstructions } from "../instructions.js";
import { loadLspHint } from "../lspHint.js";
import { crossMemoryMcpRegistration } from "../crossMemory.js";

export interface QueryContextDeps {
  /** effectiveCwd（worker 已解析：cwd ?? this.cwd ?? ""）。 */
  cwd: string;
  trusted: boolean;
  /** 本会话的 @目录账本（附加根）——只有 spawn 期这一条路进 system prompt，
   *  中途 @ 的靠消息级目录段当轮送达（方案 F6 / D 段）。 */
  attachedDirs?: string[];
  /** 「可参考的其他工作区」的**现取**入口（read_memory 工具用）。与 attachedDirs 寿命不同：
   *  attachedDirs 是 spawn 时的快照、只喂 system prompt；这里每次调用现取，所以会话中途
   *  @ 的目录立刻可读记忆，不必重建 query。 */
  memoryRoots?: () => string[];
  /** 该工作区配得上 LSP 的语言（空 = 不挂 aide-lsp 工具）。 */
  lspLanguages: string[];
  processEnv: NodeJS.ProcessEnv;
  emit: (e: ChatEvent) => void;
  /** 本会话的「用户在知识库里圈选的范围」登记簿（由 worker 持有、随用户消息更新）；
   *  知识库工具据此把写入限制在圈选范围内。 */
  kbScopes?: KbScopeStore;
  automationConfig: AutomationConfig | undefined;
  /** builtinHooks 的会话适配器（worker 建闭包桥接 private 成员：
   *  policy/stopEffort/modelSwitchGuard）。 */
  session: HookBuildContext["session"];
}

export interface PreparedQueryContext {
  instructions: string;
  /** hooks 终装（内建在前、用户追加；内建 policy 恒为 PreToolUse[0]，不可越过）。
   *  any 面沿 userExtensions.assembleHooks 既有返回形状（历史欠账，本批不收紧，X1 例外注释在案）。 */
  hooks: Record<string, any>;
  hookManifest: BuiltinHookManifest[];
  /** mcpServers 终装：内建(docs/knowledge/browser/lsp) + 用户配置 → automation 白名单过滤
   *  → 会话级头注入。any 面沿 assembleMcpServers 既有返回形状（同上）。 */
  mcpServers: Record<string, any>;
  /** 侧栏应用后端里免确认的工具（工具级规则，进 allowedTools）。只含真的挂上了的 server 的。 */
  appAllowRules: string[];
}

export async function prepareQueryContext(deps: QueryContextDeps): Promise<PreparedQueryContext> {
  // 文档工具(docx + pdf):注册条件=!trusted 跳过、AIDE_DOCX_TOOLS=off 跳过
  // 无 emit 参数——docx/pdf 一次性同步解析，不走主进程 IPC。
  const docsMcp = docsMcpRegistration(deps.cwd, deps.processEnv, deps.trusted);
  // 知识库读写（P1 只有读工具）：注册条件=!trusted 跳过、AIDE_KB_TOOLS=off 跳过。
  // **未登录也挂**——凭据每次调用现读，未配置时工具返回「去知识库面板登录」的引导
  // 文本（设计 spec §5.1）。无 emit 参数：直连知识库的 HTTP，不走主进程 IPC。
  const knowledgeMcp = knowledgeMcpRegistration(deps.processEnv, deps.trusted, deps.cwd, deps.kbScopes);
  // 跨工作区记忆（只读）：参考别的工作区的 auto memory 正文。!trusted 跳过；恒挂，
  // 让中途 @ 的目录立即可用（见 crossMemory.ts）。
  const memoryMcp = crossMemoryMcpRegistration(
    { configDir: deps.processEnv.CLAUDE_CONFIG_DIR ?? "", roots: deps.memoryRoots ?? (() => deps.attachedDirs ?? []) },
    deps.trusted,
  );
  // 内嵌浏览器读写（读骨架 / 执行脚本 / CDP）：注册条件=!trusted 跳过、AIDE_BROWSER_TOOLS=off
  // 跳过。**带 emit**——它要走 request_id 桥回桌面 Rust 驱动 WebView2（本仓库第三种形态：
  // knowledge 直连 HTTP、docs 本地同步解析、lsp 与本插件回主进程）。
  const browserMcp = browserMcpRegistration(deps.emit, deps.processEnv, deps.trusted);
  // agent LSP 工具：闸门任一不满足即 null（不挂载 → 工具对模型不存在）。
  // 闸门数据 lspLanguages 由主进程算好下发（与 trusted 同一条政策值通道）。
  // **闸门算一次给三处用**（本文件的挂载、queryOptions 的内置插件退役、下面提示注入）：
  // 各算各的会算出「两个都没有」或「两个都在」（见 lspGate.ts）。
  const lspGate: LspGate = {
    trusted: deps.trusted,
    lspLanguages: deps.lspLanguages,
    env: deps.processEnv,
  };
  const lspMcp = lspMcpRegistration({ cwd: deps.cwd, emit: deps.emit, ...lspGate });

  // Aide 指令加载：不依赖 SDK 文件系统 setting source，自己读 global + project
  // CLAUDE.md + 各附加工作区的 CLAUDE.md/记忆索引，追加到 preset system prompt。
  // settingSources 必须为空，否则 SDK 仍会去读 .claude/settings*.json，与 Aide
  // 独立设置体系冲突。
  // LSP 提示由这里按闸门算好再交进去（见 lspHint.ts）：闸门通过 = 内置通道已退役，
  // 那段讲内置工具的文本作废，改由 aide-lsp 的 server instructions 承担。
  const configDir = deps.processEnv.CLAUDE_CONFIG_DIR ?? "";
  const instructions = await loadAideInstructions({
    cwd: deps.cwd,
    configDir,
    trusted: deps.trusted,
    attached: deps.attachedDirs,
    builtinHint: await loadLspHint(configDir, lspGate),
  });
  // 内建 hooks 统一走 builtinHooks 注册表：policy 恒为 PreToolUse[0]
  // （权威前置层，用户 hook 不可越过），subagentModel/skillGuard
  // 按条件挂载。builtinHookManifest 经清单通道回传前端（Task 3 接线）。
  const { hooks: builtinHooks, manifest: builtinHookManifest } = buildBuiltinHooks({
    cwd: deps.cwd,
    env: deps.processEnv,
    session: deps.session,
    // grep 顺带作答与 aide-lsp 工具**同一道闸**（lspGate）：工具不在，附注里指向的工具也不存在。
    lsp: { mounted: lspToolsMounted(lspGate), emit: deps.emit },
    kbScopes: deps.kbScopes,
  });
  // 用户扩展（settings.json 的 mcpServers/hooks）：mcpServers 与内建项按
  // name 共存；hooks 内建在前、用户追加（内建 policy 恒为 PreToolUse[0]，不可越过）。
  // 侧栏应用的后端排在用户配置之后：名字（app-<id>）不会与用户自己起的撞上，撞了以应用为准。
  const appMcp = loadAppMcp(deps.cwd);
  const userMcp = { ...loadUserMcpServers(), ...appMcp.servers };
  // command 型条目在这里编译成 HookCallback（F4：SDK hooks 通道只认函数）；
  // cwd 注入 hook 子进程工作目录。
  const userHooks = loadUserHooks({ cwd: deps.cwd });

  // mcpServers 终装：内建(docs/knowledge/browser/lsp) + 用户配置 → automation 白名单过滤
  //（未预授权的连接器不挂载——其工具对模型根本不存在，第一层收口；policy hook
  // 白名单裁决是第二层）。
  const assembledMcp = assembleMcpServers(
    {
      ...(docsMcp ?? {}),
      ...(knowledgeMcp ?? {}),
      ...(memoryMcp ?? {}),
      ...(browserMcp ?? {}),
      ...(lspMcp ?? {}),
    },
    userMcp,
  );
  const mcpServers = deps.automationConfig
    ? filterMcpServers(assembledMcp, deps.automationConfig.mcpAllowlist)
    : assembledMcp;

  return {
    instructions,
    hooks: assembleHooks(builtinHooks, userHooks),
    hookManifest: builtinHookManifest,
    mcpServers,
    // automation 白名单把某个应用的 server 滤掉了，它的放行规则也跟着去掉
    appAllowRules: appMcp.allowRules.filter((rule) => Object.keys(mcpServers).some((name) => rule.startsWith(`mcp__${name}__`))),
  };
}

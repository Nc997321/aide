// 会话策略状态 + 权威 PreToolUse hook（session-worker.ts 拆分批 2 迁出，纯移动）。
//
// 职责（数据主人）：策略快照存储（revision 单调不回退）、会话级规则入库
// （去重 + 文件工具家族展开）、makeHook 产出权威 hook。
// 支线状态（btw/taskTools/automation/lightweight/cwd）**不归本类所有**——worker
// 注入活值 getter，hook 每次调用时读（支线状态会在 handleSend 里动态翻转）。
// automationVerdict 注入而非直接 import desktop/automation：policy/ 保持对
// desktop/ 零运行时依赖（仅类型），层次不破。
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { evaluatePolicy } from "./evaluate.js";
import type { PermissionPolicySnapshot, PermissionRule } from "./types.js";
import type { PermissionRuleDraft } from "../types.js";
import { policyDenyMessage } from "../permissions.js";
import type { AutomationConfig, AutomationVerdict } from "../../desktop/automation.js";

/** 会话级规则的文件工具家族：Edit/Write/MultiEdit 共享同一份 file_path 精确文件规则
 *  （同一文件是同一操作对象，工具差异只是写入方式——Write 新文件放行后，Edit 同文件
 *  不再询问）。NotebookEdit 的输入字段是 notebook_path，不在家族内。 */
const FILE_FAMILY_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

/** hook 调用时读取的支线状态快照（worker 注入活值 getter）。 */
export interface PolicyBranchState {
  btwMode: boolean;
  lightweightMode: boolean;
  /** btw 任务支线白名单（非空 = 任务支线，白名单外 deny）。 */
  taskTools: string[] | undefined;
  automationConfig: AutomationConfig | undefined;
  /** 会话 cwd（hook 构造参数缺省时的兜底）。 */
  cwd: string | undefined;
}

export interface SessionPolicyDeps {
  branchState: () => PolicyBranchState;
  /** 自动化运行三值裁决（desktop/automation.ts 的 automationHookVerdict）。 */
  automationVerdict: (toolName: string, toolInput: unknown, cfg: AutomationConfig) => AutomationVerdict;
}

export class SessionPolicy {
  /** Aide 权限策略快照。revision 单调递增，落后于当前的快照被忽略；
   *  空策略 → 无匹配规则 → hook 返回 {}（回退原权限模式）。 */
  private snapshot: PermissionPolicySnapshot = { revision: 0, rules: [] };

  // ---- 会话级权限规则（内存态，worker 销毁即消失） ----
  // 「允许」文件工具时前端推导的精确文件规则落在这里：hook 评估前合并进
  // 快照（session 作用域天然最高优先级），同文件后续调用自动放行。不持久化、
  // 不进 Rust 快照、不随会话 resume 存活——会话停止即清空。
  private sessionRules: PermissionRule[] = [];
  private sessionRuleOrder = 0;

  constructor(private readonly deps: SessionPolicyDeps) {}

  /** 会话级规则条数（测试缝 _testSessionRuleCount 委托用）。 */
  get ruleCount(): number {
    return this.sessionRules.length;
  }

  /** Apply a fresh permission-policy snapshot. Snapshots with `revision`
   *  strictly less than the current one are ignored (no rollback). The first
   *  `send` carries the initial snapshot; `update_permission_policy` pushes
   *  subsequent updates without restarting the worker. */
  applySnapshot(snapshot: PermissionPolicySnapshot): void {
    if (!snapshot || snapshot.revision < this.snapshot.revision) return;
    this.snapshot = snapshot;
  }

  /** 把前端推导的会话级规则草稿入库（随 permission_response 放行原子到达）。
   *  只收 allow；按 (tool, matcher) 去重——同一文件被再次允许时不堆积重复规则。
   *  规则 id 用随机 UUID（无持久化、无跨 worker 语义，无需可读性）。 */
  addSessionRules(drafts: PermissionRuleDraft[]): void {
    for (const d of drafts) {
      if (d.effect !== "allow") continue;
      // 文件工具家族展开：一条精确文件规则 → 家族内每个工具各一条同路径规则。
      // 这样 Write 放行后 Edit/MultiEdit 同文件不再询问，反过来也一样。
      const tools: readonly string[] =
        d.matcher.kind === "path" && d.matcher.file !== undefined &&
        (FILE_FAMILY_TOOLS as readonly string[]).includes(d.tool)
          ? FILE_FAMILY_TOOLS
          : [d.tool];
      for (const tool of tools) {
        const dup = this.sessionRules.some(
          (r) => r.tool === tool && JSON.stringify(r.matcher) === JSON.stringify(d.matcher),
        );
        if (dup) continue;
        this.sessionRules.push({
          id: `session-${randomUUID()}`,
          scope: "session",
          order: this.sessionRuleOrder++,
          effect: d.effect,
          tool,
          matcher: d.matcher,
          source: { label: "session", readOnly: true },
        });
      }
    }
  }

  /** Authoritative PreToolUse hook: evaluates the Aide policy snapshot before
   *  any other hook (image guard, skill guard, etc.) runs. `allow`/`deny` are
   *  returned directly; `ask` hands the decision back to the CLI so it routes
   *  through `canUseTool` (Aide's confirmation flow — see the case body);
   *  no-match returns `{}` (no opinion) so the CLI falls back to its normal
   *  permission flow. Applies to every tool including Read.
   *  `allowDangerouslySkipPermissions` does NOT bypass this hook — the hook is
   *  registered unconditionally on `matcher: ".*"`.
   *  NB: the no-match branch must NOT return `permissionDecision:"defer"` — the
   *  CLI doesn't honor it and breaks tool execution ("Tool result missing due
   *  to internal error"). `{}` is the correct "defer to normal flow" response. */
  makeHook(cwd: string | undefined): HookCallback {
    return async (input: HookInput) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolName = input.tool_name;
      const toolInput = input.tool_input;
      if (!toolName) return {};
      const state = this.deps.branchState();
      // 轻量 btw 是纯问答:行为层禁掉一切工具(matcher ".*" 覆盖 MCP 工具)。
      // 在请求前缀之外实现——工具列表保持与主会话一致,prompt cache 才能命中;
      // deny 即时返回,也根治了 2026-08-02「模型调 MCP 工具卡住」(不再 tools:[]
      // 之后模型可能尝试调用,但每次都吃到明确 deny,立刻转文字回答)。
      if (state.lightweightMode) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason:
              "轻量支线为纯问答,工具已禁用,请直接根据上下文回答",
          },
        };
      }
      // 自动化运行：三值裁决。MCP 工具按连接器白名单（与预设无关）；内建工具
      // full 预设 allow、auto 预设返回 {} 不表态——交还 CLI auto 模式（安全自动
      // 放行，高危询问 → canUseTool 自动化分支兜底 deny，无人值守没人应答弹窗）。
      if (state.automationConfig) {
        const verdict = this.deps.automationVerdict(toolName, toolInput, state.automationConfig);
        if (verdict === "defer") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: verdict === "allow" ? ("allow" as const) : ("deny" as const),
            permissionDecisionReason:
              verdict === "allow"
                ? "自动化任务预授权"
                : `连接器未预授权（可用: ${state.automationConfig.mcpAllowlist.join(", ") || "无"}）`,
          },
        };
      }
      // 会话级规则（「允许」文件工具时前端推导）合并进快照再评估——session 作用域
      // 在 SCOPE_PRIORITY 里最高，天然压过持久化规则；无会话规则时零拷贝走原快照。
      const snapshot =
        this.sessionRules.length > 0
          ? { ...this.snapshot, rules: [...this.sessionRules, ...this.snapshot.rules] }
          : this.snapshot;
      const decision = await evaluatePolicy(snapshot, {
        tool: toolName,
        input: (toolInput ?? {}) as Record<string, unknown>,
        cwd: cwd ?? state.cwd,
      });
      switch (decision.disposition) {
        case "allow":
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "allow" as const,
              permissionDecisionReason: decision.reason,
            },
          };
        case "deny":
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              // 策略拒绝的理由同样会被 CLI 原样塞进 tool_result 正文（SDK 通道
              // 不做任何包装），必须自带官方外框（hRe），否则弱模型把理由读成
              // 工具输出——与「写入2」事故同根。
              permissionDecisionReason: policyDenyMessage(decision.reason),
            },
          };
        case "ask": {
          // btw 支线没有权限弹窗通路(permission_request 会被前端 btw 路由吞掉,
          // 落到 canUseTool 的请求干等应答 → 永久挂起)——ask 一律当 deny 处理。
          if (state.btwMode) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "btw 支线无人应答权限请求(需确认的操作一律拒绝)",
              },
            };
          }
          // 策略要求人工确认 → 交还 CLI 的第一类通道（canUseTool），不在 hook 里
          // 自己弹窗等结果。这条返回值的下游链路（claude.exe，2026-09-08 运行时
          // 实证）：permissionDecision:"ask" → hookPermissionResult{behavior:"ask"}
          // → xRn 把它作为预置决策传给完整权限流水线（绕过规则检查，因此
          // bypassPermissions 不会短路）→ case "ask" → 控制协议问 SDK 宿主 →
          // canUseTool → 弹窗。注意：SDK 通道的 deny message 是**原样**进
          // tool_result 的（带官方模板的 cancelAndAbort 只在终端交互 UI 生效），
          // 因此外框由 permissions.ts 的 userDenyMessage 自行拼装。
          // 旧实现在这里 await 用户应答后返回 deny + 用户原话：CLI 会把原话
          // 裸塞进 tool_result，模型读成工具输出（「写入2」被当成 Write 的
          // 返回内容，2026-09-08 事故）。语义位置错了——所以是换通道 +
          // 宿主自带外框，不是改措辞。
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "ask" as const,
            },
          };
        }
        default:
          // btw 任务支线(git-commit):白名单外的命令必须在这里 deny——defer 会在
          // allowDangerouslySkipPermissions 下被 CLI 静默放行,canUseTool 根本不会被
          // 调用(2026-08-09 运行时任真:ipconfig 在 btw 任务里直接执行,策略日志
          // disposition=defer 之后没有任何 canUseTool 回调)。不加这道 = 支线开 bypass。
          // 问答支线(full btw)保持旧行为:defer → {} → CLI 放行(fork 主会话的
          // 既有语义,政策快照本来也不推给 btw)。
          if (state.taskTools) {
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason:
                  "btw 任务支线仅允许白名单内的命令(git 只读 + add/commit)",
              },
            };
          }
          // No Aide policy rule matched → return {} (no opinion) so the CLI proceeds
          // with its normal permission flow (here allowDangerouslySkipPermissions
          // auto-allows). Do NOT return permissionDecision:"defer": the claude.exe CLI
          // does NOT honor "defer" from a PreToolUse hook and silently breaks tool
          // execution — every tool_use comes back as "Tool result missing due to
          // internal error" (repro confirmed 2026-07-29 vs control). {} leaves the
          // decision to canUseTool/permissionMode, which is exactly the defer intent.
          return {};
      }
    };
  }
}

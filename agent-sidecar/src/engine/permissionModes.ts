// 权限模式清单 + 会话模式账本（session-worker.ts 拆分批 2 迁出，纯移动）。
// 清单是进程级常量（所有会话共享）；账本 per-session，SessionWorker 持有实例。
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, PermissionModeOption } from "./types.js";

// 顺序即默认：`auto` 居首 = 新会话的默认权限模式（前端「清单首项即 provider 默认
// 模式」，见 ChatInputBox.vue）。模式 id 对齐 CLI 的 --permission-mode choices
// （CLI 已把 `default` 更名为 `manual`，两者 CLI 都接受，aide 统一用 `manual`）。
// 不提供 `acceptEdits`——编辑工具的「一劳永逸」由 auto 承担。
export const PERMISSION_MODES: PermissionModeOption[] = [
  { value: "auto", displayName: "自动模式" },
  { value: "manual", displayName: "手动模式" },
  { value: "plan", displayName: "计划模式" },
  { value: "bypassPermissions", displayName: "最高权限" },
];

export const EXTRA_MODE_LABELS: Record<string, string> = {
  dontAsk: "本次会话不再询问",
};

/** 「进入自动模式」按钮连带放行的工具集：切到 auto 后编辑工具不再逐条询问，
 *  切模式时队列里还挂着的同类请求一并放行——否则一轮并行 3 个 Edit，用户点完
 *  「进入自动模式」还得把剩下 2 条逐个点掉，等于没切。 */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** 切到这些模式后编辑工具不再逐条询问（即「进入自动模式」按钮在弹窗里被藏起的
 *  模式）→ 切换前已挂起的编辑请求连带放行。否则旧弹窗留在屏幕上，而前端
 *  currentMode 已是新模式、按钮又被藏起，用户只能逐条点掉。 */
export const EDIT_AUTO_MODE_NAMES: ReadonlySet<string> = new Set(["auto", "bypassPermissions"]);

/** 模式切换所需的最小 Query 面（SDK Query 的结构子集，避免拖重型类型）。 */
export interface PermissionModeSettable {
  setPermissionMode(mode: PermissionMode): Promise<unknown>;
}

/** 权限模式账本：query 未起时只落本地账；在跑走 setPermissionMode，CLI 坐实
 *  才更新账面，失败回滚广播旧值 + error（对齐 effortSwitch 失败回执模式）。 */
export class PermissionModeController {
  /** 当前模式账面（startLoop spawn 时读它进 options.permissionMode）。 */
  current = "auto";

  constructor(private readonly emit: (e: ChatEvent) => void) {}

  emitModes(error?: string): void {
    const modes = PERMISSION_MODES.some((m) => m.value === this.current)
      ? PERMISSION_MODES
      : [
          ...PERMISSION_MODES,
          {
            value: this.current,
            displayName: EXTRA_MODE_LABELS[this.current] ?? this.current,
          },
        ];
    this.emit({
      type: "permission_modes_available",
      modes,
      current: this.current,
      ...(error !== undefined ? { error } : {}),
    });
  }

  apply(mode: string, q: PermissionModeSettable | null): void {
    if (!PERMISSION_MODES.some((m) => m.value === mode) && !(mode in EXTRA_MODE_LABELS)) return;
    if (mode === this.current) return;
    if (q) {
      // mode 已在上方按 PERMISSION_MODES/EXTRA_MODE_LABELS 校验过，断言为 SDK
      // 字面量联合（含 auto/dontAsk 等前端可选项）只表达"校验后必然是合法值"。
      q.setPermissionMode(mode as PermissionMode)
        .then(() => {
          this.current = mode;
          this.emitModes();
        })
        .catch((e: unknown) => {
          // setPermissionMode 失败（SDK/CLI 拒绝切换）：模式未生效——回滚广播旧值
          // 并附 error 让前端提示（对齐 effortSwitch.ts:62 失败回执模式）。
          this.emitModes(`权限模式切换失败：${String((e as Error)?.message ?? e)}`);
        });
    } else {
      this.current = mode;
      this.emitModes();
    }
  }
}

/** permission_response 放行后的模式迁移（原 worker handleCommand 三分支决议收拢，
 *  拆分批 3 纯移动）。返回 null = 无迁移动作。 */
export interface ModeTransition {
  mode: string;
  /** 切换后连带放行挂起的编辑类权限请求（「进入自动模式」语义）。 */
  approveEdits: boolean;
}

export function resolveApprovedTransition(
  toolName: string | undefined,
  nextMode: string | undefined,
): ModeTransition | null {
  if (toolName === "ExitPlanMode") {
    // 批准计划后落到哪个模式由 nextMode 钉死（「手动确认编辑」传 manual、
    // 「使用 Auto 模式」传 auto）；此处回落只兜底未带 nextMode 的调用方
    // （如尚未实现三选一的远端），取与清单首项一致的 auto。
    return { mode: nextMode || "auto", approveEdits: false };
  }
  if (toolName === "EnterPlanMode") {
    // 模型主动进入计划模式（非用户预选）：对齐本地账本并广播，让前端下拉同步
    return { mode: "plan", approveEdits: false };
  }
  if (nextMode) {
    // 「进入自动模式」：编辑工具的权限弹窗提供的一劳永逸选项——放行本次 +
    // 切到 auto，之后编辑不再逐条确认（aide 不提供 acceptEdits，编辑的
    // 「不再逐条问」归 auto 承担）。切完把还挂着的其它编辑请求连带放行，
    // 别让用户逐条点。
    return { mode: nextMode, approveEdits: EDIT_AUTO_MODE_NAMES.has(nextMode) };
  }
  return null;
}

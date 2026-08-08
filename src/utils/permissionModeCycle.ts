// Shift+Tab 权限模式循环——纯函数便于测试。对齐 CLI：键盘循环不含
// bypassPermissions（连击误入「跳过所有确认」太危险，CLI 的 Shift+Tab
// 循环同样不放 bypass——那个只能显式点下拉选）。

import type { PermissionModeOption } from "@/types/chat";

/** 键盘循环永不停靠的模式。 */
const KEYBOARD_SKIP: ReadonlySet<string> = new Set(["bypassPermissions"]);

/** Shift+Tab 的下一落点：序列 = `modes` 顺序剔除键盘禁停项。
 *  `current` 不在序列（bypass / provider 扩展项）→ 序列首项；
 *  序列不足两项 → null（无可切，调用方不拦截按键）。 */
export function nextPermissionMode(
  current: string,
  modes: PermissionModeOption[],
): string | null {
  const cycle = modes.map((m) => m.value).filter((v) => !KEYBOARD_SKIP.has(v));
  if (cycle.length < 2) return null;
  const idx = cycle.indexOf(current);
  return idx === -1 ? cycle[0] : cycle[(idx + 1) % cycle.length];
}

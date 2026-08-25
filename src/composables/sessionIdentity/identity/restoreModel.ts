import type { ModelOption } from "@/types/chat";
import { isModelInList, pickModelValue } from "@/utils/modelSelect";

/**
 * L2 恢复通道：resolve 慢/快路径里"从盘上 remembered 选定 restored 模型"的唯一入口。
 *
 * 语义钉死（modelSelect.test.ts:64-73 回归约束）：remembered 在当前列表 → **直选**，
 * 不走 pickModelValue——后者 existing 优先级压过 remembered，会让"恢复通道"被
 * 当前 selectedModel（existing）盖住。不在列表 → applyDefault 语义（pickModelValue
 * 不采信 sdkCurrent，退 providerDefault/首项）。
 */
export function restoreModel(models: ModelOption[], remembered: string | null): string {
  if (remembered && isModelInList(models, remembered)) return remembered;
  return pickModelValue(models, "", "", "");
}
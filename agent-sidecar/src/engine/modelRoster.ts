// 可选模型名册：SDK init 回报的模型列表 + 真名/别名双命名空间账本
// （session-worker.ts 拆分批 2 迁出，纯移动）。currentModel（当前账面模型）
// 不归本类——它是 worker 的协议状态（set_model/env 多路写入），这里只管
// 「列表 + 两个命名空间的互译」。
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { filterSelectableModels } from "./mapper.js";
import type { ModelOption } from "./types.js";

/** 名册用得上的 SDK 字段（ModelInfo 的结构子集）——只声明会被读的三个，
 *  测试桩与 SDK 多出来的字段都不受牵连。 */
type SdkModelRow = Pick<ModelInfo, "value" | "displayName" | "resolvedModel">;

/** 真名命名空间下的模型 id：SDK 给了 resolvedModel 就用它，否则 value 本身就是
 *  真名（第三方 provider 的 SDK 回报不带 resolvedModel）。 */
function realModelOf(row: SdkModelRow): string {
  return row.resolvedModel ?? row.value;
}

/** SDK 条目 → 下拉选项（真名命名空间）。 */
function toModelOption(row: SdkModelRow): ModelOption {
  return { value: realModelOf(row), displayName: row.displayName };
}

/** 按真名去重，保留首条。CLI 的列表是按**槽位**给的（default / opus / sonnet /
 *  haiku），多个槽位映射到同一个模型时（provider 的 opus/sonnet/haiku 三个映射
 *  槽都填同一个 id）就回报多行同真名条目；而 value 是下拉的身份——ThemedSelect
 *  按 `opt.value === modelValue` 逐行判选中、v-for 按 value 做 key，重复 value
 *  会让多行同时打勾并触发 Vue 重复 key。首条胜出：保持 CLI 回报顺序，结果确定。 */
function dedupeByRealModel(rows: SdkModelRow[]): SdkModelRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const real = realModelOf(row);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** 真名 → SDK 别名（唯一的别名用法：把 model 交回 SDK 时反查）。只收 SDK 真给了
 *  别名的行；在**去重后**的清单上建，同真名的多行不再互相覆盖。 */
function buildAliasMap(rows: SdkModelRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.resolvedModel) map.set(row.resolvedModel, row.value);
  }
  return map;
}

/** 读 SDK init 回报的模型列表；SDK 版本不支持（没有 initialize 控制请求）→ null。 */
async function readInitModels(q: Query): Promise<ModelInfo[] | null> {
  try {
    return (await q.initializationResult()).models;
  } catch {
    // SDK 版本不支持时静默跳过（调用方按 null 跳过，不视为错误——原语义）
    return null;
  }
}

export class ModelRoster {
  /** 可选模型列表（真名命名空间）——models_available 事件与切换守卫的展示反查读它。 */
  models: ModelOption[] = [];
  /** 列表里的真实模型 id（models 的 value 集合），用于把 SDK 回报的 wire id
   *  归一成列表里的那一个（wire id 可能带变体后缀）。 */
  private realModels: string[] = [];
  /** 真名 → SDK 别名。**唯一**保留别名的用途：把 model 下发给 SDK 时反查回去。 */
  private aliasByRealModel = new Map<string, string>();
  /** 最近一次坐实的 assistant wire model（重复播报防抖）。 */
  lastConcreteModel = "";

  /** SDK init 回报 → 采纳列表并重建双命名空间账本；返回 models。
   *  失败（SDK 版本不支持）返回 null，调用方静默跳过。 */
  async adoptFromInit(q: Query): Promise<ModelOption[] | null> {
    const sdkModels = await readInitModels(q);
    if (sdkModels === null) return null;
    this.adopt(dedupeByRealModel(filterSelectableModels(sdkModels)));
    return this.models;
  }

  /** 用一份已去重的 SDK 清单重建三本账（下拉列表 / 真名集合 / 真名→别名）。
   *  三者同源重建 —— 不存「列表里有的、翻译不出来」这类漂移。
   *
   *  下拉与落盘一律用**真实模型 id**（SDK 的 resolvedModel），不用 SDK 的 value
   *  别名：别名是 Claude 词汇（sonnet/opus/haiku），第三方 provider 下会被用户
   *  看见、会被写进会话元数据，还会在身份漂移判定时与真名互相误判。别名只保留
   *  在「把 model 交给 SDK」这一环——经 toSdkModel 翻译回去。 */
  private adopt(selectable: SdkModelRow[]): void {
    this.models = selectable.map(toModelOption);
    this.realModels = this.models.map((m) => m.value);
    this.aliasByRealModel = buildAliasMap(selectable);
  }

  /** 真名 → SDK 别名。**唯一**需要别名的地方：把 model 交给 SDK（spawn options、
   *  setModel）时翻译回去；SDK 的 model 入参认的是它自己那份 value。 */
  toSdkModel(realModel: string): string {
    return this.aliasByRealModel.get(realModel) ?? realModel;
  }

  resolveDropdownValue(concreteModel: string): string {
    // 列表里已有完全一致的真名 → 直接用（wire id 与列表同值，最常见）
    if (this.realModels.includes(concreteModel)) return concreteModel;
    // 否则按前缀归一：wire id 常带变体后缀（glm-5.3-flash-cloud）
    const hit = this.realModels.find(
      (r) => concreteModel === r || concreteModel.startsWith(`${r}-`),
    );
    return hit ?? concreteModel;
  }
}

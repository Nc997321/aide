// 可选模型名册：SDK init 回报的模型列表 + 真名/别名双命名空间账本
// （session-worker.ts 拆分批 2 迁出，纯移动）。currentModel（当前账面模型）
// 不归本类——它是 worker 的协议状态（set_model/env 多路写入），这里只管
// 「列表 + 两个命名空间的互译」。
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { filterSelectableModels } from "./mapper.js";
import type { ModelOption } from "./types.js";

/** 名册用得上的 SDK 字段（ModelInfo 的结构子集）——只声明会被读的几个，
 *  测试桩与 SDK 多出来的字段都不受牵连。description 桩里常缺，按可选读。 */
type SdkModelRow = Pick<ModelInfo, "value" | "displayName" | "resolvedModel"> & { description?: string };

/** 真名命名空间下的模型 id：SDK 给了 resolvedModel 就用它，否则 value 本身就是
 *  真名（第三方 provider 的 SDK 回报不带 resolvedModel）。 */
function realModelOf(row: SdkModelRow): string {
  return row.resolvedModel ?? row.value;
}

/** description 的首段若是「带版本的模型名」就返回它，否则 null。CLI 0.3.292 把版本放在
 *  这里（displayName "Opus" + description "Opus 5.5 · Best for…"）；0.3.293 起版本直接
 *  写进 displayName、description 只剩一句介绍——所以只认「至多三个词、带数字、无括号」
 *  的首段，一句话形态的介绍（哪怕碰巧带数字）不算。 */
function versionedHead(row: SdkModelRow): string | null {
  const head = (row.description ?? "").split(" · ")[0].trim();
  return /\d/.test(head) && /^[\w.:-]+( [\w.:-]+){0,2}$/.test(head) ? head : null;
}

/** 默认槽实际指向的模型名：官方是 description 首段（"Opus 5.5 · …"），配了模型映射的
 *  供应商是 "Use the default model (currently glm-5.3:cloud[1m])"。认不出 → null。 */
function defaultSlotTarget(row: SdkModelRow): string | null {
  return versionedHead(row) ?? /\(currently (.+)\)\s*$/.exec(row.description ?? "")?.[1] ?? null;
}

/** 下拉显示名：让用户看得出是哪个版本（"Opus" 看不出是 5.0 还是 5.5）。
 *  - 默认槽（"Default (recommended)"）→ 它实际指向的模型名 +「（默认）」；
 *  - displayName 自带版本 → 原样；
 *  - description 首段是同名带版本形态 → 用首段；
 *  - 都不是 → displayName 原样（第三方供应商走这里：显示名本就是真名）。 */
export function versionedLabel(row: SdkModelRow): string {
  if (row.value === "default") {
    const target = defaultSlotTarget(row);
    return target ? `${target}（默认）` : row.displayName;
  }
  if (/\d/.test(row.displayName)) return row.displayName;
  const head = versionedHead(row);
  return head && head.toLowerCase().startsWith(row.displayName.toLowerCase()) ? head : row.displayName;
}

/** 「钉死型号」行：SDK 的 value 就是完整模型 id 本身（不是 default/opus/sonnet 这类槽位）。
 *  CLI 0.3.293 起在槽位之外还列出一串旧型号（Opus 5 / 4.8 / 4.7…），照单全收下拉会从
 *  四五项涨到十几项；配了模型映射的第三方供应商下还会混进一行用不了的官方 Fable。
 *  下拉只留槽位行 + 当前会话正在用的那个型号（resume 的老会话可能正用着旧型号，
 *  不能让它从自己的下拉里消失）。SDK 没给 resolvedModel 的行无从判断，一律保留。 */
function isPinnedModelRow(row: SdkModelRow): boolean {
  return row.resolvedModel !== undefined && row.resolvedModel === row.value;
}

function offeredRows(rows: SdkModelRow[], currentModel: string): SdkModelRow[] {
  return rows.filter((row) => !isPinnedModelRow(row) || realModelOf(row) === currentModel);
}

/** SDK 条目 → 下拉选项（真名命名空间）。 */
function toModelOption(row: SdkModelRow): ModelOption {
  return { value: realModelOf(row), displayName: versionedLabel(row) };
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
  /** SDK 原始清单（**SDK 自己的 value**、未去重、显示名已带版本）。宿主拿它给
   *  「还没起会话时的静态别名清单」贴版本标签——去重后的 models 不够用：默认槽与
   *  opus 同真名时 opus 那一行被去掉，别名 opus 就查不到自己的版本了。 */
  sdkRoster: ModelOption[] = [];
  /** 最近一次坐实的 assistant wire model（重复播报防抖）。 */
  lastConcreteModel = "";

  /** SDK init 回报 → 采纳列表并重建双命名空间账本；返回 models。
   *  currentModel（真名）：钉死型号行里只有它留下，见 isPinnedModelRow。
   *  失败（SDK 版本不支持）返回 null，调用方静默跳过。 */
  async adoptFromInit(q: Query, currentModel: string): Promise<ModelOption[] | null> {
    const sdkModels = await readInitModels(q);
    if (sdkModels === null) return null;
    const selectable = offeredRows(filterSelectableModels<SdkModelRow>(sdkModels), currentModel);
    this.sdkRoster = selectable.map((row) => ({ value: row.value, displayName: versionedLabel(row) }));
    this.adopt(dedupeByRealModel(selectable));
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
    const hit = [...this.realModels].sort((a, b) => b.length - a.length).find(
      (r) => concreteModel === r || concreteModel.startsWith(`${r}-`),
    );
    if (hit) return hit;
    // 网关的 wire 型号可能把数字版本的点改成横杠，并附加构建日期。
    // 只统一数字之间的分隔符；同等长度多候选不猜，交给实际型号兜底。
    const versionKey = (value: string): string => value.replace(/(\d)\.(?=\d)/g, "$1-");
    const wire = versionKey(concreteModel);
    const candidates = this.realModels.filter((r) => {
      const key = versionKey(r);
      return wire === key || wire.startsWith(`${key}-`);
    }).sort((a, b) => b.length - a.length);
    if (candidates.length && (candidates.length === 1 || candidates[0].length > candidates[1].length)) {
      return candidates[0];
    }
    return concreteModel;
  }

  /** 主线程已实际回报的型号必须可见；未知型号不能让 UI 回落列表首项。 */
  adoptConcreteModel(concreteModel: string): string {
    const value = this.resolveDropdownValue(concreteModel);
    if (this.models.length > 0 && !this.realModels.includes(value)) {
      this.models = [...this.models, { value, displayName: value }];
      this.realModels = [...this.realModels, value];
    }
    return value;
  }
}

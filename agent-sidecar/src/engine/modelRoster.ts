// 可选模型名册：SDK init 回报的模型列表 + 真名/别名双命名空间账本
// （session-worker.ts 拆分批 2 迁出，纯移动）。currentModel（当前账面模型）
// 不归本类——它是 worker 的协议状态（set_model/env 多路写入），这里只管
// 「列表 + 两个命名空间的互译」。
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { filterSelectableModels } from "./mapper.js";
import type { ModelOption } from "./types.js";

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
    try {
      const init = await q.initializationResult();
      const selectable = filterSelectableModels(init.models);
      // 下拉与落盘一律用**真实模型 id**（SDK 的 resolvedModel），不用 SDK 的 value
      // 别名：别名是 Claude 词汇（sonnet/opus/haiku），第三方 provider 下会被用户
      // 看见、会被写进会话元数据，还会在身份漂移判定时与真名互相误判。别名只保留
      // 在「把 model 交给 SDK」这一环——经 toSdkModel 翻译回去。
      this.models = selectable.map((m) => ({
        value: (m.resolvedModel as string | undefined) ?? m.value,
        displayName: m.displayName,
      }));
      this.realModels = this.models.map((m) => m.value);
      this.aliasByRealModel = new Map(
        selectable.filter((m) => m.resolvedModel).map((m) => [m.resolvedModel as string, m.value]),
      );
      return this.models;
    } catch {
      // SDK 版本不支持时静默跳过
      return null;
    }
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

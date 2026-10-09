// Query 遥测上报：上下文窗口用量 + 订阅额度/速率（session-worker.ts 拆分批 2
// 迁出，纯移动）。都是「拿不到就静默跳过」的旁路观测，失败绝不打断会话。
import type { Query, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { buildRateLimitEvent } from "./mapper.js";
import type { ChatEvent, ContextUsageBreakdown } from "./types.js";

export async function emitContextUsage(q: Query, emit: (e: ChatEvent) => void): Promise<void> {
  try {
    const usage = await q.getContextUsage();
    // DTO 拍平：categories 只留 name/tokens/isDeferred——SDK 的 color 是 CLI 品牌
    // 色，前端按主题 token 上色，不透传（provider-agnostic，见 types.ts 注释）。
    emit({
      type: "context_usage",
      total_tokens: usage.totalTokens,
      max_tokens: usage.maxTokens,
      percentage: usage.percentage,
      raw_max_tokens: usage.rawMaxTokens,
      categories: usage.categories?.map((c) => ({
        name: c.name,
        tokens: c.tokens,
        isDeferred: c.isDeferred,
      })),
      breakdown: toBreakdown(usage),
    });
  } catch {
    // 拿不到就跳过（旧 CLI/SDK 版本不支持时静默，前端按缺省降级）
  }
}

/** 空数组与 undefined 归一——「provider 没给这组」与「给了空数组」对前端是同一件
 *  事：不渲染该 section，而不是渲染一个空壳。 */
function nonEmpty<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  return items && items.length > 0 ? items : undefined;
}

/**
 * SDK 的明细分组 → wire breakdown（占用来源切面，见 types.ts 的 context_usage 说明）。
 *
 * **裁剪决策的唯一所在**——types.ts 只列字段名，理由全在这里；新增 SDK 字段必须来
 * 这里表态（queryTelemetry.test.ts 的 fixture 覆盖 SDK 全部顶层字段，会强制这件事）：
 * - `color` / `gridRows`  CLI 品牌色与 CLI 内部布局数组；色由前端主题 token 定，
 *                         分段条布局由前端自算
 * - `categories[].kind`   SDK 0.3.292 起的分类标签（buffer/used/free/deferred）。前端
 *                         「延迟」视觉只认 isDeferred，buffer/free 两类目前不区分渲染；
 *                         要做「压缩缓冲 / 剩余空间」分色时再透传，别按 name 字符串猜
 * - `model`               已有 model_committed / models_available 通路
 * - `slashCommands`       聚合标量（命令条数 + 总占用），不是"某条命令占了多少"
 * - `skills`              技能面占用（标量 + skillFrontmatter[]）。本期只做工具面，
 *                         明细留待「技能按需加载」那一轮一起做
 * - `messageBreakdown`    消息维度统计（tool/user/assistant 分类），不是窗口固定成本
 * - `apiUsage`            单次 API 调用的用量回执，与窗口占用无关
 * - `autoCompact*`        压缩策略参数，不是占用
 * - `isLoaded`            SDK 全包只在 mcpTools/deferredBuiltinTools 两处出现且零注释，
 *                         语义未证实；而"延迟"视觉已由 categories[].isDeferred 承担，
 *                         同一面板再引入一个含义不同的弱化布尔只会混淆。留待 tool
 *                         search 落地时用真实会话探针验证
 *
 * 六组全空（旧 CLI / provider 未提供明细）→ 返回 undefined，wire 上不出现该字段。
 */
function toBreakdown(u: SDKControlGetContextUsageResponse): ContextUsageBreakdown | undefined {
  const breakdown: ContextUsageBreakdown = {
    mcpTools: nonEmpty(u.mcpTools)?.map((t) => ({
      name: t.name,
      serverName: t.serverName,
      tokens: t.tokens,
    })),
    systemTools: nonEmpty(u.systemTools)?.map((t) => ({ name: t.name, tokens: t.tokens })),
    deferredBuiltinTools: nonEmpty(u.deferredBuiltinTools)?.map((t) => ({
      name: t.name,
      tokens: t.tokens,
    })),
    systemPromptSections: nonEmpty(u.systemPromptSections)?.map((t) => ({
      name: t.name,
      tokens: t.tokens,
    })),
    memoryFiles: nonEmpty(u.memoryFiles)?.map((f) => ({
      path: f.path,
      type: f.type,
      tokens: f.tokens,
    })),
    agents: nonEmpty(u.agents)?.map((a) => ({
      agentType: a.agentType,
      source: a.source,
      tokens: a.tokens,
    })),
  };
  return Object.values(breakdown).some((group) => group !== undefined) ? breakdown : undefined;
}

/** 订阅额度/速率上报：15s 节流（result 到达频率远高于额度变化频率）。 */
export class RateLimitReporter {
  private lastAt = 0;

  async report(q: Query, emit: (e: ChatEvent) => void): Promise<void> {
    if (Date.now() - this.lastAt < 15_000) return;
    try {
      // 方法在类型上恒存在，但旧 CLI 二进制可能没实现——运行时守卫兜底。
      if (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return;
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      this.lastAt = Date.now();
      emit(buildRateLimitEvent(usage));
    } catch {
      // 实验性/不支持：跳过
    }
  }
}

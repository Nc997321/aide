// Query 遥测上报：上下文窗口用量 + 订阅额度/速率（session-worker.ts 拆分批 2
// 迁出，纯移动）。都是「拿不到就静默跳过」的旁路观测，失败绝不打断会话。
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { buildRateLimitEvent } from "./mapper.js";
import type { ChatEvent } from "./types.js";

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
    });
  } catch {
    // 拿不到就跳过（旧 CLI/SDK 版本不支持时静默，前端按缺省降级）
  }
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

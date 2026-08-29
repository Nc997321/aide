import { ref } from "vue";
import type { RateLimitInfo, TurnUsage } from "../types/chat";

// ---- 健康快照 ----

export interface HealthSnapshot {
  sessions: { active: number; idle: number; stalled: number; total: number };
  processes: { claudeExeCount: number };
  timestamp: number;
}

const runtimeHealth = ref<HealthSnapshot | null>(null);

// ---- 累计费用 ----

const cumulativeCost = ref(0);
const cumulativeInputTokens = ref(0);
const cumulativeOutputTokens = ref(0);
// 累计用量里"来自触发了子代理的轮次"的子集——与 cumulativeXxx 配对，前端据此拆成
// "含子代理轮次" vs "纯主会话轮次"两栏。SDK 按模型聚合、不按代理拆分，所以这里只能
// 在轮级归因（usage.subagentTurn 标记本轮是否派了子代理），不声称知道子代理内部精确 token。
const subagentTurnInputTokens = ref(0);
const subagentTurnOutputTokens = ref(0);
const subagentTurnCost = ref(0);
// 按模型分桶的累计用量——多模型会话（如子代理用了别的模型）能看到每个模型各烧多少。
// key 是 wire model id（provider 专属字符串，前端只展示不解释）。
const byModelCumulative = ref<Record<string, TurnUsage>>({});
// 最近一次子代理嵌套深度警告（Step 3 runtime 在深度超阈值时发 subagent_nesting_warning）。
const nestingWarning = ref<{ depth: number; threshold: number } | null>(null);

// ---- 速率限制 ----

const rateLimit = ref<RateLimitInfo | null>(null);

// ---- chat-event 处理器 ----

let listenerStarted = false;

export function useDiagnosticsDashboard() {
  if (!listenerStarted) {
    listenerStarted = true;
    // 这里不直接 listen——调用方在 App.vue 或 SettingsPanel 里注册
  }

  /** health 事件负载 = HealthSnapshot 本体（sidecar 固定形状，边界处收窄后传入）。 */
  function handleHealthEvent(event: HealthSnapshot) {
    runtimeHealth.value = {
      sessions: event.sessions,
      processes: event.processes,
      timestamp: event.timestamp,
    };
  }

  function accumulateUsage(usage: TurnUsage | null | undefined) {
    if (!usage) return;
    cumulativeCost.value += usage.costUsd || 0;
    cumulativeInputTokens.value += usage.inputTokens || 0;
    cumulativeOutputTokens.value += usage.outputTokens || 0;
    if (usage.subagentTurn) {
      subagentTurnInputTokens.value += usage.inputTokens || 0;
      subagentTurnOutputTokens.value += usage.outputTokens || 0;
      subagentTurnCost.value += usage.costUsd || 0;
    }
    if (usage.byModel) {
      const merged = { ...byModelCumulative.value };
      for (const [modelId, u] of Object.entries(usage.byModel)) {
        const prev = merged[modelId] ?? {
          inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0,
        };
        merged[modelId] = {
          inputTokens: prev.inputTokens + (u.inputTokens || 0),
          outputTokens: prev.outputTokens + (u.outputTokens || 0),
          cacheReadInputTokens: prev.cacheReadInputTokens + (u.cacheReadInputTokens || 0),
          cacheCreationInputTokens: prev.cacheCreationInputTokens + (u.cacheCreationInputTokens || 0),
          costUsd: prev.costUsd + (u.costUsd || 0),
        };
      }
      byModelCumulative.value = merged;
    }
  }

  function handleNestingWarning(event: { depth: number; threshold: number }) {
    nestingWarning.value = { depth: event.depth, threshold: event.threshold };
  }

  function handleRateLimitEvent(event: RateLimitInfo) {
    rateLimit.value = {
      subscription: event.subscription ?? null,
      windows: event.windows ?? [],
    };
  }

  return {
    runtimeHealth,
    cumulativeCost,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    subagentTurnInputTokens,
    subagentTurnOutputTokens,
    subagentTurnCost,
    byModelCumulative,
    nestingWarning,
    rateLimit,
    handleHealthEvent,
    accumulateUsage,
    handleNestingWarning,
    handleRateLimitEvent,
  };
}

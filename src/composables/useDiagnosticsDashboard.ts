import { ref } from "vue";
import type { RateLimitInfo, TurnUsage } from "@/types/chat";

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

// ---- 速率限制 ----

const rateLimit = ref<RateLimitInfo | null>(null);

// ---- chat-event 处理器 ----

let listenerStarted = false;

export function useDiagnosticsDashboard() {
  if (!listenerStarted) {
    listenerStarted = true;
    // 这里不直接 listen——调用方在 App.vue 或 SettingsPanel 里注册
  }

  function handleHealthEvent(event: any) {
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
  }

  function handleRateLimitEvent(event: any) {
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
    rateLimit,
    handleHealthEvent,
    accumulateUsage,
    handleRateLimitEvent,
  };
}

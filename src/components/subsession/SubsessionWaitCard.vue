<script setup lang="ts">
/**
 * 作答槽里的「子会话在等你批准」引导卡（子会话设计 §8.5-6）。
 *
 * 权限请求属于子会话，**在子会话里批**——v1 不在父会话里代批（同屏两处都能批会让「这条是在哪批的」
 * 含混）。这张卡只负责把人带过去：点「去处理」在父会话旁边分屏打开那个子会话。
 */
import type { SubsessionEntry } from "@/composables/useSubsessions";
import { usePaneLayout } from "@/composables/usePaneLayout";

defineProps<{ child: SubsessionEntry; others: number }>();

const { openSessionBeside } = usePaneLayout();
</script>

<template>
  <div class="sswait" role="group" aria-label="子会话等待批准">
    <span class="sswait-dot" aria-hidden="true"></span>
    <div class="sswait-main">
      <div class="sswait-title">子会话「{{ child.title }}」在等你批准</div>
      <div class="sswait-sub">
        权限请求在子会话里批<template v-if="others > 0"> · 还有 {{ others }} 条待处理</template>
      </div>
    </div>
    <button type="button" class="sswait-btn" @click="openSessionBeside(child.id)">去处理</button>
  </div>
</template>

<style scoped>
.sswait {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 12px 6px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--aide-warning) 40%, var(--aide-border));
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
}
.sswait-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--aide-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-warning) 18%, transparent);
}
.sswait-main {
  flex: 1;
  min-width: 0;
}
.sswait-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sswait-sub {
  font-size: 11.5px;
  color: var(--aide-text-muted);
}
.sswait-btn {
  flex: none;
  height: 28px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
</style>

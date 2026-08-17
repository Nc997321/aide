<script setup lang="ts">
import AppLogo from "../../AppLogo.vue";
</script>

<template>
  <div class="logo-big"><AppLogo :size="56" animated /></div>
  <div class="eyebrow">01 / 04</div>
  <div class="headline">用 Aide，和 Claude 并肩写代码</div>
  <div class="support">aide 是一个桌面工作区——会话、文件树、代码索引都在一个窗口。三步配好，马上能开聊。</div>
  <div class="pills">
    <div class="pill"><b>1</b>选工作区</div>
    <div class="pill"><b>2</b>登录 Claude</div>
    <div class="pill"><b>3</b>选模型</div>
  </div>
</template>

<style scoped>
/* AppLogo 自带 3px 圆角；hero 态覆写为 14px + accent 辉光 + 顶部受光 */
.logo-big :deep(.app-logo) {
  border-radius: 14px;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
}
.eyebrow {
  font-size: 10px; color: var(--aide-accent); font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase;
}
.headline {
  font-size: 24px; font-weight: 600; letter-spacing: -.015em; line-height: 1.2;
  color: var(--aide-text-primary);
}
.support {
  font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px;
}
.pills { display: flex; gap: 8px; }
.pill {
  font-size: 11px; color: var(--aide-text-secondary); background: var(--aide-surface);
  border: 1px solid var(--aide-border-subtle); padding: 5px 11px; border-radius: 99px;
  display: flex; align-items: center; gap: 6px;
}
.pill b { color: var(--aide-accent); font-weight: 600; }
</style>
<script setup lang="ts">
import { computed } from "vue";
import { useOnboarding, type Step } from "../../composables/useOnboarding";
import WelcomeStep from "./steps/WelcomeStep.vue";
import WorkspaceStep from "./steps/WorkspaceStep.vue";
import LoginStep from "./steps/LoginStep.vue";
import ModelStep from "./steps/ModelStep.vue";

const ob = useOnboarding();

const STEPS: { key: Step; label: string }[] = [
  { key: "welcome", label: "欢迎" },
  { key: "workspace", label: "工作区" },
  { key: "login", label: "登录" },
  { key: "model", label: "模型" },
];
const curIndex = computed(() => STEPS.findIndex((s) => s.key === ob.step.value));

const primaryText = computed(() => {
  if (ob.step.value === "welcome") return "开始";
  if (ob.step.value === "model") return "进入 aide";
  return "下一步";
});
function onPrimary() {
  if (ob.step.value === "model") ob.complete();
  else ob.advance();
}
</script>

<template>
  <Teleport to="body">
    <div class="onboarding-overlay">
      <div class="wiz-top">
        <div class="rail">
          <template v-for="(s, i) in STEPS" :key="s.key">
            <div class="seg" :class="{ done: i < curIndex, cur: i === curIndex }">
              <span class="bar"></span><span class="nm">{{ s.label }}</span>
            </div>
            <div v-if="i < STEPS.length - 1" class="seg-sep"></div>
          </template>
        </div>
        <button class="skip-all" @click="ob.skipAll()">跳过引导</button>
      </div>

      <div class="wiz-center">
        <WelcomeStep v-if="ob.step.value === 'welcome'" />
        <WorkspaceStep v-else-if="ob.step.value === 'workspace'" />
        <LoginStep v-else-if="ob.step.value === 'login'" />
        <ModelStep v-else-if="ob.step.value === 'model'" />
      </div>

      <div class="wiz-bottom">
        <button v-if="ob.step.value !== 'welcome'" class="btn btn-ghost btn-back" @click="ob.back()">← 上一步</button>
        <span class="left" v-if="ob.step.value !== 'welcome' && ob.step.value !== 'model'">不配也行，发消息时再引导</span>
        <span class="left" v-else-if="ob.step.value === 'model'">就绪</span>
        <span class="left" v-else>约 1 分钟 · 随时可跳过</span>
        <button class="btn btn-primary" @click="onPrimary">{{ primaryText }} <span v-if="ob.step.value !== 'model'">→</span></button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.onboarding-overlay {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; flex-direction: column; padding: 22px 28px 24px;
  background:
    radial-gradient(420px 220px at 50% -40px, rgba(150,170,255,.20), transparent 70%),
    radial-gradient(560px 380px at 12% 8%, rgba(124,108,255,.14), transparent 65%),
    radial-gradient(520px 420px at 94% 12%, rgba(64,190,220,.10), transparent 65%),
    rgba(10,11,17,.78);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  color: var(--aide-text-primary);
}
.wiz-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.rail { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.seg { display: flex; align-items: center; gap: 7px; min-width: 0; }
.seg .bar { height: 3px; flex: 1; min-width: 18px; border-radius: 99px; background: var(--aide-surface-active); }
.seg .nm { font-size: 10px; color: var(--aide-text-muted); white-space: nowrap; }
.seg.done .bar { background: var(--aide-accent); opacity: .55; }
.seg.cur .bar { background: var(--aide-accent-gradient); box-shadow: 0 0 8px rgba(150,170,255,.5); }
.seg.cur .nm { color: var(--aide-accent); font-weight: 600; }
.seg-sep { width: 5px; height: 5px; border-radius: 50%; background: var(--aide-border); flex-shrink: 0; }
.skip-all {
  font-size: 11px; color: var(--aide-text-muted); background: transparent;
  border: 1px solid var(--aide-border); padding: 5px 11px; border-radius: 99px;
  cursor: pointer; transition: all .16s var(--aide-ease);
}
.skip-all:hover { color: var(--aide-text-secondary); border-color: var(--aide-border-strong); background: var(--aide-surface); }
.wiz-center {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; gap: 14px; max-width: 540px; margin: 0 auto;
}
.wiz-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wiz-bottom .left { font-size: 10.5px; color: var(--aide-text-muted); }
.btn {
  font-family: inherit; cursor: pointer; border: none; transition: all .16s var(--aide-ease);
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.btn-primary {
  padding: 13px 20px; border-radius: var(--aide-radius-md); background: var(--aide-accent-gradient);
  color: #eef0ff; font-size: 13.5px; font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset); border: 1px solid rgba(150,170,255,.45);
}
.btn-primary:hover { transform: translateY(-1px); filter: brightness(1.07); }
.btn-ghost {
  padding: 8px 16px; border-radius: var(--aide-radius-md); background: var(--aide-surface);
  border: 1px solid var(--aide-border); color: var(--aide-text-secondary); font-size: 12px; font-weight: 500;
}
.btn-ghost:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); transform: translateY(-1px); }
@media (prefers-reduced-motion: reduce) {
  .btn, .skip-all { transition: none; }
  .btn-primary:hover, .btn-ghost:hover { transform: none; }
}
</style>
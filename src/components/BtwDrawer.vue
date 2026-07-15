<script setup lang="ts">
import { computed } from "vue";
import { useBtwSession } from "@/composables/useBtwSession";

const props = defineProps<{ visible: boolean; lightweight: boolean }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "stop"): void;
  (e: "update:lightweight", v: boolean): void;
}>();

const { store } = useBtwSession();
const text = computed(() => store.value.messages.join(""));
</script>

<template>
  <Transition name="btw-drawer">
    <aside v-if="props.visible" class="btw-drawer" role="complementary" aria-label="顺便问一下">
      <div class="btw-drawer-stripe"></div>
      <div class="btw-banner">
        <span class="btw-bi">↳</span> 这条支线不进入主对话上下文
        <span class="btw-blight">轻量 · 极少 token</span>
      </div>
      <div class="btw-head">
        <div class="btw-title"><span class="btw-fork">↳</span> 顺便问一下 <span class="btw-pill">· btw</span></div>
        <div class="btw-sub">从主对话 fork 副本开跑 · 来回不回写主对话 · 跑完即弃</div>
        <div class="btw-ctrl">
          <div class="btw-seg" role="group">
            <button :aria-pressed="props.lightweight" @click="emit('update:lightweight', true)" :disabled="store.isBusy">轻量</button>
            <button :aria-pressed="!props.lightweight" @click="emit('update:lightweight', false)" :disabled="store.isBusy">完整</button>
          </div>
          <span class="btw-spacer"></span>
          <button v-if="store.isBusy" class="btw-btn btw-danger" @click="emit('stop')">停止</button>
          <button v-if="!store.isBusy" class="btw-btn" @click="emit('close')">关闭</button>
        </div>
      </div>
      <div class="btw-body">
        <div class="btw-q">{{ store.question }}</div>
        <div class="btw-a">{{ text }}<span v-if="store.isBusy" class="btw-cursor"></span></div>
        <div v-if="store.error" class="btw-err">{{ store.error }}</div>
      </div>
      <div v-if="store.done" class="btw-foot">
        <span class="btw-ok">已作为批注插入主对话</span>
        <span class="btw-spacer"></span>
        <button class="btw-btn" @click="emit('close')">关闭</button>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.btw-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 320px;
  display: flex; flex-direction: column;
  background: var(--aide-bg-raised); border-left: 1px solid var(--aide-accent);
  box-shadow: var(--aide-shadow-lg); z-index: 20;
}
.btw-drawer-stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--aide-accent); }
.btw-banner {
  display: flex; align-items: center; gap: 7px; padding: 7px 14px 7px 17px;
  font-size: 11px; color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 7%, transparent);
  border-bottom: 1px solid var(--aide-border);
}
.btw-bi { font-size: 14px; line-height: 1; }
.btw-blight { margin-left: auto; color: var(--aide-text-muted); display: flex; align-items: center; gap: 5px; }
.btw-blight::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--aide-success); }
.btw-head { padding: 11px 14px 11px 17px; border-bottom: 1px solid var(--aide-border); }
.btw-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--aide-text-primary); }
.btw-fork { color: var(--aide-accent); font-size: 14px; }
.btw-pill { font-size: 11px; color: var(--aide-text-muted); font-weight: 400; }
.btw-sub { font-size: 11px; color: var(--aide-text-muted); margin: 4px 0 0 22px; line-height: 1.5; }
.btw-ctrl { display: flex; align-items: center; gap: 7px; margin: 10px 0 0 22px; }
.btw-seg { display: inline-flex; border: 1px solid var(--aide-border); border-radius: 999px; overflow: hidden; }
.btw-seg button { background: none; border: 0; color: var(--aide-text-muted); padding: 3px 11px; font-size: 11px; cursor: pointer; }
.btw-seg button[aria-pressed="true"] { background: var(--aide-accent-subtle); color: var(--aide-accent); }
.btw-seg button:disabled { opacity: 0.5; cursor: default; }
.btw-spacer { flex: 1; }
.btw-btn { border: 1px solid var(--aide-border); background: transparent; color: var(--aide-text-secondary); border-radius: var(--aide-radius-sm); padding: 4px 10px; font-size: 12px; cursor: pointer; }
.btw-btn:hover { border-color: var(--aide-accent); color: var(--aide-accent); }
.btw-danger:hover { border-color: var(--aide-danger); color: var(--aide-danger); }
.btw-body { flex: 1; overflow: auto; padding: 13px 14px 13px 17px; display: flex; flex-direction: column; gap: 12px; }
.btw-q { font-size: 12.5px; color: var(--aide-text-secondary); border-left: 2px solid var(--aide-border); padding-left: 9px; }
.btw-a { font-size: 12.5px; line-height: 1.6; color: var(--aide-text-primary); white-space: pre-wrap; word-break: break-word; }
.btw-cursor { display: inline-block; width: 6px; height: 13px; vertical-align: -2px; background: var(--aide-accent); animation: btw-blink 1s steps(2, start) infinite; }
@keyframes btw-blink { 50% { opacity: 0; } }
.btw-err { font-size: 12px; color: var(--aide-danger); }
.btw-foot { display: flex; align-items: center; gap: 9px; padding: 9px 14px 9px 17px; border-top: 1px solid var(--aide-border); background: color-mix(in srgb, var(--aide-success) 6%, transparent); }
.btw-ok { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--aide-success); }
.btw-ok::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--aide-success); }
.btw-drawer-enter-active, .btw-drawer-leave-active { transition: transform 0.2s ease, opacity 0.2s ease; }
.btw-drawer-enter-from, .btw-drawer-leave-to { transform: translateX(20px); opacity: 0; }
</style>

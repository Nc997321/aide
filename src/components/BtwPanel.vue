<script setup lang="ts">
/**
 * btw 侧边对话（2026-10-17，取代 BtwDrawer 的覆盖式抽屉）：并排在会话右侧的一栏，
 * 挤开主对话而不是盖住它——两边都看得全。
 *
 * - 一个主会话一条线程（useBtwSession），所有问答按时间排成气泡，最新的在最下面；
 *   侧栏是**看回复的固定地点**，主对话里的 btw 批注只当书签（点开定位到这一轮）。
 * - 侧栏有自己的输入框：主输入框只管主对话，不再有「btw 模式」。一次只有一问在途。
 * - 关掉侧栏不影响在途的问答：答复照样到，活动带亮「有新回复」。
 * - 支线跟随主会话的模型与档位（官方 side_question 通道），这里没有选择器。
 */
import { computed, nextTick, ref, watch } from "vue";
import { useBtwSession } from "@/composables/useBtwSession";
import { useAutoGrow } from "@/composables/useAutoGrow";
import { renderMarkdown } from "@/utils/markdown";
import Icon from "./Icon.vue";
import ThinkingMark from "./activity/ThinkingMark.vue";

const props = defineProps<{ ownerSid: string | null }>();
const emit = defineEmits<{ ask: [question: string] }>();

const btw = useBtwSession();
const thread = computed(() => btw.threadFor(props.ownerSid));
const visible = computed(() => !!props.ownerSid && thread.value.open);
const pending = computed(() => thread.value.rounds.some((r) => r.status === "pending"));

const draft = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);
useAutoGrow(inputEl, draft, { maxLines: 8 });

function close() {
  if (props.ownerSid) btw.closePanel(props.ownerSid);
}

function submit() {
  const q = draft.value.trim();
  if (!q || pending.value || !props.ownerSid) return;
  emit("ask", q);
  draft.value = "";
}

function retry(question: string) {
  if (pending.value) return;
  emit("ask", question);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

function scrollToBottom() {
  const el = bodyEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 高亮一轮（书签点进来时）：滚到它、闪一下 */
const flashId = ref<string | null>(null);
function focusRound(id: string) {
  const el = bodyEl.value?.querySelector<HTMLElement>(`[data-round="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  flashId.value = id;
  window.setTimeout(() => {
    if (flashId.value === id) flashId.value = null;
  }, 1200);
}

// 新一轮 / 答复到达：滚到底（书签定位优先）
watch(
  () => [thread.value.rounds.length, thread.value.rounds[thread.value.rounds.length - 1]?.status],
  () => {
    if (thread.value.focusRoundId) return;
    void nextTick(scrollToBottom);
  },
);

// 书签定位请求：侧栏打开渲染后再滚过去，用完即清
watch(
  () => [visible.value, thread.value.focusRoundId] as const,
  ([vis, id]) => {
    if (!vis || !id || !props.ownerSid) return;
    const owner = props.ownerSid;
    void nextTick(() => {
      focusRound(id);
      btw.consumeFocusRound(owner);
    });
  },
  { immediate: true },
);

// 打开侧栏（非书签）：落到最新一轮
watch(visible, (v) => {
  if (v && !thread.value.focusRoundId) void nextTick(scrollToBottom);
});

// /btw、快捷菜单打开时把光标放进输入框
watch(
  () => [visible.value, thread.value.focusInputTick] as const,
  ([vis, tick], prev) => {
    if (vis && tick > 0 && tick !== prev?.[1]) void nextTick(() => inputEl.value?.focus());
  },
  { immediate: true },
);

const placeholder = computed(() => (pending.value ? "等这条答完再问…" : "顺便问一句，不打断主会话…"));
</script>

<template>
  <Transition name="btwp">
    <aside v-if="visible" class="btwp" role="complementary" aria-label="顺便问一下">
      <header class="btwp-head">
        <div class="btwp-title">
          <span class="btwp-title-main">顺便问一下</span>
          <span class="btwp-title-sub">主会话照常运行 · 不进入主对话上下文</span>
        </div>
        <button type="button" class="btwp-close" v-tooltip="'收起（回复到了会在输入框上方提醒）'" @click="close">
          <Icon name="close" :size="12" :stroke-width="1.6" />
        </button>
      </header>

      <div ref="bodyEl" class="btwp-body">
        <p v-if="!thread.rounds.length" class="btwp-empty">
          问点和主任务相关的小问题。<br />主会话不会被打断，问答也不会进入它的上下文。
        </p>
        <section
          v-for="r in thread.rounds"
          :key="r.id"
          class="btwp-round"
          :class="{ 'btwp-round--flash': flashId === r.id }"
          :data-round="r.id"
        >
          <div class="btwp-q">{{ r.question }}</div>
          <div v-if="r.status === 'pending'" class="btwp-pending">
            <ThinkingMark :size="14" />
            <span class="btwp-pending-text">正在回答</span>
          </div>
          <div v-else-if="r.status === 'error'" class="btwp-err">
            <span>{{ r.error }}</span>
            <button type="button" class="btwp-retry" :disabled="pending" @click="retry(r.question)">重试</button>
          </div>
          <div v-else class="btwp-a msg-text" v-html="renderMarkdown(r.answer ?? '')"></div>
        </section>
      </div>

      <footer class="btwp-foot">
        <div class="btwp-input-box" :class="{ 'btwp-input-box--off': pending }">
          <textarea
            ref="inputEl"
            v-model="draft"
            class="btwp-input"
            rows="1"
            :placeholder="placeholder"
            @keydown="onKeydown"
          />
          <button
            type="button"
            class="btwp-send"
            :disabled="pending || !draft.trim()"
            aria-label="发送"
            @click="submit"
          >
            <Icon name="enter" :size="15" :stroke-width="1.5" />
          </button>
        </div>
        <div class="btwp-hint">Enter 发送 · Shift+Enter 换行 · Esc 收起</div>
      </footer>
    </aside>
  </Transition>
</template>

<style scoped>
/* 并排一栏：宽度随窗格收放，但不窄于能读的宽度、也不抢走主对话 */
.btwp {
  flex: none;
  width: clamp(300px, 34%, 400px);
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--aide-border);
  background: var(--aide-bg-deep);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
}

.btwp-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 16px;
}
.btwp-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.btwp-title-main {
  font-size: 13px;
  font-weight: 600;
}
.btwp-title-sub {
  font-size: 11px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btwp-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.btwp-close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.btwp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.btwp-empty {
  margin: auto 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.8;
  color: var(--aide-text-muted);
}

.btwp-round {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--aide-radius-md);
  transition: background 0.6s var(--aide-ease);
}
/* 书签点进来：这一轮底色闪一下再退 */
.btwp-round--flash {
  background: var(--aide-surface-default);
  transition: none;
}

/* 问题：与主对话用户气泡同一种语言，小一号 */
.btwp-q {
  align-self: flex-end;
  max-width: 88%;
  padding: 6px 11px;
  border-radius: var(--aide-radius-lg) var(--aide-radius-lg) 5px var(--aide-radius-lg);
  background: linear-gradient(180deg, var(--aide-surface-default), var(--aide-bg-raised));
  border: 1px solid var(--aide-border);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.btwp-a {
  font-size: 12.5px;
  line-height: 1.7;
  word-break: break-word;
}

.btwp-pending {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.btwp-pending-text {
  background: linear-gradient(
    90deg,
    var(--aide-text-muted) 0%,
    var(--aide-text-muted) 33%,
    var(--aide-agent-accent) 50%,
    var(--aide-text-muted) 67%,
    var(--aide-text-muted) 100%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: btwp-shimmer 2.5s linear infinite;
}
@keyframes btwp-shimmer {
  0% { background-position: 100% center; }
  100% { background-position: 0% center; }
}

.btwp-err {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
  color: var(--aide-danger);
}
.btwp-retry {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--aide-text-secondary);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.btwp-retry:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 输入区与主输入框**逐像素同构**（并排时两个框必须等高、底边对齐）：
   框 = 1px 边 + 6px 内边距 + 30px 行（textarea 5+20+5 / 按钮 30）= 44px；
   框下一行 32px（对应主输入框下方的模型 / 权限状态行：min-height 28 + 上 4）；
   最底 12px（对应 .chat-input-area 的下内边距）。改主输入框尺寸时这里一起改。 */
.btwp-foot {
  flex: none;
  padding: 4px 12px 12px;
}
.btwp-input-box {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  min-height: 44px; /* 自动增高的 textarea 可能算出小数高度，兜住与主输入框等高 */
  padding: 6px 6px 6px 10px;
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  transition: border-color var(--aide-ease-t);
}
.btwp-input-box:focus-within {
  border-color: var(--aide-border-strong);
}
.btwp-input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 0;
  background: transparent;
  padding: 5px 4px;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--aide-text-primary);
  outline: none;
  overflow-y: hidden;
}
.btwp-input::placeholder {
  color: var(--aide-text-muted);
}
.btwp-send {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: var(--aide-radius-md);
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  cursor: pointer;
  transition: filter var(--aide-ease-t), background var(--aide-ease-t);
}
.btwp-hint {
  display: flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px 0;
  font-size: 11px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.btwp-send:disabled {
  background: var(--aide-surface-hover);
  color: var(--aide-text-muted);
  cursor: default;
}

/* 进出：只动 transform/opacity（宽度瞬变，避免主对话逐帧重排） */
.btwp-enter-active {
  transition: transform 0.2s var(--aide-ease), opacity 0.2s var(--aide-ease);
}
.btwp-leave-active {
  transition: opacity 0.12s ease;
}
.btwp-enter-from {
  transform: translateX(16px);
  opacity: 0;
}
.btwp-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .btwp-enter-active,
  .btwp-leave-active,
  .btwp-round {
    transition: none;
  }
  .btwp-pending-text {
    animation: none;
  }
}
</style>

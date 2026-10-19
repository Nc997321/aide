<script setup lang="ts">
/**
 * 手动派子会话的浮窗内容（放在 FloatingCard 里）：两个入口共用——
 * 消息里选中一段「派给子会话」（带 quote）、＋ 菜单「新建子会话」（不带）。
 *
 * 只发命令，不本地造状态：派出成功后侧栏 / 活动带由 Host 广播的 `subsession_started` 更新
 * （多端一致性红线），这里只给发起的这一端一句「已派出」的回执。
 * 限额与深度规则以 Host 为准（spawn_child）；这里的「在跑 n/4」只是提前提示，不做判定。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { api } from "@/api";
import Icon from "../Icon.vue";
import { useAutoGrow } from "@/composables/useAutoGrow";
import { usePaneLayout } from "@/composables/usePaneLayout";
import { SUBSESSION_MAX_RUNNING } from "@/composables/useSubsessions";
import { composeSubsessionTask } from "./composeTask";

const props = defineProps<{
  parentId: string;
  /** 选中的原文（从消息里派时才有） */
  quote?: string;
  running: number;
  /** 父会话输入框当前的模型 / 档位 / 权限模式：子会话沿用 */
  defaults: () => { model?: string; effort?: string; permissionMode?: string };
}>();

const emit = defineEmits<{
  close: [];
  spawned: [];
  /** 写了东西 / 正在派：外层据此不让「点外部」把浮窗关掉 */
  dirty: [dirty: boolean];
}>();

const note = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const busy = ref(false);
const error = ref("");
const done = ref<{ id: string; title: string } | null>(null);
useAutoGrow(inputEl, note, { maxLines: 8 });
watch([note, busy], () => emit("dirty", !!note.value.trim() || busy.value));

const task = computed(() => composeSubsessionTask(note.value, props.quote));
const full = computed(() => props.running >= SUBSESSION_MAX_RUNNING);
const canSend = computed(() => !!task.value && !busy.value && !full.value);
const placeholder = computed(() =>
  props.quote ? "要它做什么？留空就按这段话去做" : "写清楚一件事，可以 @ 文件",
);

onMounted(() => void nextTick(() => inputEl.value?.focus()));

let closeTimer: ReturnType<typeof setTimeout> | undefined;
async function send() {
  if (!canSend.value) return;
  busy.value = true;
  error.value = "";
  const d = props.defaults();
  try {
    const r = await api.spawnSubsession({
      parentId: props.parentId,
      task: task.value,
      model: d.model || null,
      effort: d.effort || null,
      permissionMode: d.permissionMode || null,
    });
    done.value = { id: r.child_id, title: r.title };
    emit("spawned");
    closeTimer = setTimeout(() => emit("close"), 2400);
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
  } finally {
    busy.value = false;
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Enter" || e.isComposing || e.shiftKey) return;
  e.preventDefault();
  void send();
}

const { openSubsession } = usePaneLayout();
function openChild() {
  if (!done.value) return;
  clearTimeout(closeTimer);
  openSubsession(done.value.id);
  emit("close");
}
</script>

<template>
  <template v-if="done">
    <div class="ssc-done" role="status">
      <Icon name="subsession" :size="15" :stroke-width="1.5" class="ssc-icon" />
      <span class="ssc-done-text">已派出「{{ done.title }}」</span>
      <button type="button" class="ssc-link" @click="openChild">打开</button>
    </div>
  </template>
  <template v-else>
    <header class="ssc-head">
      <Icon name="subsession" :size="15" :stroke-width="1.5" class="ssc-icon" />
      <span class="ssc-title">{{ quote ? "派给子会话" : "新建子会话" }}</span>
      <span class="ssc-sub">做完会回报到这里</span>
    </header>

    <div v-if="quote" class="ssc-quote">
      <div class="ssc-quote-label">选中的原文</div>
      <div class="ssc-quote-text">{{ quote }}</div>
    </div>

    <textarea
      ref="inputEl"
      v-model="note"
      class="ssc-input"
      rows="1"
      aria-label="要它做什么"
      :placeholder="placeholder"
      :disabled="busy"
      spellcheck="false"
      @keydown="onKey"
    />

    <div v-if="error" class="ssc-error" role="alert">{{ error }}</div>

    <footer class="ssc-foot">
      <span class="ssc-meta" :class="{ 'ssc-meta--full': full }">
        {{ full ? `已有 ${running} 个子会话在跑，等其中一个回报后再派` : `同父会话的模型与权限 · 在跑 ${running}/${SUBSESSION_MAX_RUNNING}` }}
      </span>
      <span class="ssc-spacer" />
      <button type="button" class="ssc-btn" @click="emit('close')">取消</button>
      <button type="button" class="ssc-btn ssc-btn--primary" :disabled="!canSend" @click="send">
        <span v-if="busy" class="ssc-spin" aria-hidden="true" />
        {{ busy ? "派发中" : error ? "重试" : "派出" }}<kbd v-if="!busy">↵</kbd>
      </button>
    </footer>
  </template>
</template>

<style scoped>
.ssc-head,
.ssc-done {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ssc-icon {
  color: var(--aide-accent);
}
.ssc-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.ssc-sub {
  margin-left: auto;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.ssc-done-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--aide-text-primary);
}
.ssc-link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--aide-accent);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ssc-link:hover {
  color: var(--aide-accent-hover);
}

.ssc-quote {
  padding: 9px 12px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
}
.ssc-quote-label {
  margin-bottom: 2px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.ssc-quote-text {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 与会话输入框同一个样子：默认一行、随内容长高（useAutoGrow） */
.ssc-input {
  box-sizing: border-box;
  width: 100%;
  resize: none;
  padding: 9px 12px;
  border-radius: var(--aide-radius-lg);
  border: 1px solid var(--aide-border-strong);
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  outline: none;
  overflow-y: hidden;
  transition: border-color var(--aide-ease-t);
}
.ssc-input:focus {
  border-color: color-mix(in srgb, var(--aide-accent) 55%, var(--aide-border-strong));
}
.ssc-input::placeholder {
  color: var(--aide-text-muted);
}

.ssc-error {
  padding: 8px 10px;
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
  color: var(--aide-danger);
  font-size: 12.5px;
  white-space: pre-wrap;
}

.ssc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ssc-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}
.ssc-meta--full {
  color: var(--aide-warning);
}
.ssc-spacer {
  flex: 1;
}
.ssc-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--aide-radius-md);
  background: none;
  color: var(--aide-text-secondary);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.ssc-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.ssc-btn--primary {
  padding: 0 14px;
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  font-weight: 600;
}
.ssc-btn--primary:hover {
  background: var(--aide-accent-hover);
  color: var(--aide-text-on-accent);
}
.ssc-btn--primary:disabled {
  opacity: 0.45;
  cursor: default;
  background: var(--aide-accent);
}
.ssc-btn kbd {
  font: inherit;
  font-size: 10.5px;
  opacity: 0.7;
}
.ssc-spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  animation: ssc-spin 0.8s linear infinite;
}
@keyframes ssc-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

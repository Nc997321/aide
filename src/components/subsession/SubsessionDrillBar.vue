<script setup lang="ts">
/**
 * 子会话返回条（子会话设计 spec §13「钻进去，← 返回」）：子会话视图顶部，整宽一条。
 *
 * 看子会话不开新 tab，是在父会话的 tab 里钻进来；出去只有「←」，停只有写着字的「停止这一轮」——
 * 「看完离开」和「让它停」是两个看得见的动作，不再共用 tab 的 ×。
 *
 * - 状态胶囊看 useSessionState（与侧栏流光同一份）：运行中 / 在等你回答（队头是提问）/
 *   在等你批准 / 空闲 / 已停止；
 * - 父会话那边有新动静（钻进来之后来了新消息，或它在等你处理）：← 旁边亮点；
 * - 停止 = 打断子会话这一轮（ChatPanel 的 interrupt 发给正在显示的会话，即子会话）。
 */
import { computed, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { useSessionState } from "@/composables/useSessionState";
import { useSessionNames } from "@/composables/useSessionNames";
import { messagesOf, pendingPermissionsOf } from "@/composables/useChatSession";
import { QUESTION_TOOL_NAME } from "@aide/sdk/utils/permissionShape";

const props = defineProps<{ childId: string; parentId: string }>();
const emit = defineEmits<{ back: []; stop: [] }>();

const { state } = useSessionState();
const names = useSessionNames();

const parentTitle = computed(() => names.names[props.parentId] || "父会话");
const childTitle = computed(() => names.names[props.childId] || "子会话");

type Tone = "run" | "ask" | "idle" | "off";
const status = computed<{ label: string; tone: Tone }>(() => {
  const st = state[props.childId];
  if (st === "running") return { label: "运行中", tone: "run" };
  if (st === "attention") {
    const head = pendingPermissionsOf(props.childId)[0];
    return { label: head?.name === QUESTION_TOOL_NAME ? "在等你回答" : "在等你批准", tone: "ask" };
  }
  if (st === "stopped") return { label: "已停止", tone: "off" };
  return { label: "空闲", tone: "idle" };
});
const busy = computed(() => status.value.tone === "run" || status.value.tone === "ask");
const note = computed(() =>
  busy.value ? "每轮结束会回报给父会话" : "再说一句它会接着做，结束时回报给父会话",
);

/** 钻进来那一刻父会话有几条消息；之后多出来的就是「新消息」。 */
const parentBase = ref(messagesOf(props.parentId).length);
watch(
  () => [props.childId, props.parentId],
  () => {
    parentBase.value = messagesOf(props.parentId).length;
  },
);
const parentNews = computed<string | null>(() => {
  if (state[props.parentId] === "attention") return "在等你处理";
  return messagesOf(props.parentId).length > parentBase.value ? "有新消息" : null;
});
</script>

<template>
  <div class="ssdrill" role="navigation" aria-label="子会话">
    <button
      type="button"
      class="ssdrill-back"
      :aria-label="`返回父会话 ${parentTitle}`"
      v-tooltip="'返回父会话（子会话照常继续）'"
      @click="emit('back')"
    >
      <Icon name="back" :size="14" :stroke-width="1.8" />
      <span class="ssdrill-parent">{{ parentTitle }}</span>
      <template v-if="parentNews">
        <span class="ssdrill-news-dot" aria-hidden="true"></span>
        <span class="ssdrill-news">{{ parentNews }}</span>
      </template>
    </button>
    <span class="ssdrill-sep" aria-hidden="true">›</span>
    <Icon class="ssdrill-icon" name="subsession" :size="13" :stroke-width="1.6" />
    <span class="ssdrill-title">{{ childTitle }}</span>
    <span class="ssdrill-pill" :class="`ssdrill-pill--${status.tone}`">
      <span class="ssdrill-pill-dot" aria-hidden="true"></span>{{ status.label }}
    </span>
    <span class="ssdrill-grow"></span>
    <span class="ssdrill-note">{{ note }}</span>
    <button v-if="busy" type="button" class="ssdrill-stop" @click="emit('stop')">
      <span class="ssdrill-stop-sq" aria-hidden="true"></span>停止这一轮
    </button>
  </div>
</template>

<style scoped>
.ssdrill {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 42px;
  padding: 0 14px 0 8px;
  border-bottom: 1px solid var(--aide-border-subtle);
  background: var(--aide-bg-raised);
  font-size: 13px;
}
.ssdrill-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 40%;
  height: 30px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
.ssdrill-back:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.ssdrill-parent {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssdrill-news-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aide-warning);
}
.ssdrill-news {
  flex: none;
  font-size: 12px;
  color: var(--aide-warning);
}
.ssdrill-sep {
  flex: none;
  color: var(--aide-text-muted);
}
.ssdrill-icon {
  flex: none;
  color: var(--aide-info);
}
.ssdrill-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.ssdrill-pill {
  --pill: var(--aide-text-muted);
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--pill) 13%, transparent);
  color: var(--pill);
  font-size: 12px;
}
.ssdrill-pill--run {
  --pill: var(--aide-success);
}
.ssdrill-pill--ask {
  --pill: var(--aide-warning);
}
.ssdrill-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.ssdrill-grow {
  flex: 1;
}
.ssdrill-note {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.ssdrill-stop {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.ssdrill-stop:hover {
  border-color: color-mix(in srgb, var(--aide-danger) 50%, var(--aide-border));
}
.ssdrill-stop-sq {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--aide-danger);
}

</style>

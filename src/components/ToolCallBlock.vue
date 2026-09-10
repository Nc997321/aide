<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ToolCallBlock, BgTask } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";
import DiffViewer from "./fileviewer/DiffViewer.vue";
import { buildChangeInfo, locateAnchorLine, locateEditStartLine, type ChangeInfo } from "@/utils/changeCard";
import { isChangeTool } from "@/utils/blockSegments";
import { summarizeToolInput } from "@/utils/toolSummary";
import { readRangeLabel } from "@aide/sdk/utils/lspRelay";
import { truncatedLabel } from "@/utils/messageBytes";
import { parseToolDenial } from "@aide/sdk/utils/toolDenial";
import { useFileResolver } from "@/composables/useFileResolver";
import { useSettings } from "@/composables/useSettings";

const props = withDefaults(
  defineProps<{
    block: ToolCallBlock;
    /** 变更类工具（Edit/Write/NotebookEdit）由 ChatMessage 传 true：变更卡默认展开，
     *  其余调用点（SubagentCallBlock 等）不传，保持收起。 */
    defaultExpanded?: boolean;
    /** 「打开 ↗」定位用；缺省时 openResolved 退化为按原路径直接打开 */
    workspacePath?: string;
    /** 后台任务列表（仅 ChatMessage 链透传）——Bash 卡按 toolUseId 匹配出「后台运行中」徽章 */
    bgTasks?: BgTask[];
  }>(),
  { defaultExpanded: false, workspacePath: undefined, bgTasks: undefined },
);

const emit = defineEmits<{
  /** 徽章点击：打开后台任务 dock 并选中该任务 */
  "open-bg-dock": [taskId: string];
}>();

const expanded = ref(props.defaultExpanded);
const { openResolved } = useFileResolver();
const { settings } = useSettings();

const isBash = computed(() => props.block.name === "Bash");

/** 该工具调用转入后台的任务（按 toolUseId 匹配、仍在运行才显示徽章）。 */
const bgTask = computed(
  () => props.bgTasks?.find((t) => t.toolUseId === props.block.id && t.status === "running") ?? null,
);

/**
 * 拒绝态：从结果正文反解，协议里没有独立字段——外框（"The user doesn't want to
 * proceed…"）本身就是「这次是被拒绝而不是失败」的载体，再带一个 `denied` 就是同一
 * 真相的第二份。truncated 的正文已被占位摘要替换，反解不出东西，退回常规错误态。
 * 实时（sidecar 事件）与回看（Rust 解析 jsonl）拿到的是同一份 result 全文，故两条
 * 路径在这里自动一致，不存在「刚发生能识别、回看识别不了」的分裂。
 */
const denial = computed(() => (props.block.truncated ? null : parseToolDenial(props.block.result)));

/** 人工拒绝 vs 命中权限规则：UI 要如实区分，别把规则拦截说成"你拒绝的"。 */
const denialLabel = computed(() => (denial.value?.kind === "policy" ? "规则拒绝" : "已拒绝"));

const denialReasonTip = computed(() =>
  denial.value?.reason
    ? `${denial.value.kind === "policy" ? "命中权限规则" : "你拒绝了这次调用"}：${denial.value.reason}`
    : "",
);

const denialPillTip = computed(() =>
  denial.value?.kind === "policy"
    ? "命中权限规则被拦截，工具未执行"
    : "你拒绝了这次调用，工具未执行",
);

/** 变更类工具且非错误时的统一 diff 数据；null 回退到普通结果文本展示。 */
const changeInfo = computed<ChangeInfo | null>(() => {
  if (!isChangeTool(props.block.name) || props.block.isError) return null;
  return buildChangeInfo(props.block.name, props.block.input);
});

/** DiffViewer 需要定高容器（内部 100% 布局）：按片段行数估算，超高封顶内滚 */
const changeHeight = computed(() => {
  const info = changeInfo.value;
  if (!info) return 0;
  const lines = Math.max(
    info.pair.oldText.split("\n").length,
    info.pair.newText.split("\n").length,
    1,
  );
  const TOOLBAR = 38;
  const perLine = Math.round(settings.fontSize * 1.6);
  return Math.min(480, Math.max(120, TOOLBAR + lines * perLine + 16));
});

/** 「打开 ↗」：在文件查看器中打开并定位到新内容所在行（找不到锚点就只打开） */
async function openChangeFile(e: MouseEvent) {
  e.stopPropagation();
  const info = changeInfo.value;
  if (!info) return;
  const line = await locateAnchorLine(info.filePath, info.anchor);
  // 整块高亮：定位行起 N 行 = new_string 行数（变更卡显示的就是这块）
  const flashCount = info.pair.newText ? info.pair.newText.split("\n").length : 1;
  void openResolved(info.filePath, props.workspacePath, line, flashCount);
}

/**
 * 变更卡 diff 行号偏移：展开时异步算片段在当前文件中的真实起始行，传给 DiffViewer
 * 使行号显示真实行而非片段相对行。算不出（Write 新文件 / 文件已改覆盖 / 读失败）→
 * undefined → 行号从 1。firstLine 的 null = 「未算」，与「算出 undefined」区分，
 * 避免每次展开都重读文件。
 */
const firstLine = ref<number | undefined | null>(null);

watch(
  [expanded, changeInfo] as const,
  async ([exp, info]) => {
    if (!exp || !info || firstLine.value !== null) return;
    firstLine.value = await locateEditStartLine(info.filePath, info.pair.newText, info.pair.status);
  },
  { immediate: true },
);

const inputSummary = computed(() => summarizeToolInput(props.block.name, props.block.input));

/** F 方案（Read 接力显示）：接力徽章（绿=沿 LSP 坐标区间读 / 黄=LSP 已给定位
 *  却整文件读，判定来自 utils/lspRelay.ts，结论已随块标注）。被拒的 Read 不显示
 *  ——「未接力」谈不上，拒绝态由 denial 徽章独自承担。 */
const relayPill = computed(() => {
  if (props.block.name !== "Read" || !props.block.lspRelay || denial.value) return null;
  return props.block.lspRelay === "hit"
    ? { cls: "relay-pill--hit", text: "✓ LSP 接力", tip: "读取区间 = 上一个 LSP 调用给出的位置" }
    : { cls: "relay-pill--miss", text: "⚠ 未接力 · 整文件读", tip: "LSP 已在该文件上给出定位，这次却整文件读进上下文" };
});

/** Read 的行号区间文案（offset 1-based、limit 行数）。仅 Read 显示，其它工具与
 *  @mention 合成卡（整文件引用，无 range 即无 offset/limit）自然为 null；
 *  选区引用（@path:12-48）由 mention→Read 映射补上 offset/limit，因此也显示。 */
const readRange = computed(() =>
  props.block.name === "Read" ? readRangeLabel(props.block.input) : null,
);
</script>

<template>
  <div class="tool-item">
    <button class="ti-row" :aria-expanded="expanded" @click="expanded = !expanded">
      <span
        :class="[
          'ti-dot',
          block.isPending ? 'ti-dot--run' : denial ? 'ti-dot--deny' : block.isError ? 'ti-dot--err' : '',
        ]"
      ></span>
      <span class="ti-name">{{ block.name }}</span>
      <!-- bdo dir=ltr：外层容器是 rtl（左侧省略），内层强制路径本身仍按 ltr 排，
           省略号落在路径头部、文件名始终可见 -->
      <span class="ti-summary" v-tooltip="inputSummary"><bdo dir="ltr">{{ inputSummary }}</bdo></span>
      <!-- 拒绝态（方案 B）：理由直接进头行，不展开就知道为什么被拒。长理由截断 +
           tooltip 给全文；没填理由就不显示这一项，只留状态徽章。 -->
      <span
        v-if="denial?.reason"
        class="ti-deny-reason"
        v-tooltip="denialReasonTip"
      >{{ denial.reason }}</span>
      <span v-if="denial" class="ti-deny-pill" v-tooltip="denialPillTip">{{ denialLabel }}</span>
      <span
        v-if="bgTask"
        class="ti-bgchip"
        v-tooltip="'命令仍在后台运行——点击打开后台任务面板看实时输出'"
        @click.stop="emit('open-bg-dock', bgTask.id)"
      >● 后台运行中</span>
      <!-- F 方案（Read 接力显示）：接力徽章 + 行号区间。仅 Read 有此元素，
           整文件 @mention 合成卡（无 offset/limit）与其它工具自然不显示；
           选区引用（@path:12-48）带 offset/limit，照常显示行区间。 -->
      <span v-if="block.name === 'Read' && (relayPill || readRange)" class="ti-relay">
        <span
          v-if="relayPill"
          :class="['relay-pill', relayPill.cls]"
          v-tooltip="relayPill.tip"
        >{{ relayPill.text }}</span>
        <span v-if="readRange" class="ti-range">{{ readRange }}</span>
      </span>
      <span v-if="changeInfo" class="ti-diff">
        <span class="stat-add">+{{ changeInfo.addCount }}</span>
        <span v-if="changeInfo.delCount > 0" class="stat-del">-{{ changeInfo.delCount }}</span>
      </span>
      <span
        v-if="changeInfo"
        class="ti-open"
        v-tooltip="'在文件查看器中打开并定位'"
        @click="openChangeFile"
        >打开 ↗</span
      >
      <svg
        :class="['ti-chev', expanded ? 'ti-chev--open' : '']"
        width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
      >
        <path
          d="M2 1.5l4 4.5-4 4.5"
          stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
    </button>
    <div v-if="expanded" class="ti-body">
      <BashOutputBlock v-if="isBash && block.result && !block.truncated" :content="block.result" :is-error="block.isError ?? false" />
      <div
        v-else-if="changeInfo && !block.isPending"
        class="ti-change"
        :style="{ height: `${changeHeight}px` }"
      >
        <DiffViewer :pair="changeInfo.pair" :file-path="changeInfo.filePath" :first-line-number="firstLine ?? undefined" initial-mode="unified" :show-badge="false" />
      </div>
      <div v-else-if="block.truncated" class="ti-truncated">{{ truncatedLabel(block.truncated.originalBytes) }}</div>
      <pre v-else-if="block.result" class="ti-result">{{ block.result }}</pre>
      <div v-else class="ti-pending">等待结果…</div>
    </div>
  </div>
</template>

<style scoped>
/* 工具调用块：GALLERY .toolcall 卡片化头行 + chevron 旋转 + 状态色 */
.tool-item {
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.tool-item + .tool-item {
  margin-top: 10px;
}

.ti-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 4px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}

.ti-row:hover {
  background: var(--aide-surface-default);
}

/* 状态节点：完成灰点 / 失败红点 / 执行中 warning 色 */
.ti-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-surface-active);
  flex-shrink: 0;
}
.ti-dot--err {
  background: var(--aide-danger);
}
.ti-dot--run {
  background: var(--aide-warning);
}
/* 拒绝：琥珀——与"执行中"同色但状态互斥（pending 优先），且始终配「已拒绝」徽章，
   不会和黄色运行中态混淆。红点留给真报错（命令真的跑了、跑失败了）。 */
.ti-dot--deny {
  background: var(--aide-warning);
}

.ti-name {
  font-weight: 600;
  color: var(--aide-text-primary);
  flex-shrink: 0;
  min-width: 38px;
}

.ti-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 左侧省略：长路径保住末尾的文件名（Edit/Write 的 file_path）；
     text-align:left 保证短文本仍靠左、不右漂 */
  direction: rtl;
  text-align: left;
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-muted);
}

/* 头行拒绝理由：路径摘要 flex:1 把它推到右侧紧邻徽章。上限 42% 防止长理由把
   路径挤没，超出省略 + tooltip 全文。 */
.ti-deny-reason {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aide-text-secondary);
}

.ti-deny-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
}

.ti-diff {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: var(--aide-font-mono);
  font-size: 11px;
}
.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }

/* 「后台运行中」徽章：Bash 转入后台运行后钉在头行右侧，点击开 dock 看实时输出 */
.ti-bgchip {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--aide-agent-accent);
  background: color-mix(in srgb, var(--aide-agent-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 25%, transparent);
  white-space: nowrap;
  animation: ti-bgchip-pulse 1.6s infinite;
  transition: background var(--aide-ease-t);
}
.ti-bgchip:hover {
  background: color-mix(in srgb, var(--aide-agent-accent) 20%, transparent);
}
@keyframes ti-bgchip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* F 方案「Read 接力显示」：接力徽章 + 行号区间，钉在头行右侧（ti-diff 的位置——
   Read 无变更统计，不冲突）。徽章几何复用 ti-deny-pill 规格（10.5px 药丸 +
   color-mix 12% 底 25% 描边），success/warning 两色；颜色全走语义 token（F5）。
   warning 色在此的语义=「模型整文件读」，与 deny-pill 的「用户拒绝」、ti-dot--run
   的「执行中」同色系不同义——互斥共存（denial 在场时接力徽章不显示）。 */
.ti-relay {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.relay-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.relay-pill--hit {
  color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-success) 25%, transparent);
}
.relay-pill--miss {
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
}
.ti-range {
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-muted);
  white-space: nowrap;
}

/* 「打开 ↗」：嵌在头行 button 里的短语级链接，stopPropagation 不触发折叠 */
.ti-open {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aide-text-muted);
  padding: 1px 6px;
  border-radius: var(--aide-radius-sm);
  transition: all var(--aide-ease-t);
}
.ti-open:hover {
  color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.ti-chev {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.ti-chev--open {
  transform: rotate(90deg);
}

/* 展开体：GALLERY .tc-body — bg-deep 井 + 内凹 */
.ti-body {
  border-top: 1px solid var(--aide-border-subtle);
  background: var(--aide-bg-deep);
}

/* 变更卡的 DiffViewer 容器：定高（script 按行数估算），内部自滚 */
.ti-change {
  overflow: hidden;
}

.ti-result {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
  margin: 0;
  padding: 11px 14px;
}

.ti-pending {
  padding: 11px 14px;
  font-style: italic;
  color: var(--aide-text-muted);
}
.ti-truncated {
  padding: 11px 14px;
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>

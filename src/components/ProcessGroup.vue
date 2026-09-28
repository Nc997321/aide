<script setup lang="ts">
/**
 * 过程胶囊（ProcessGroup）：定稿消息里 ≥2 个连续过程段（思考/查询工具组/子代理）
 * 合并成的折叠卡——收起（默认）= 一行摘要「过程 | N 段思考 · M 次工具调用」；
 * 展开 = 段内各段按原序渲染。
 *
 * 层级（2026-09-08 精简）：工具组段在过程内直接平铺成逐条 ToolCallBlock，不再套
 * 一层「N 次工具调用」的组内折叠壳。理由：外层"过程"已经折了一层，组内再折
 * 一次意味着看一条命令要连点三次；而中间层承载的信息——总数、类型分布——收起态摘要
 * 已覆盖，单条的类型由 ToolCallBlock 自己的工具名承载，中间层不产生新信息。
 * 2026-09-09：流式期与定稿后的单个工具组段也一并平铺（原走 ChatMessage），
 * 组内折叠壳这条路径全库已不再存在。
 *
 * 只装"过程"：文本块（回复）与变更卡从不在段内——分段层保证（blockSegments.ts
 * 二阶段），这里不做防御。process 段只在定稿后产生，故内部没有流式态要处理
 * （ThinkingBlock 不传 streaming、ToolCallBlock 一律按完成态渲染）。展开状态不
 * 持久化，随窗口化卸载重置。
 */
import { computed, ref } from "vue";
import type { BgTask } from "@/types/chat";
import ToolCallBlock from "./ToolCallBlock.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import { processStats, type Segment } from "@/utils/blockSegments";

const props = defineProps<{
  /** process 段内的原始段（原序）：tool_group / block(thinking) / block(subagent) */
  segments: Segment[];
  /** 后台任务列表（ChatMessage 链透传）——段内 ToolCallBlock 的徽章数据源 */
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  /** 工具卡片徽章点击：打开后台任务 dock 并选中该任务 */
  "open-bg-dock": [taskId: string];
}>();

const expanded = ref(false);

const stats = computed(() => processStats(props.segments));

/** 摘要里逐项列出的工具种类数，超出的合并计数 */
const KINDS_SHOWN = 3;

/** 工具种类：降序取前 KINDS_SHOWN，其余合并成「其余 N 项 ×M」。
 *  不写"N 次工具调用"——每项自带次数、相加即得总数；但被合并的那部分必须保留
 *  次数，否则种类一多总数就加不出来了（这是省掉总数唯一的代价，在此抵消）。 */
const kindsLabel = computed(() => {
  const kinds = stats.value.kinds;
  const top = kinds.slice(0, KINDS_SHOWN).map((k) => `${k.name} ×${k.count}`);
  if (kinds.length <= KINDS_SHOWN) return top.join(" · ");
  const rest = kinds.slice(KINDS_SHOWN);
  const restTotal = rest.reduce((sum, k) => sum + k.count, 0);
  return `${top.join(" · ")} · 其余 ${rest.length} 项 ×${restTotal}`;
});

/** 摘要：「3 段思考 · Bash ×2 · Read ×2 · 1 个子代理」，缺项不出现。
 *  种类分布原先由组内摘要承载——平铺后中间层没了，这条信息上提
 *  到过程行，不能因为删了折叠壳就顺带把"调用了什么"一起删掉。 */
const summary = computed(() => {
  const parts: string[] = [];
  if (stats.value.thinkingCount > 0) parts.push(`${stats.value.thinkingCount} 段思考`);
  if (stats.value.kinds.length > 0) parts.push(kindsLabel.value);
  if (stats.value.subagentCount > 0) parts.push(`${stats.value.subagentCount} 个子代理`);
  return parts.join(" · ");
});
</script>

<template>
  <div class="process-group" :class="{ 'process-group--open': expanded }">
    <button class="pg-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="pg-caret" aria-hidden="true"></span>
      <span class="pg-pill">过程</span>
      <span class="pg-summary" v-tooltip="summary">{{ summary }}</span>
    </button>
    <div v-if="expanded" class="pg-body">
      <template v-for="seg in segments" :key="seg.index">
        <!-- 工具组段：组内逐条平铺，不套折叠壳（见文件头"层级"注释） -->
        <template v-if="seg.kind === 'tool_group'">
          <ToolCallBlock
            v-for="b in seg.blocks"
            :key="b.id"
            :block="b"
            :bg-tasks="bgTasks"
            @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
          />
        </template>
        <ThinkingBlock
          v-else-if="seg.kind === 'block' && seg.block.type === 'thinking'"
          :text="seg.block.text"
        />
        <SubagentCallBlock
          v-else-if="seg.kind === 'block' && seg.block.type === 'subagent'"
          :block="seg.block"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 过程胶囊：视觉沿用工具调用卡的摘要卡语言（bg-base + 细边 + 内高光） */
.process-group {
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-highlight-inset);
  overflow: hidden;
}

.pg-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  cursor: pointer;
  border: 0;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.pg-head:hover {
  background: var(--aide-surface-default);
}

.pg-caret {
  flex-shrink: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--aide-text-muted);
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.pg-head[aria-expanded="true"] .pg-caret {
  transform: rotate(90deg);
}

.pg-pill {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--aide-surface-active);
  border: 1px solid var(--aide-border);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.pg-summary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

/* 展开体：限高内滚（阅读模式，同 ThinkingBlock 非流式的 overflow:auto） */
.pg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--aide-border-subtle);
  padding: 10px 12px;
  max-height: 440px;
  overflow: auto;
}

/* ⚠️ 子项一律不许被压扁 —— 这是「限高内滚」能成立的前提。
   陷阱（2026-09-28 实锤）：flex 子项只要 overflow 不是 visible，其**自动最小高度
   就是 0**（CSS Flexbox §4.5）。段内的子代理块 `.sa` / 工具卡 `.tool-item` 都带
   `overflow: hidden`，于是它们被压到胶囊的剩余空间（~350px）、超出内容被自己的
   overflow:hidden 裁掉；又因为子项被压到刚好装下，本容器**永不溢出** → 不长滚动条、
   没有可滚区域，用户看到的「点开后看不全、滚不动」正是这么来的（转录截图里那行
   被横向切断的文字 + .sa 自己的圆角底边落在切断处，就是「压扁后裁掉」的签名）。
   回归夹具：docs/prototypes/_harness/process-capsule-clip-live.html（PASS/FAIL 自打印）。 */
.pg-body > * {
  flex-shrink: 0;
}

/* 段内纵向间距统一由 .pg-body 的 gap 说了算：清掉 ToolCallBlock 自带的相邻
   margin（.tool-item + .tool-item），否则工具条之间（gap+10px）比工具条与思考块
   之间（gap）宽出一截，平铺后层级看着不齐 */
.pg-body :deep(.tool-item + .tool-item) {
  margin-top: 0;
}

@media (prefers-reduced-motion: reduce) {
  .pg-caret {
    transition: none;
  }
}
</style>

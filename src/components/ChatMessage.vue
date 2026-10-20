<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage, ModelOption, BgTask } from "@/types/chat";
import { SCENE_ACTION_PREFIX } from "@/composables/useChatSession";
import { renderMarkdown } from "@/utils/markdown";
import { truncatedLabel } from "@/utils/messageBytes";
import StreamingText from "./StreamingText.vue";
import ToolCallBlock from "./ToolCallBlock.vue";
import KbRefCard from "./KbRefCard.vue";
import PageRefCard from "./PageRefCard.vue";
import NarrationGroup from "./narration/NarrationGroup.vue";
import NarrationIcon from "./narration/NarrationIcon.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import TurnUsageBadge from "./TurnUsageBadge.vue";
import SubsessionReportCard from "./subsession/SubsessionReportCard.vue";
import WatchReportCard from "./watch/WatchReportCard.vue";
import { segmentBlocks, type Segment } from "@/utils/blockSegments";
import { useFileResolver } from "@/composables/useFileResolver";
import { parseFileLink, shouldOpenExternally } from "@/utils/fileLink";
import { isModelInList } from "@/utils/modelSelect";
import { effortLabel } from "@aide/sdk/utils/effort";
import { handleMarkdownAnchorClick } from "@aide/sdk/utils/markdown";
import { useBtwSession } from "@/composables/useBtwSession";
import { useSettings } from "@/composables/useSettings";

const props = defineProps<{
  message: ChatMessage;
  workspacePath?: string;
  /** 当前会话的可选模型列表——模型徽标的别名建议要在列表里才采用，
   *  否则回退 wire 原文（第三方 sidecar 会建议出 Claude 别名，不在真实
   *  id 列表里，采信会显示用户不认识的值）。 */
  models?: ModelOption[];
  /** 后台任务列表——Bash 工具卡片据此显示「后台运行中」徽章（按 toolUseId 匹配） */
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  /** 工具卡片徽章点击：打开后台任务 dock 并选中该任务 */
  "open-bg-dock": [taskId: string];
}>();

const isUser = computed(() => props.message.role === "user");
const btw = useBtwSession();

/** 模型徽标文案：sidecar 的别名建议在列采信（系统默认 → "sonnet"），
 *  否则用 wire 原文（第三方真实 id，如 kimi-for-coding-highspeed）——
 *  无论如何显示的都是 API 落盘标识，不是模型自报身份。 */
const modelBadge = computed(() => {
  const m = props.message;
  if (isUser.value || !m.model) return "";
  const label = m.modelLabel ?? m.model;
  return isModelInList(props.models ?? [], label) ? label : m.model;
});

/** 本轮 effort 并进模型标注（"k3 · HIGH"）。 */
const modelBadgeTooltip = computed(() => {
  const lines: string[] = [];
  if (modelBadge.value) {
    lines.push("本条回答实际使用的模型（API 落盘标识）——问模型「你是什么模型」得到的自报身份不可靠，以这里为准");
  }
  if (props.message.turnEffort) {
    lines.push(`本轮 effort：${props.message.turnEffort}（回合结束时 API 侧坐实的实际档位，含静默降级）`);
  }
  return lines.join("\n");
});
/** 整条用户消息只有一个 ActionBlock 时，不套铜底气泡——胶囊自身带边框/底色，
 *  套在 accent 实心底上会糊成一团。直接作为右对齐的胶囊落在消息行里。 */
const isActionChip = computed(
  () =>
    isUser.value &&
    props.message.blocks.length === 1 &&
    props.message.blocks[0].type === "action",
);
/** Host 代子会话投递的消息（子会话设计 §8.5-3）：角色是 user（模型那边就是一条用户消息），
 *  但**不是用户说的话**——回报渲染成左侧系统卡片、派来的任务渲染成「来自父会话」气泡，
 *  都不套铜底用户气泡。 */
const subsessionKind = computed<"report" | "instruction" | null>(() => {
  if (!isUser.value || props.message.blocks.length === 0) return null;
  // 值守回报同样是系统卡片（会话自己的值守送来的，不是用户说的话）
  if (props.message.blocks.every((b) => b.type === "subsession_report" || b.type === "watch_report")) return "report";
  if (props.message.blocks.every((b) => b.type === "subsession_instruction")) return "instruction";
  return null;
});

const rowClass = computed(() =>
  isUser.value && !subsessionKind.value ? "msg-row--user" : "msg-row--assistant",
);

const wrapClass = computed(() => {
  if (subsessionKind.value === "report") return "msg-turn msg-subsession-reports";
  if (subsessionKind.value === "instruction") return "msg-bubble msg-bubble--parent";
  if (isActionChip.value) return "msg-action-wrap";
  return isUser.value ? "msg-bubble msg-bubble--user" : "msg-turn";
});

const { openResolved } = useFileResolver();
const { settings } = useSettings();

/** user 消息不分组（@mention 的 tool_call 是附件展示，保持逐条）；assistant 消息走
 *  segmentBlocks：相邻同类工具调用合成一句旁白，思考按「显示思考过程」开关显示或隐藏
 *  （见 blockSegments.ts 文件头）。 */
const segments = computed<Segment[]>(() =>
  isUser.value
    ? props.message.blocks.map((block, index) => ({ kind: "block" as const, block, index }))
    : segmentBlocks(props.message.blocks, {
        finalized: !props.message.streaming,
        showThinking: settings.showThinking,
      }),
);

// 只响应渲染期已判定为文件的 code（见 utils/markdown.ts codespan 渲染器 +
// utils/fileLink.ts 判定规则），点击层不再自己做路径识别。openResolved 会先探测
// 路径是否存在，不存在时在工作区内搜索（带加载态，多命中弹选择框）。
/** 该 block 是否是消息最后一块且消息还在流式——流式尾块判定。index 是原 blocks
 *  下标（segmentBlocks 保留 Segment.index），不是 segments 下标（tool_group 聚合
 *  后 segments.length ≠ blocks.length）。文本流式尾块、思考流式期判定共用。 */
function isStreamingTail(index: number): boolean {
  return !!props.message.streaming && index === props.message.blocks.length - 1;
}

function handleTextClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // 回复里的 `[x](#标题)`：只在本条消息内找标题
  if (handleMarkdownAnchorClick(e, target.closest(".msg-row"))) return;

  const anchorEl = target.closest("a[href]");
  const href = anchorEl?.getAttribute("href")?.trim() ?? "";
  if (href && shouldOpenExternally(href)) {
    e.preventDefault();
    e.stopPropagation();
    void openResolved(href, props.workspacePath);
    return;
  }

  // 回复里的本地图片：点开用文件查看器看大图
  const localImg = target.closest<HTMLElement>("img.aide-local-img");
  if (localImg?.dataset.aideSrc) {
    void openResolved(localImg.dataset.aideSrc, props.workspacePath);
    return;
  }

  const codeEl = target.closest("code.aide-file-link");
  if (!codeEl) return;
  const link = parseFileLink(codeEl.textContent?.trim() ?? "");
  if (!link) return;
  void openResolved(link.path, props.workspacePath, link.line);
}
</script>

<template>
  <!-- data-msg-id：变更面板「定位」按它找气泡（useChatScroll 的 findMessageEl，
       量位置与加高亮脉冲都走它）。测高只认 data-row-id，加这个不会多付测量成本。 -->
  <div
    :class="['msg-row', rowClass]"
    :data-msg-id="message.id"
  >
    <div :class="wrapClass">
      <template v-for="seg in segments" :key="seg.index">
        <!-- 旁白段：一次调用 = 一行 ToolCallBlock（头行就是一句话，点开看细节）；相邻同类
             多次 = 合成一句的 NarrationGroup（点开逐条）。消息尾那段是「当前这一步」。 -->
        <template v-if="seg.kind === 'narration'">
          <ToolCallBlock
            v-if="seg.blocks.length === 1"
            :block="seg.blocks[0]"
            :current="seg.current"
            :workspace-path="workspacePath"
            :bg-tasks="bgTasks"
            @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
          />
          <NarrationGroup
            v-else
            :blocks="seg.blocks"
            :workspace-path="workspacePath"
            :bg-tasks="bgTasks"
            @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
          />
        </template>
        <!-- 思考被隐藏（默认）时，模型正在思考的那一刻只留一行提示，免得像卡住了 -->
        <div v-else-if="seg.kind === 'thinking_live'" class="msg-thinking-live narr-row">
          <span class="msg-thinking-icon"><NarrationIcon name="bulb" /></span>
          <span class="aide-narr-live">正在思考…</span>
        </div>
        <!-- 正文渲染收进 StreamingText（分段 + 渐显波；@click 靠单根 fallthrough
             落到 .msg-text 上，与工具块的文件码点击共用 handleTextClick）。 -->
        <StreamingText
          v-else-if="seg.block.type === 'text'"
          :text="seg.block.text"
          :streaming="isStreamingTail(seg.index)"
          :workspace-path="workspacePath"
          @click="handleTextClick"
        />
        <ThinkingBlock
          v-else-if="seg.block.type === 'thinking'"
          :text="seg.block.text"
          :truncated="seg.block.truncated"
          :streaming="isStreamingTail(seg.index)"
        />
        <ToolCallBlock
          v-else-if="seg.block.type === 'tool_call'"
          :block="seg.block"
          :card="isUser"
          :workspace-path="workspacePath"
          :bg-tasks="bgTasks"
          @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
        />
        <!-- btw 批注 = 侧栏书签：点开 btw 侧栏并定位到这一轮（侧栏才是看回复的地方）。
             线程已不在（关过 tab 等）时退回下面的原地展开。 -->
        <div
          v-else-if="seg.block.type === 'action' && seg.block.actionId === 'btw' && seg.block.btwRoundId && btw.hasRound(seg.block.btwRoundId)"
          class="msg-row--note"
        >
          <button
            type="button"
            class="btw-note btw-note-head btw-note--link"
            v-tooltip="'在侧栏中查看这条回复'"
            @click="btw.openRound(seg.block.btwRoundId)"
          >
            <span class="btw-note-glyph">{{ seg.block.icon || "↳" }}</span>
            <span class="btw-note-tag">btw</span>
            <span class="btw-note-q">{{ seg.block.label }}</span>
            <span class="btw-note-go" aria-hidden="true">›</span>
          </button>
        </div>
        <!-- btw/任务支线页边批注：可折叠、视觉权重远低于真实消息，读起来是"贴在边上的便签" -->
        <div
          v-else-if="seg.block.type === 'action' && (seg.block.actionId === 'btw' || seg.block.actionId === 'git-commit')"
          class="msg-row--note"
        >
          <details class="btw-note">
            <summary class="btw-note-head">
              <span class="btw-note-caret tri"></span>
              <span class="btw-note-glyph tri">{{ seg.block.icon || "↳" }}</span>
              <span class="btw-note-tag">{{ seg.block.actionId === "btw" ? "btw" : seg.block.label }}</span>
              <span class="btw-note-q">{{ seg.block.actionId === "btw" ? seg.block.label : "" }}</span>
            </summary>
            <div class="btw-note-body">
              <!-- 批注正文是已定稿的支线结论：与主文本块同一渲染管道
                   （renderMarkdown 缓存 + msg-text 样式），文件码span 同样可点。 -->
              <div
                class="msg-text"
                v-html="renderMarkdown(seg.block.body ?? '')"
                @click="handleTextClick"
              ></div>
              <div class="btw-note-warn">↳ 这是支线结论,不会进入主对话上下文。</div>
            </div>
          </details>
        </div>
        <!-- 场景标签（欢迎页选的场景）：跟在气泡正文前的一枚小标签 -->
        <span
          v-else-if="seg.block.type === 'action' && seg.block.actionId.startsWith(SCENE_ACTION_PREFIX)"
          class="msg-scene-tag"
        >
          <span v-if="seg.block.icon" class="msg-scene-tag-icon">{{ seg.block.icon }}</span>{{ seg.block.label }}
        </span>
        <!-- 原 action 药丸(压缩/清空上下文) -->
        <span
          v-else-if="seg.block.type === 'action'"
          class="msg-action-chip"
        >
          <span v-if="seg.block.icon" class="msg-action-chip-icon">{{ seg.block.icon }}</span>
          <span class="msg-action-chip-label">{{ seg.block.label }}</span>
        </span>
        <div
          v-else-if="seg.block.type === 'image' && seg.block.truncated"
          class="msg-image-truncated"
        >{{ truncatedLabel(seg.block.truncated.originalBytes) }}</div>
        <img
          v-else-if="seg.block.type === 'image'"
          :src="`data:${seg.block.mediaType};base64,${seg.block.data}`"
          class="msg-image"
          alt="附图"
        />
        <SubagentCallBlock
          v-else-if="seg.block.type === 'subagent'"
          :block="seg.block"
        />
        <!-- 用户在知识库文档 / 网页里圈选的一处（+ 意见）：折叠卡片，点开看被圈的原文 -->
        <KbRefCard v-else-if="seg.block.type === 'kbref'" :block="seg.block" />
        <PageRefCard v-else-if="seg.block.type === 'pageref'" :block="seg.block" />
        <!-- 子会话回报（父会话里）/ 父会话派来的任务（子会话里）：Host 投递，不是用户说的话 -->
        <SubsessionReportCard v-else-if="seg.block.type === 'subsession_report'" :block="seg.block" />
        <!-- 值守回报：会话的值守发现变化 / 结束时送来，不是用户说的话 -->
        <WatchReportCard v-else-if="seg.block.type === 'watch_report'" :block="seg.block" />
        <template v-else-if="seg.block.type === 'subsession_instruction'">
          <div class="msg-parent-head">
            {{ seg.block.by === "user" ? "你从父会话" : "来自父会话" }}{{ seg.block.parentTitle ? `「${seg.block.parentTitle}」` : "" }} · {{ seg.block.kind === "task" ? (seg.block.by === "user" ? "派来的任务" : "任务") : "追加指令" }}
          </div>
          <div class="msg-text" v-html="renderMarkdown(seg.block.text)" @click="handleTextClick"></div>
        </template>
      </template>
      <div v-if="!isUser && (modelBadge || message.turnEffort || message.usage)" class="msg-meta">
        <span
          v-if="modelBadge || message.turnEffort"
          class="msg-model"
          v-tooltip="modelBadgeTooltip"
        >{{ modelBadge }}<span
          v-if="message.turnEffort"
          class="msg-model-effort"
        >{{ modelBadge ? "· " : "" }}{{ effortLabel(message.turnEffort) }}</span></span>
        <TurnUsageBadge v-if="message.usage" class="msg-usage" :usage="message.usage" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  padding: 4px 12px;
}

.msg-row--user {
  justify-content: flex-end;
}

.msg-row--assistant {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 85%;
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

/* 用户气泡：GALLERY「聊天碎片」——渐变浮起表面 + 顶光内描边 + 不对称左下圆角 */
.msg-bubble--user {
  background: linear-gradient(180deg, var(--aide-surface-default), var(--aide-bg-raised));
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-lg) var(--aide-radius-lg) var(--aide-radius-lg) 5px;
  color: var(--aide-text-primary);
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
}

/* 父会话派来的任务 / 追加指令（子会话里）：左对齐、info 色描边、左上角收尖——
 * 一眼与用户自己说的话（右侧铜底气泡）分开。 */
.msg-bubble--parent {
  max-width: 90%;
  background: color-mix(in srgb, var(--aide-info) 7%, var(--aide-bg-base));
  border: 1px solid color-mix(in srgb, var(--aide-info) 30%, var(--aide-border));
  border-radius: 5px var(--aide-radius-lg) var(--aide-radius-lg) var(--aide-radius-lg);
  color: var(--aide-text-primary);
}
.msg-parent-head {
  margin-bottom: 4px;
  font-size: 11.5px;
  color: var(--aide-info);
}
/* 子会话回报（父会话里）：系统卡片一列，满宽 */
.msg-subsession-reports {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 动作胶囊（压缩/清空上下文等）：区别于普通用户气泡——半透明 accent 底 + accent
 * 描边 + accent 文字，圆角药丸。底色由 accent token 派生（color-mix），不硬编码 hex。 */
.msg-action-wrap {
  display: inline-flex;
  max-width: 85%;
}

.msg-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 15%, transparent);
  color: var(--aide-accent);
  font-size: 13px;
  line-height: 1.6;
  user-select: text;
  -webkit-user-select: text;
}

/* 场景标签：落在用户气泡的实心底上，用气泡文字色的半透明底，不另起一套强调色 */
.msg-scene-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  margin-bottom: 6px;
  padding: 1px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 16%, transparent);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: nowrap;
}
.msg-scene-tag-icon {
  font-size: 11px;
}

.msg-action-chip-icon {
  font-size: 12px;
  opacity: 0.9;
}

.msg-action-chip-label {
  white-space: nowrap;
}

/* App.vue 的 .app-layout 为防止拖拽分栏/标签时误选界面文字，全局设了
 * user-select: none；该属性可继承，会一路传导到消息正文导致整段对话
 * 都无法选中复制。这里在消息容器局部恢复，子内容（代码块、工具调用块等）
 * 会随继承一并变回可选，不影响其余界面元素的防误选行为。 */
.msg-bubble,
.msg-turn {
  user-select: text;
  -webkit-user-select: text;
}

/* 通页书脊（spec·B2）：assistant 正文直接落在页面上，
 * 一条铜色书脊纵贯整个回合（正文 + 工具墨线 + 用量）。 */
.msg-turn {
  max-width: 94%;
  min-width: 0;
  border-left: 2px solid color-mix(in srgb, var(--aide-accent) 45%, transparent);
  padding: 2px 0 2px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--aide-text-primary);
  word-break: break-word;
}

/* 纵向间距统一由 .msg-turn 的 gap 说了算：清掉 ToolCallBlock 自带的相邻 margin。 */
.msg-turn :deep(.tool-item + .tool-item) {
  margin-top: 0;
}
/* 连续几句旁白读起来是一段，行距收紧（gap 8px → 2px）；与正文之间仍是 8px */
.msg-turn > :deep(.narr-row + .narr-row) {
  margin-top: -6px;
}

.msg-thinking-live {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  line-height: 1.6;
  padding: 2px 0;
}
.msg-thinking-icon {
  display: inline-flex;
  color: var(--aide-accent);
}

/* .msg-text 的 Markdown 正文样式已提到 styles/global.css（btw 抽屉共用）——
   选择器与这里原本的一致，只是从 scoped :deep 变成全局后代选择器。 */

.msg-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/* 模型标注（2026-10-17 去徽章）：元数据是一条消息里最安静的一层——与用量同为灰色小字，
   不加底色、边框、强调色。 */
.msg-model {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  white-space: nowrap;
}

.msg-meta .msg-usage {
  margin-top: 0;
}

/* 用量行：GALLERY 要求 tabular-nums */
.msg-usage {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

.msg-image {
  max-width: 100%;
  max-height: 300px;
  border-radius: var(--aide-radius-sm);
  display: block;
  margin: 4px 0;
  cursor: pointer;
}
.msg-image-truncated {
  margin: 4px 0;
  padding: 8px 12px;
  font-style: italic;
  font-size: 12px;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
}

/* btw 页边批注：右对齐、默认折叠。
   不在此设百分比 max-width：批注走 .msg-action-wrap(inline-flex)分支，宽度按内容
   撑开、无外部基准，百分比 max-width 的基准会自指 .btw-note 自身撑开的
   .msg-row--note，把容器压到比内容还窄、head 标签被 overflow:hidden 截断。宽度
   上限交由 .msg-action-wrap 的 max-width:85%（基准=消息区，正确）兜底。 */
/* min-width:0（.msg-row--note 与 .btw-note 两层都要）：问题文字是单行不换行，弹性项默认
   min-width:auto 会按整句单行宽度当最小宽度，长问题把批注撑出内容列、整条对话横向滚动。 */
.msg-row--note { display: flex; justify-content: flex-end; padding: 2px 12px; min-width: 0; }
/* 2026-10-17 去装饰：收起态与过程行同一语法——一行灰字、悬停浮底色，不要虚线框、
   accent 底色和描边药丸（批注是附属物，视觉重量要低于正文）。展开后才给一层浅底，
   让右侧浮着的结论有个落脚处。 */
.btw-note { border-radius: var(--aide-radius-md); overflow: hidden; min-width: 0; }
.btw-note[open] { background: var(--aide-surface-default); }
.btw-note-head {
  display: flex; align-items: center; gap: 7px; padding: 3px 8px; cursor: pointer;
  list-style: none; font-size: 12px; color: var(--aide-text-muted);
  border-radius: var(--aide-radius-md);
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.btw-note-head:hover { background: var(--aide-surface-hover); color: var(--aide-text-secondary); }
.btw-note-head::-webkit-details-marker { display: none; }
/* 收起朝右、展开朝下，与过程行 / 思考块的折叠三角一致 */
.btw-note-caret {
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor; opacity: 0.7; transition: transform var(--aide-ease-t);
}
.btw-note[open] .btw-note-caret { transform: rotate(90deg); }
.btw-note-tag {
  /* 永不换行、不收缩：含中文 label（如 git-commit 的「Git 提交」)时，flex item 默认
     min-width:auto 会收缩到 min-content（latin 词宽），把中文挤成竖排三行。 */
  white-space: nowrap; flex-shrink: 0;
}
.btw-note-q { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btw-note-q:not(:empty)::before { content: "· "; }
/* 书签版（点开侧栏）：去掉 button 默认外观，尾部一个 › 示意「去别处看」 */
.btw-note--link { border: 0; background: transparent; font: inherit; text-align: left; max-width: 100%; }
.btw-note-go { flex: none; opacity: 0.7; }
.btw-note-body { padding: 2px 12px 9px; font-size: 12px; line-height: 1.6; color: var(--aide-text-secondary); }
.btw-note-warn { font-size: 11px; color: var(--aide-text-muted); margin-top: 7px; }
</style>

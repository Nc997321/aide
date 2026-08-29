<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatMessage, ContentBlock, SubagentBlock, ToolCallBlock, TurnUsage } from "@aide/sdk/types/chat";
import { renderMarkdown, renderStreaming } from "@aide/sdk/utils/markdown";

const props = defineProps<{
  messages: ChatMessage[];
  streaming: boolean; // 会话生成中（isBusy）→ 光标 / 思考中
  sysNote: string | null; // 重连分隔线（m-sys）
}>();

const scrollEl = ref<HTMLElement | null>(null);

const GAP_MS = 10 * 60_000; // 时间分隔线阈值

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

function showTime(i: number): boolean {
  const prev = props.messages[i - 1];
  const cur = props.messages[i];
  if (!cur) return false;
  if (!prev) return true;
  return cur.timestamp - prev.timestamp > GAP_MS;
}

function userText(m: ChatMessage): string {
  return m.blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** 流式尾块判定：生成中 + 末条消息 + 末个块——该块用非高亮渲染（hljs O(n²) 放大器，
 *  见 utils/markdown.ts）；定稿块走 renderMarkdown（缓存 + 高亮一次）。 */
function isStreamingTail(m: ChatMessage, bi: number): boolean {
  const last = props.messages[props.messages.length - 1];
  return props.streaming && m.id === last?.id && bi === m.blocks.length - 1;
}

function renderText(m: ChatMessage, bi: number, text: string): string {
  return isStreamingTail(m, bi) ? renderStreaming(text) : renderMarkdown(text);
}

function showCursor(m: ChatMessage, bi: number): boolean {
  const b = m.blocks[bi];
  return isStreamingTail(m, bi) && b?.type === "text";
}

// 思考块"思考中"态：流式进行中且是末条消息的末个块
function isLiveThinking(m: ChatMessage, bi: number): boolean {
  const b = m.blocks[bi];
  return isStreamingTail(m, bi) && b?.type === "thinking";
}

// 工具块：一行摘要 arg（file_path/command/pattern 优先）
function toolArg(b: ToolCallBlock): string {
  const input = b.input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>; // 工具输入是 sidecar 透传的 JSON
  for (const k of ["file_path", "command", "pattern", "path", "url"]) {
    const v = rec[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function toolInput(b: ToolCallBlock): string {
  if (typeof b.input === "string") return b.input;
  try {
    return JSON.stringify(b.input, null, 2);
  } catch {
    return String(b.input);
  }
}

function toolStatusClass(b: ToolCallBlock): string {
  if (b.isPending) return "run";
  return b.isError ? "err" : "ok";
}

function toolStatusText(b: ToolCallBlock): string {
  if (b.isPending) return "进行中";
  return b.isError ? "✗ 失败" : "✓ 成功";
}

/** 子代理块的状态行（PWA 极简版：一行摘要 + 结果折叠；时间线明细留在桌面）。 */
function subagentLine(b: SubagentBlock): string {
  if (b.isPending) return b.asyncLaunched ? "后台运行中" : "运行中";
  return b.isError ? "失败" : "完成";
}

// usage 尾注：X tok · cache N% · effort X（TurnUsage 类型化；字段缺失则省略）
function usageLine(m: ChatMessage): string | null {
  const u: TurnUsage | undefined = m.usage;
  const parts: string[] = [];
  if (u) {
    const total = u.inputTokens + u.outputTokens;
    if (total > 0) parts.push(`${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total} tok`);
    if (u.inputTokens > 0 && u.cacheReadInputTokens > 0) {
      parts.push(`cache ${Math.round((u.cacheReadInputTokens / u.inputTokens) * 100)}%`);
    }
  }
  if (m.turnEffort) parts.push(`effort ${m.turnEffort}`);
  return parts.length ? parts.join(" · ") : null;
}

// 自动滚到底（流式增量 / 历史加载 / 重连分隔线）
function scrollBottom(): void {
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
watch(
  () => props.messages,
  () => nextTick(scrollBottom),
  { deep: true },
);
watch(
  () => props.sysNote,
  () => nextTick(scrollBottom),
);
</script>

<template>
  <div ref="scrollEl" class="ch-msgs">
    <template v-for="(m, i) in messages" :key="m.id">
      <div v-if="showTime(i)" class="m-time">{{ timeLabel(m.timestamp) }}</div>

      <!-- 页折叠占位（内存回收的骨架行）：PWA 不挂滚动恢复观察器，展示原样一行 -->
      <div v-if="m.markerFor" class="m-sys">↑ 更早的消息已折叠（重新进入会话可恢复）</div>

      <div v-else-if="m.role === 'user'" class="m-row user">
        <div class="m-bubble-user">{{ userText(m) }}</div>
      </div>

      <div v-else class="m-row">
        <div class="m-assistant">
          <template v-for="(b, bi) in m.blocks" :key="bi">
            <!-- 思考块（折叠） -->
            <details v-if="b.type === 'thinking'" class="blk">
              <summary>
                <span class="caret"></span>
                <span class="blk-label">{{ isLiveThinking(m, bi) ? "思考中" : "思考过程" }}</span>
                <span v-if="isLiveThinking(m, bi)" class="spinner" style="width: 9px; height: 9px; border-width: 1.5px"></span>
              </summary>
              <div class="blk-body-think">
                {{ b.text }}<span v-if="isLiveThinking(m, bi)" class="cursor"></span>
              </div>
            </details>

            <!-- 工具调用块（折叠卡） -->
            <details v-else-if="b.type === 'tool_call'" class="tool">
              <summary>
                <span class="caret"></span>
                <span class="tool-ic">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10.7 2.3a3.4 3.4 0 0 0-4.5 4.4L2.5 10.4a1.7 1.7 0 1 0 2.4 2.4l3.7-3.7a3.4 3.4 0 0 0 4.4-4.5l-2.3 2.3-1.9-.5-.5-1.9 2.4-2.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
                </span>
                <span class="tool-name">{{ b.name }}</span>
                <span class="tool-arg">{{ toolArg(b) }}</span>
                <span class="tool-st" :class="toolStatusClass(b)">
                  <span v-if="b.isPending" class="spinner"></span>{{ toolStatusText(b) }}
                </span>
              </summary>
              <div class="tool-body">
                <div class="tool-kv"><div class="k">输入</div><pre>{{ toolInput(b) }}</pre></div>
                <div v-if="b.result != null" class="tool-kv">
                  <div class="k">结果</div><pre :class="{ err: b.isError }">{{ b.result }}</pre>
                </div>
              </div>
            </details>

            <!-- 子代理块（极简：摘要行 + 结果折叠） -->
            <details v-else-if="b.type === 'subagent'" class="tool">
              <summary>
                <span class="caret"></span>
                <span class="a-ic">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.8 4.2L14 6l-3 3.1.7 4.4L8 11.4l-3.7 2.1.7-4.4-3-3.1 4.2-.8L8 1z"/></svg>
                </span>
                <b>{{ b.agentName }}</b>
                <span class="tool-arg">{{ b.description }}</span>
                <span class="tool-st" :class="b.isPending ? 'run' : b.isError ? 'err' : 'ok'">
                  <span v-if="b.isPending" class="spinner"></span>{{ subagentLine(b) }}
                </span>
              </summary>
              <div v-if="b.result" class="tool-body">
                <div class="tool-kv"><div class="k">结论</div><pre>{{ b.result }}</pre></div>
              </div>
            </details>

            <!-- 动作胶囊（/compact、btw 批注等用户侧动作） -->
            <details v-else-if="b.type === 'action' && b.foldable" class="tool">
              <summary>
                <span class="caret"></span><span>{{ b.icon ?? "⌾" }} {{ b.label }}</span>
              </summary>
              <div v-if="b.body" class="tool-body"><div class="tool-kv"><pre>{{ b.body }}</pre></div></div>
            </details>
            <div v-else-if="b.type === 'action'" class="m-action">{{ b.icon ?? "" }} {{ b.label }}</div>

            <!-- 图片块 -->
            <img v-else-if="b.type === 'image'" class="m-img" :src="`data:${b.mediaType};base64,${b.data}`" :alt="b.mediaType" />

            <!-- 文本块（markdown 渲染；流式尾块不高亮 + 光标跟在文本后） -->
            <!-- 内容来自本会话模型输出（自有数据源），与桌面同一渲染管线 -->
            <div v-else-if="b.type === 'text'" class="m-text md"><span v-html="renderText(m, bi, b.text)"></span><span v-if="showCursor(m, bi)" class="cursor"></span></div>
          </template>

          <div v-if="usageLine(m)" class="m-usage">{{ usageLine(m) }}</div>
        </div>
      </div>
    </template>

    <div v-if="sysNote" class="m-sys">{{ sysNote }}</div>
  </div>
</template>

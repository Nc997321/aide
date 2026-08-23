<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { Block, Message } from "../session";

const props = defineProps<{
  messages: Message[];
  streaming: boolean; // 末条 assistant 未 done → 光标 / 思考中
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
  if (i === 0) return true;
  return props.messages[i].timestamp - props.messages[i - 1].timestamp > GAP_MS;
}

function userText(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// 流式光标：末条消息的末个文本块
function showCursor(m: Message, bi: number): boolean {
  return (
    props.streaming &&
    m === props.messages[props.messages.length - 1] &&
    bi === m.blocks.length - 1 &&
    m.blocks[bi].type === "text"
  );
}

// 思考块"思考中"态：流式进行中且是末条消息的末个块
function isLiveThinking(m: Message, bi: number): boolean {
  return (
    props.streaming &&
    m === props.messages[props.messages.length - 1] &&
    bi === m.blocks.length - 1 &&
    m.blocks[bi].type === "thinking"
  );
}

// 工具块：一行摘要 arg（file_path/command/pattern 优先）
function toolArg(b: Extract<Block, { type: "tool_call" }>): string {
  const input = b.input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const k of ["file_path", "command", "pattern", "path", "url"]) {
    if (typeof rec[k] === "string" && rec[k]) return rec[k] as string;
  }
  return "";
}

function toolInput(b: Extract<Block, { type: "tool_call" }>): string {
  if (typeof b.input === "string") return b.input;
  try {
    return JSON.stringify(b.input, null, 2);
  } catch {
    return String(b.input);
  }
}

function toolStatusClass(b: Extract<Block, { type: "tool_call" }>): string {
  if (b.isPending) return "run";
  return b.isError ? "err" : "ok";
}

function toolStatusText(b: Extract<Block, { type: "tool_call" }>): string {
  if (b.isPending) return "进行中";
  return b.isError ? "✗ 失败" : "✓ 成功";
}

// usage 尾注：X tok · cache N% · effort X（对齐原型格式，字段缺失则省略）
function usageLine(m: Message): string | null {
  const u = m.usage;
  const parts: string[] = [];
  if (u && typeof u === "object") {
    const rec = u as Record<string, unknown>;
    const num = (k: string) => (typeof rec[k] === "number" ? (rec[k] as number) : undefined);
    const input = num("input_tokens");
    const output = num("output_tokens");
    const cache = num("cache_read_input_tokens");
    if (input != null || output != null) {
      const total = (input ?? 0) + (output ?? 0);
      parts.push(`${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total} tok`);
    }
    if (cache != null && input != null && input > 0) {
      parts.push(`cache ${Math.round((cache / input) * 100)}%`);
    }
  }
  if (m.effort) parts.push(`effort ${m.effort}`);
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

      <div v-if="m.role === 'user'" class="m-row user">
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

            <!-- 子代理块（一行摘要） -->
            <div v-else-if="b.type === 'subagent'" class="agent-line">
              <span class="a-ic">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.8 4.2L14 6l-3 3.1.7 4.4L8 11.4l-3.7 2.1.7-4.4-3-3.1 4.2-.8L8 1z"/></svg>
              </span>
              <b>{{ b.agentName }}</b><span>{{ b.description }}</span>
            </div>

            <!-- 错误块 -->
            <div v-else-if="b.type === 'error'" class="m-error">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.8L14 4v4c0 3.4-2.5 5.7-6 6.8C4.5 13.7 2 11.4 2 8V4l6-2.2z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 5.2v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="10.6" r=".9" fill="currentColor"/></svg>
              <span>{{ b.text }}</span>
            </div>

            <!-- 图片块（协议 image 事件，最小实现） -->
            <img v-else-if="b.type === 'image'" class="m-img" :src="b.data" :alt="b.mediaType" />

            <!-- 文本块（流式逐字 + 光标） -->
            <div v-else-if="b.type === 'text'" class="m-text">
              {{ b.text }}<span v-if="showCursor(m, bi)" class="cursor"></span>
            </div>
          </template>

          <div v-if="usageLine(m)" class="m-usage">{{ usageLine(m) }}</div>
        </div>
      </div>
    </template>

    <div v-if="sysNote" class="m-sys">{{ sysNote }}</div>
  </div>
</template>

/**
 * 对话区降噪 · 展示夹具（2026-10-17）。
 *
 * 挂**真实**的 ChatMessage（内含 ProcessGroup / ThinkingBlock / 模型标注）与输入框下方
 * 状态行的两个控件（ThemedSelect compact / ModelEffortPicker），用来看这轮改动：
 * 过程行去卡片、思考块去竖线与斜体、模型标注降成灰字、状态行控件静止时融进背景。
 *
 * 复跑：cd aide && npx vite --port 5199
 *   → http://localhost:5199/docs/prototypes/_harness/chat-quiet-meta-live.html
 *   URL 加 ?theme=warm-dark / smoky-pink-glass 切主题（默认 glass）。
 */
import { createApp, h, ref } from "vue";
import "../../../src/styles/global.css";
import { applyTheme, themes } from "../../../src/themes";
import { vTooltip } from "../../../src/directives/tooltip";
import ChatMessage from "../../../src/components/ChatMessage.vue";
import ThemedSelect from "../../../src/components/ThemedSelect.vue";
import ModelEffortPicker from "../../../src/components/ChatPanel/ModelEffortPicker.vue";
import ThinkingLine from "../../../src/components/ChatPanel/ThinkingLine.vue";
import ActivityStrip from "../../../src/components/activity/ActivityStrip.vue";
import type { ActivityChip } from "../../../src/components/activity/activityChips";
import type { ChatMessage as Msg, ContentBlock } from "../../../src/types/chat";

const themeName = new URLSearchParams(location.search).get("theme") ?? "glass";
applyTheme(themes[themeName] ?? themes.glass);

const bash = (id: string, command: string, result: string): ContentBlock => ({
  type: "tool_call",
  id,
  name: "Bash",
  input: { command },
  result,
  isPending: false,
});

const user: Msg = {
  id: "u1",
  role: "user",
  timestamp: Date.now(),
  blocks: [{ type: "text", text: "我总觉得现在 UI 给我的感觉不是很高级，你看看是哪里的问题？" }],
};

const assistant: Msg = {
  id: "a1",
  role: "assistant",
  timestamp: Date.now(),
  model: "claude-opus-5-5",
  turnEffort: "medium",
  usage: { inputTokens: 18234, outputTokens: 1420, cacheReadInputTokens: 120000, cacheCreationInputTokens: 0, costUsd: 0.21 },
  blocks: [
    { type: "thinking", text: "先看全局字体和主题配置，再看对话区几个组件的样式。" },
    bash("t1", "grep -rn \"font-family\" src/styles", "src/styles/global.css:102:  font-family: var(--aide-font-ui);"),
    { type: "thinking", text: "界面字体栈第一位是等宽字体，这是正文显得像终端的主因。" },
    bash("t2", "sed -n 370,400p src/components/ChatMessage.vue", ".msg-turn {\n  border-left: 2px solid …;\n}"),
    bash("t3", "cat src/components/ProcessGroup.vue", "<template>…</template>"),
    { type: "text", text: "我先把底下那两个胶囊改成 Claude 那种「平时是纯文字、悬停才出底色」的样式，字体的事随后说。" },
    {
      type: "thinking",
      text: "For PingFang specifically, I'd recommend not bundling it and instead relying on system CJK fallbacks — PingFang SC on Mac, Microsoft YaHei UI on Windows, Noto Sans CJK SC on Linux — alongside the already-bundled Inter.\n\n过程信息的视觉重量要低于正文：内容 > 过程 > 元数据。",
    },
    {
      type: "text",
      text: "## 总结成一条原则\n\n**层级 = 内容 > 过程 > 元数据，视觉重量也要按这个顺序递减。** 现在正好反过来了：越是附属的东西，装饰越多。\n\n- 「过程」卡片改成无框的一行灰字\n- 思考块去掉内层竖线和斜体\n- 模型标签降成灰色小字",
    },
  ],
};

const bgChip: ActivityChip = { tab: "bg" as ActivityChip["tab"], label: "后台", tone: "run", running: 1, title: "", open: false };
/** 活动带两种状态：消息流末尾的「正在思考」看得见（strip 只剩 chip） / 往上翻走了（strip 亮出「思考中」） */
const scrolledAway = ref(new URLSearchParams(location.search).has("away"));

/** btw 批注：支线答完后插进主对话的那条（默认折叠） */
const btwNote: Msg = {
  id: "n1",
  role: "user",
  timestamp: Date.now(),
  blocks: [
    {
      type: "action",
      actionId: "btw",
      icon: "↳",
      label: "4:5 的兜底比例是做什么用的？",
      foldable: true,
      body: "图片还没加载出来时，先按 4:5 给每张商品卡**预留高度**，避免图片到达后把下面的内容往下挤。",
    },
  ],
};

const mode = ref("auto");
const model = ref("opus");
const effort = ref("medium");

const host = document.getElementById("app")!;
host.style.cssText = "max-width:960px;margin:24px auto;padding:0 16px;font-family:var(--aide-font-ui);color:var(--aide-text-primary)";

createApp({
  render: () =>
    h("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
      h(ChatMessage, { message: user }),
      h(ChatMessage, { message: assistant }),
      h(ChatMessage, { message: btwNote }),
      h(ThinkingLine, { active: !scrolledAway.value, elapsedSeconds: 26, tip: null }),
      // 输入框 + 下方状态行（只摆外观，结构同 ChatInputBox 的 .chat-input-box / .composer-foot）
      h("div", { style: "margin:24px 12px 0" }, [
        h(ActivityStrip, {
          compaction: null,
          thinking: true,
          thinkingLabel: scrolledAway.value,
          elapsedSeconds: 24,
          tip: null,
          chips: [bgChip],
        }),
        h(
          "div",
          {
            style:
              "display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--aide-radius-lg);background:var(--aide-bg-deep);border:1px solid var(--aide-border);color:var(--aide-text-muted);font-size:13px",
          },
          "输入消息…",
        ),
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;padding:4px 2px 0;font-size:12px" }, [
          h(ThemedSelect, {
            compact: true,
            modelValue: mode.value,
            options: [
              { value: "auto", label: "自动模式" },
              { value: "default", label: "逐项确认" },
            ],
            title: "权限模式",
            "onUpdate:modelValue": (v: string) => (mode.value = v),
          }),
          h(ModelEffortPicker, {
            models: [
              { value: "opus", label: "Opus 5.5" },
              { value: "sonnet", label: "Sonnet 5.5" },
            ],
            model: model.value,
            efforts: [
              { value: "low", label: "快速" },
              { value: "medium", label: "进阶" },
              { value: "high", label: "极致" },
            ],
            effort: effort.value,
            "onUpdate:model": (v: string) => (model.value = v),
            "onUpdate:effort": (v: string) => (effort.value = v),
          }),
        ]),
      ]),
    ]),
})
  .directive("tooltip", vTooltip)
  .mount(host);

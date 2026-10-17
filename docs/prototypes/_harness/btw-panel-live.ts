/**
 * btw 侧边对话 · 展示夹具（2026-10-17）。
 *
 * 挂**真实**的 BtwPanel（会话右侧并排一栏）+ ChatMessage（btw 批注书签）+ ActivityStrip
 * （侧栏收起时的「回答中 / 有新回复」chip），store 用真实的 useBtwSession。
 * 传输层换成桩件：btw_ask 约 1.5 秒后经 handleBtwAnswer 回一条假答复——
 * 走的是与真 btw_answer 事件同一个入口。
 *
 * 复跑：cd aide && npx vite --port 5199
 *   → http://localhost:5199/docs/prototypes/_harness/btw-panel-live.html
 *   ?theme=warm-dark / smoky-pink-glass 切主题（默认 glass）。
 */
import { computed, createApp, h, reactive } from "vue";
import "../../../src/styles/global.css";
import { applyTheme, themes } from "../../../src/themes";
import { vTooltip } from "../../../src/directives/tooltip";
import { setTransport } from "@aide/sdk";
import { useBtwSession } from "@/composables/useBtwSession";
import BtwPanel from "../../../src/components/BtwPanel.vue";
import ChatMessage from "../../../src/components/ChatMessage.vue";
import ActivityStrip from "../../../src/components/activity/ActivityStrip.vue";
import { btwChip } from "../../../src/components/activity/activityChips";
import type { ChatMessage as Msg } from "../../../src/types/chat";

const themeName = new URLSearchParams(location.search).get("theme") ?? "glass";
applyTheme(themes[themeName] ?? themes.glass);

const OWNER = "demo-session";
const btw = useBtwSession();

const ANSWERS: Record<string, string> = {
  "4:5 的兜底比例是做什么用的？":
    "图片还没加载出来时，先按 **4:5** 给每张商品卡预留高度。这样图片到达后不会把下面的内容往下挤，也就没有布局跳动。",
  "那横图会被裁掉吗？":
    "会按 `object-fit: cover` 裁掉左右两边。要完整显示就换成 `contain`，代价是卡片里会留白。",
};

// 桩件传输：只认 btw_ask，约 1.5 秒后按真实事件形状回答
setTransport({
  async invoke<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    if (command === "btw_ask") {
      const question = String(params?.question ?? "");
      window.setTimeout(() => {
        btw.handleBtwAnswer({
          type: "btw_answer",
          session_id: params?.sessionId,
          question,
          response: ANSWERS[question] ?? `（演示答复）关于「${question}」：主会话不受影响，这条也不会进入主对话上下文。`,
        });
      }, 1500);
    }
    return undefined as T;
  },
  async listen() {
    return () => {};
  },
});

// 主对话：一段已有的回答 + 每轮答完插进来的批注书签（与 useChatSession.sendBtw 同构）
const messages = reactive<Msg[]>([
  {
    id: "u1",
    role: "user",
    timestamp: Date.now(),
    blocks: [{ type: "text", text: "修一下商品网格的布局跳动" }],
  },
  {
    id: "a1",
    role: "assistant",
    timestamp: Date.now(),
    model: "claude-opus-5-5",
    blocks: [
      {
        type: "text",
        text: "网格跳动是因为商品图加载前没有宽高。我会在 ProductCard 里补上尺寸，再用一个宽高比兜底给网格预留空间。",
      },
    ],
  },
]);
btw.setOnDone((owner, block) => {
  if (owner !== OWNER) return;
  messages.push({ id: crypto.randomUUID(), role: "user", timestamp: Date.now(), blocks: [block] });
});

const thread = computed(() => btw.threadFor(OWNER));
const chips = computed(() => {
  const c = btwChip(thread.value);
  return c ? [c] : [];
});

const ask = (q: string) => void btw.ask({ ownerSid: OWNER, question: q });

// 预置一轮已答完的问答；?closed 演示「收起后回复到达 → 有新回复」
async function seed() {
  ask("4:5 的兜底比例是做什么用的？");
  await new Promise((r) => setTimeout(r, 1700));
  if (new URLSearchParams(location.search).has("closed")) {
    ask("那横图会被裁掉吗？");
    btw.closePanel(OWNER);
  }
}

createApp({
  render: () =>
    h("div", { style: "display:flex;height:100%;background:var(--aide-bg-base);font-family:var(--aide-font-mono)" }, [
      h("div", { style: "flex:1;min-width:0;display:flex;flex-direction:column;background:var(--aide-bg-deep)" }, [
        h(
          "div",
          { style: "flex:1;overflow:auto;padding:16px 0" },
          h("div", { style: "max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:12px" },
            messages.map((m) => h(ChatMessage, { key: m.id, message: m })),
          ),
        ),
        // 主输入区按真实几何摆：.chat-input-area 下内边距 12 / 框 44 / 框下状态行 32
        h("div", { style: "max-width:860px;width:100%;margin:0 auto;padding:4px 12px 12px;box-sizing:border-box" }, [
          h(ActivityStrip, {
            compaction: null,
            thinking: false,
            elapsedSeconds: 0,
            tip: null,
            chips: chips.value,
            onToggle: () => btw.openPanel(OWNER),
          }),
          h(
            "div",
            {
              class: "fake-main-input",
              style:
                "box-sizing:border-box;height:44px;display:flex;align-items:center;padding:0 12px;border-radius:var(--aide-radius-lg);background:var(--aide-bg-deep);border:1px solid var(--aide-border);color:var(--aide-text-muted);font-size:13px",
            },
            "输入消息…（主输入框只管主对话）",
          ),
          h(
            "div",
            { style: "display:flex;justify-content:space-between;align-items:center;min-height:28px;padding:4px 10px 0;font-size:12px;color:var(--aide-text-secondary)" },
            [h("span", "自动模式"), h("span", "Opus 5.5 · 进阶")],
          ),
        ]),
      ]),
      h(BtwPanel, { ownerSid: OWNER, onAsk: ask }),
    ]),
})
  .directive("tooltip", vTooltip)
  .mount("#app");

void seed();

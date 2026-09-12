import { ref, watch, type Ref } from "vue";
import {
  CHUNK_CHARS,
  skipSplitSurrogate,
  toAnimatedChunks,
  type AnimatedChunk,
} from "@aide/sdk/utils/streamSplit";

/**
 * 流式尾巴的逐块累积：**只追加、不重建**。
 *
 * 为什么必须只追加：块的入场动画挂在自己的 DOM 节点上，节点一旦被重建动画就从头
 * 开始。而"每条增量整段替换文本节点"正是本仓库历史上两次卡死的形状（文字块见
 * ChatMessage 的 v-html 路径、思考块见 ThinkingBlock 头部的 freeze-1788224842632）。
 * 把尾巴切成稳定存在的块，动画才有落点，长文本的重排也才有界。
 *
 * 两种用法：
 *   - 尾巴有天然上界时（正文的一个段落，写完就整体落定）传 `maxChunks: Infinity`，
 *     块表只增不减，`settled`/`clipped` 恒空。
 *   - 尾巴会无限增长时（思考块可以上万字）给一个真实上界，超出即把最老的块批量
 *     并进 `settled`——批量是故意的：每并一块就重排一次 settled 等于没省。
 */

/** 落定文本的保留上限（字符）。超出后从头部丢弃并置 `clipped`，由调用方打省略号。 */
export const SETTLED_MAX_CHARS = 6000;

/** 触顶后回落到上界的比例。留出这段余量，把 settled 的重写摊成一批一批。 */
const DRAIN_TO_RATIO = 0.75;

export interface StreamChunksOptions {
  /** 尾巴最多保留多少块；超出把最老的块并进 settled。 */
  maxChunks: number;
}

export interface StreamChunks {
  /** 已落定的前缀文本（无动画的纯文本节点）。 */
  settled: Ref<string>;
  /** 前缀是否因超出保留上限被截断。 */
  clipped: Ref<boolean>;
  /** 逐块淡入的尾巴。 */
  chunks: Ref<AnimatedChunk[]>;
}

/**
 * @param source 全文（持续增长；被整体替换时视为重放，整表重建）
 * @param opts.maxChunks 尾巴块数上界
 */
export function useStreamChunks(source: Ref<string>, opts: StreamChunksOptions): StreamChunks {
  const settled = ref("");
  const clipped = ref(false);
  const chunks = ref<AnimatedChunk[]>([]);

  /** 追加落定文本，超窗从头部丢弃（保留窗口尾部，与流式可见区一致）。 */
  function appendSettled(text: string): void {
    settled.value += text;
    if (settled.value.length <= SETTLED_MAX_CHARS) return;
    const cut = skipSplitSurrogate(settled.value, settled.value.length - SETTLED_MAX_CHARS);
    settled.value = settled.value.slice(cut);
    clipped.value = true;
  }

  /** 尾巴触顶：把最老的一批块并进 settled。批量退役，settled 才不会被逐块重写。 */
  function drain(): void {
    if (chunks.value.length <= opts.maxChunks) return;
    const drop = chunks.value.length - Math.floor(opts.maxChunks * DRAIN_TO_RATIO);
    appendSettled(chunks.value.slice(0, drop).map((c) => c.text).join(""));
    chunks.value = chunks.value.slice(drop);
  }

  /** 首帧 / 整体替换：只把最末一段做成块，其余直接落定——挂载到已经在跑的会话时，
   *  不该把上万字全变成 span（那正是要避开的 DOM 重量）。
   *  上界为 Infinity（尾巴另有天然边界）时整段都是尾巴，前缀留空。 */
  function reset(text: string): void {
    const tailLen = Number.isFinite(opts.maxChunks) ? opts.maxChunks * CHUNK_CHARS : text.length;
    // 必须显式判长度：`slice(0, 负数)` 不钳到 0 而是从尾部倒数（"abcdef".slice(0,-2)
    // 得 "abcd"），短文本会凭空在前缀里留下一截、与尾巴重复。
    if (text.length <= tailLen) {
      settled.value = "";
      clipped.value = false;
      chunks.value = toAnimatedChunks(text);
      return;
    }
    // 切点只算一次、两段共用，并避开代理对——分开算会让两段各持半个代理
    const cut = skipSplitSurrogate(text, text.length - tailLen);
    const head = text.slice(0, cut);
    settled.value = head.length > SETTLED_MAX_CHARS
      ? head.slice(skipSplitSurrogate(head, head.length - SETTLED_MAX_CHARS))
      : head;
    clipped.value = head.length > SETTLED_MAX_CHARS;
    chunks.value = toAnimatedChunks(text.slice(cut));
  }

  watch(
    source,
    (next, prev) => {
      // prev 为 undefined = 首帧；不以 prev 为前缀 = 正文被整体换掉（历史重放/切会话）
      if (prev === undefined || !next.startsWith(prev)) {
        reset(next);
        return;
      }
      chunks.value = chunks.value.concat(toAnimatedChunks(next.slice(prev.length)));
      drain();
    },
    { immediate: true },
  );

  return { settled, clipped, chunks };
}

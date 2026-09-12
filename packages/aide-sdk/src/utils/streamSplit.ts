/**
 * 流式正文分段：把还在长的正文切成「已定稿段落」+「流动尾巴」。
 *
 * **为什么要分段**：尾巴要逐块做渐显动画，块就必须是**稳定存在的 DOM 节点**。
 * 今天的路径是每个 delta 把整块正文重跑一遍 markdown、再整块换掉 innerHTML
 * （ChatMessage.vue 的 `v-html`）——动画节点会被下一次替换连根拔掉，动画每帧
 * 从头开始，等于没有动画。分段之后尾巴独立成元素，替换不再波及它。
 *
 * **顺带减负**：今天是每个 delta 全量重解析。分段后前缀只在跨段落时重渲一次
 * （渲染按 text 缓存，同串零成本），解析次数按段落数而非增量数计。
 *
 * **降级优先**：任何拿不准的情况一律返回不可动画（`tailAnimated = false`），
 * 调用方退回整块 markdown 渲染——最坏情况等于没做这个改动。
 */

/** 尾巴走逐块动画的字符上限。超长段落逐字动画既没有阅读价值，span 数还会失控
 *  （1 span / 2 字），退回整块 markdown 渲染。 */
export const TAIL_MAX_CHARS = 800;

/** 围栏行：行首（最多 3 空格缩进）三个以上反引号或波浪号——marked 两种都认。
 *  带 `m` 是为了既能逐行测（lastBlockBoundary）也能整串测（hasBlockMarkdown）；
 *  单行串里 `^` 只在 0 处匹配，两种用法语义一致。 */
const FENCE_LINE_RE = /^[ \t]{0,3}(?:`{3,}|~{3,})/m;

/** 块级标记：纯文本尾巴里没法正确表达，命中即退回 markdown 渲染（不出波形）。
 *  行首列表符 / 标题 / 引用 / 表格竖线，以及整行的分隔线。 */
const BLOCK_MARK_RE = /^[ \t]{0,3}(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s?|\|)|^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m;

/** 行内标记符号：动画期先去掉符号免得露原文，定稿后 markdown 渲染会把格式补上。
 *  刻意只收 `**` / 反引号 / `~~` 三种——单个 `*` `_` 有歧义（`snake_case` 会被
 *  误伤，CommonMark 里词内 `_` 本来也不算强调），宁可漏收不可误删。 */
const INLINE_MARK_RE = /\*\*|`|~~/g;

export interface StreamSplit {
  /** 已定稿的完整 markdown 段（以空行结尾）。 */
  frozen: string;
  /** 未定稿的当前段落（纯文本）。 */
  tail: string;
  /** 尾巴是否可以走逐块动画。false = 调用方整块走 renderMarkdown。 */
  tailAnimated: boolean;
}

/**
 * 围栏外最后一个空行的结束下标（即「已定稿」的切点）；没有则 0。
 *
 * 只认围栏**外**的空行：在代码块中间切一刀会把它劈成两个 `<pre>` 盒子。
 * 走一遍行扫描维护围栏深度，O(n) 且无正则回溯。
 */
export function lastBlockBoundary(text: string): number {
  let depth = 0;
  let cut = 0;
  let lineStart = 0;
  // i 取到 length 是故意的：末尾没有换行符的最后一行也要过一遍围栏计数
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i);
    if (FENCE_LINE_RE.test(line)) {
      depth = depth === 0 ? 1 : 0;
    } else if (depth === 0 && i < text.length && line.trim() === "") {
      cut = i + 1;
    }
    lineStart = i + 1;
  }
  return cut;
}

/** 尾巴里是否含块级标记（列表/标题/引用/表格/分隔线/围栏）。 */
export function hasBlockMarkdown(text: string): boolean {
  return BLOCK_MARK_RE.test(text) || FENCE_LINE_RE.test(text);
}

/** 去掉行内标记符号（见 INLINE_MARK_RE 的取舍）。 */
export function stripInlineMarks(text: string): string {
  return text.replace(INLINE_MARK_RE, "");
}

/** 正文 → 分段。纯函数；`tailAnimated` 为 false 时调用方应整块渲染原文。 */
export function splitStreamingText(text: string): StreamSplit {
  const cut = lastBlockBoundary(text);
  const tail = text.slice(cut);
  return {
    frozen: text.slice(0, cut),
    tail,
    tailAnimated: tail.length > 0 && tail.length <= TAIL_MAX_CHARS && !hasBlockMarkdown(tail),
  };
}

/** 动画块粒度（字）。2 是中文观感与 span 数的折中：1 字太碎且 span 数翻倍，
 *  4 字成团，看不出"一块一块推过去"。 */
export const CHUNK_CHARS = 2;

/** 同一次到达内相邻块的错峰间隔；块多时按比例压缩。 */
export const STAGGER_MS = 12;

/** 错峰总摊开的上限——再长用户就等不到最后一块浮现了。 */
export const STAGGER_CAP_MS = 200;

export interface AnimatedChunk {
  text: string;
  /** 入场动画延迟（ms）。 */
  delay: number;
}

/**
 * 一段新到达的文本 → 动画块。
 *
 * 错峰是专治**突发**的：sidecar 按 40ms 窗口合并增量（FLUSH_INTERVAL_MS），窗口
 * 里攒了多少字就一次倒进来。不摊开的话 30 个字同时淡入，看起来是一片闪白而不是
 * 一道波——这正是本方案要治的病灶。块少时（逐字到达）错峰几乎为零，无副作用。
 */
export function toAnimatedChunks(added: string): AnimatedChunk[] {
  const out: AnimatedChunk[] = [];
  let i = 0;
  while (i < added.length) {
    let end = i + CHUNK_CHARS;
    // 不从代理对中间切开：切点落在低代理上说明高代理在本块末尾，两块各持一半，
    // 浏览器会把两个孤立的半代理各渲染成一个替换字符（emoji / 扩展区汉字）。
    if (end < added.length) {
      const code = added.charCodeAt(end);
      if (code >= 0xdc00 && code <= 0xdfff) end += 1;
    }
    out.push({ text: added.slice(i, end), delay: 0 });
    i = end;
  }
  const step = Math.min(STAGGER_MS, STAGGER_CAP_MS / Math.max(1, out.length));
  return out.map((c, i) => ({ text: c.text, delay: Math.round(i * step) }));
}

/** 把切点右移一位以避开代理对中间；本就落在边界上则原样返回。
 *  窗口/前缀的切点都要过这一道，否则切出来的半个代理会渲染成替换字符。 */
export function skipSplitSurrogate(text: string, cut: number): number {
  const code = text.charCodeAt(cut);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  return isLowSurrogate && cut < text.length - 1 ? cut + 1 : cut;
}

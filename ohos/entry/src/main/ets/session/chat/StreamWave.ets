/**
 * 流式「渐显波」渲染（V2）：把还在长的正文尾巴切成逐块淡入的稳定节点。
 *
 * 移植自桌面 streamSplit.ts + useStreamChunks.ts（正文 + 思考场景），差异适配 ArkUI：
 *  - 浏览器 span 是行内流式布局，ArkUI 的块是 Flex wrap 的独立子节点——
 *    块粒度做「词感知」：拉丁词整块（词中不被换行劈开），CJK 2 字/块（原型
 *    观感），超长词按 WORD_CHUNK_MAX 分段（Flex wrap 断点只落在块间）
 *  - 尾巴按 '\n' 切成逐行 Flex：含换行的块在 Flex wrap 里按整块盒子顶对齐
 *  - transition 用 asymmetric：appear = OPACITY（460ms 错峰、cubic-bezier
 *    (.22,.75,.3,1)，桌面同曲线），disappear = IDENTITY（重置时瞬时让位
 *    给定稿渲染，绝不整段淡出闪烁）
 *  - 思考是无限增长的纯文本：WaveStream 设 maxChunks 后按块数窗口滚动退役
 *    （最老的整行批量并进 settled 前缀，超 SETTLED_MAX_CHARS 从头丢弃打
 *    省略号）；正文 maxChunks=Infinity，永不退役、settled 恒空
 *
 * 性能约束（用户明确要求，勿回退为逐字符渲染）：
 *  - WaveStream 只追加、不重建——节点一旦重建，入场动画就从头部重放
 *  - ForEach key 用唯一自增 id：已有块节点原样保留，新块走 appear 动画
 *  - 降级优先：尾巴超长或含块级标记时由 MarkdownText 整块渲染，最坏等于
 *    没做这个改动
 */
import { curves } from '@kit.ArkUI';

/** 尾巴走逐块动画的字符上限：超长段落逐块动画没有阅读价值且节点数失控。 */
const TAIL_MAX_CHARS: number = 800;
/** 非词块粒度（字）：中文观感与块数的折中。 */
const CHUNK_CHARS: number = 2;
/** 同一次到达内相邻块的错峰间隔；块多时按比例压缩。 */
const STAGGER_MS: number = 12;
/** 错峰总摊开上限：再长用户就等不到最后一块浮现。 */
const STAGGER_CAP_MS: number = 200;
/** 波形入场时长（桌面 CSS 0.46s 同源）。 */
const WAVE_DURATION_MS: number = 460;
/** 词块长度上限：词块不可断行，过长会撑破 Flex 行宽。 */
const WORD_CHUNK_MAX: number = 16;
/** 落定前缀的保留上限（字符）：思考可上万字，超出从头丢弃并置 clipped 打省略号。 */
const SETTLED_MAX_CHARS: number = 6000;
/** 触顶后回落到的比例：留出余量，把 settled 的重写摊成一批一批。 */
const DRAIN_TO_RATIO: number = 0.75;

/** 围栏行：行首（最多 3 空格缩进）三个以上反引号或波浪号。m 标志供逐行/整串两用。 */
const FENCE_LINE_RE: RegExp = new RegExp('^[ \\t]{0,3}(?:`{3,}|~{3,})', 'm');
/** 块级标记：纯文本尾巴里没法正确表达，命中即降级整块渲染。 */
const BLOCK_MARK_RE: RegExp = new RegExp(
  '^[ \\t]{0,3}(?:[-*+]\\s|\\d+[.)]\\s|#{1,6}\\s|>\\s?|\\|)|^[ \\t]{0,3}(?:-{3,}|\\*{3,}|_{3,})[ \\t]*$', 'm');
/** 行内标记符号：动画期先去掉符号免得露原文，定稿后 markdown 渲染补上格式。
 *  刻意只收 ** / 反引号 / ~~——单个 * _ 有歧义（snake_case 会被误伤）。 */
const INLINE_MARK_RE: RegExp = new RegExp('\\*\\*|`|~~', 'g');

/** 正文 → 「定稿前缀 + 流动尾巴」。 */
export class StreamSplit {
  /** 已定稿的完整 markdown 段（以空行结尾）。 */
  frozen: string = '';
  /** 未定稿的当前段落（纯文本）。 */
  tail: string = '';
  /** 尾巴是否可走逐块动画；false 时调用方整块渲染原文。 */
  tailAnimated: boolean = false;
}

/** 围栏外最后一个空行的结束下标（「已定稿」切点）；没有则 0。O(n) 行扫描无回溯。 */
export function lastBlockBoundary(text: string): number {
  let depth: number = 0;
  let cut: number = 0;
  let lineStart: number = 0;
  const n: number = text.length;
  // i 取到 n 是故意的：末尾无换行的最后一行也要过一遍围栏计数
  for (let i = 0; i <= n; i++) {
    if (i < n && text.charAt(i) !== '\n') {
      continue;
    }
    const line: string = text.substring(lineStart, i);
    if (FENCE_LINE_RE.test(line)) {
      depth = depth === 0 ? 1 : 0;
    } else if (depth === 0 && i < n && line.trim() === '') {
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

/** 去掉行内标记符号（取舍见 INLINE_MARK_RE）。 */
export function stripInlineMarks(text: string): string {
  return text.replace(INLINE_MARK_RE, '');
}

/** 把切点右移一位避开代理对中间；本就落在边界上则原样返回。 */
function skipSplitSurrogate(text: string, cut: number): number {
  const code: number = text.charCodeAt(cut);
  const isLowSurrogate: boolean = code >= 0xdc00 && code <= 0xdfff;
  return isLowSurrogate && cut < text.length - 1 ? cut + 1 : cut;
}

/** 正文 → 分段；tailAnimated 为 false 时调用方应整块渲染原文。 */
export function splitStreamingText(text: string): StreamSplit {
  const cut: number = lastBlockBoundary(text);
  const tail: string = text.substring(cut);
  const s: StreamSplit = new StreamSplit();
  s.frozen = text.substring(0, cut);
  s.tail = tail;
  s.tailAnimated = tail.length > 0 && tail.length <= TAIL_MAX_CHARS && !hasBlockMarkdown(tail);
  return s;
}

/** 一个渐显波块（入场后不可变）。 */
export class WaveChunk {
  id: number = 0;
  text: string = '';
  /** 入场动画延迟（ms）：同批到达内错峰摊开，专治 40ms 窗口合并出来的突发。 */
  delay: number = 0;
}

/** 波形的一行：块表追加式更新；cursor 只在尾巴最后一行为真。 */
@ObservedV2
export class WaveLine {
  id: number = 0;
  @Trace chunks: WaveChunk[] = [];
  @Trace cursor: boolean = false;
}

function isWordChar(c: string): boolean {
  const code: number = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * 一段新到达文本 → 波形块。词感知切块：拉丁词整块并吃掉尾部空格（换行
 * 不会把空格顶到下一行行首），其余 2 字/块，代理对不从中间切开。
 */
function toWaveChunks(added: string): WaveChunk[] {
  const parts: string[] = [];
  const n: number = added.length;
  let i: number = 0;
  while (i < n) {
    let end: number = i + 1;
    if (isWordChar(added.charAt(i))) {
      while (end < n && isWordChar(added.charAt(end)) && end - i < WORD_CHUNK_MAX) {
        end++;
      }
      while (end < n && added.charAt(end) === ' ' && end - i < WORD_CHUNK_MAX) {
        end++;
      }
    } else {
      end = Math.min(i + CHUNK_CHARS, n);
      if (end < n) {
        const code: number = added.charCodeAt(end);
        if (code >= 0xdc00 && code <= 0xdfff) {
          end++;
        }
      }
    }
    parts.push(added.substring(i, end));
    i = end;
  }
  const step: number = Math.min(STAGGER_MS, STAGGER_CAP_MS / Math.max(1, parts.length));
  const out: WaveChunk[] = [];
  for (let k = 0; k < parts.length; k++) {
    const c: WaveChunk = new WaveChunk();
    c.text = parts[k];
    c.delay = Math.round(k * step);
    out.push(c);
  }
  return out;
}

/**
 * 流式尾巴的逐块累积器：只追加、不重建（重建即动画重放，等于没动画）。
 * push 按前缀增长检测：新到达追加到行尾；非前缀增长（标记被后到的字合成、
 * 整体替换）走窗口重放——只把末段做成块，其余直接落定。
 *
 * 无限增长的尾巴（思考可上万字）设 maxChunks：块数超限即把最老的整行批量
 * 退役进 settled——整行退役使 settled 恒结束在真实行界（或行尾），波形首
 * 行顶下去不产生伪换行；settled 超 SETTLED_MAX_CHARS 从头丢弃并置 clipped。
 * 正文按段落天然有界，maxChunks=Infinity 永不退役、settled 恒空。
 */
@ObservedV2
export class WaveStream {
  @Trace lines: WaveLine[] = [];
  /** 已落定前缀（无动画纯文本节点）。 */
  @Trace settled: string = '';
  /** settled 是否因超保留上限被截头（渲染时打省略号）。 */
  @Trace clipped: boolean = false;
  /** 尾巴块数上界；Infinity = 不退役（正文按段落天然有界）。 */
  maxChunks: number = Infinity;
  private source: string = '';
  private nextId: number = 0;

  reset(): void {
    this.lines = [];
    this.settled = '';
    this.clipped = false;
    this.source = '';
  }

  push(text: string): void {
    if (text === this.source) {
      return;
    }
    if (this.source !== '' && text.startsWith(this.source)) {
      this.append(text.substring(this.source.length));
      this.drain();
    } else {
      this.resetWindowed(text);
    }
    this.source = text;
  }

  /** 首帧/整体替换：只把末段做成块，其余直接落定——挂载到进行中的流时，
   *  不该把上万字全变成块（那正是要避开的节点重量）。 */
  private resetWindowed(text: string): void {
    const tailLen: number = this.maxChunks === Infinity ? text.length : this.maxChunks * CHUNK_CHARS;
    this.lines = [];
    if (text.length <= tailLen) {
      this.settled = '';
      this.clipped = false;
      this.append(text);
      return;
    }
    const cut: number = skipSplitSurrogate(text, text.length - tailLen);
    this.setSettled(text.substring(0, cut));
    this.append(text.substring(cut));
  }

  private setSettled(head: string): void {
    if (head.length > SETTLED_MAX_CHARS) {
      this.settled = head.substring(skipSplitSurrogate(head, head.length - SETTLED_MAX_CHARS));
      this.clipped = true;
    } else {
      this.settled = head;
      this.clipped = false;
    }
  }

  private appendSettled(text: string): void {
    let merged: string = this.settled + text;
    if (merged.length > SETTLED_MAX_CHARS) {
      merged = merged.substring(skipSplitSurrogate(merged, merged.length - SETTLED_MAX_CHARS));
      this.clipped = true;
    }
    this.settled = merged;
  }

  /** 块数触顶：把最老的整行批量退役进 settled，回落到 DRAIN_TO_RATIO。 */
  private drain(): void {
    if (this.maxChunks === Infinity) {
      return;
    }
    const target: number = Math.floor(this.maxChunks * DRAIN_TO_RATIO);
    while (this.countChunks() > target && this.lines.length > 0) {
      this.retireFirstLine();
    }
  }

  private countChunks(): number {
    let count: number = 0;
    for (let i = 0; i < this.lines.length; i++) {
      count += this.lines[i].chunks.length;
    }
    return count;
  }

  private retireFirstLine(): void {
    const line: WaveLine = this.lines[0];
    let text: string = '';
    for (let k = 0; k < line.chunks.length; k++) {
      text += line.chunks[k].text;
    }
    // 后面还有行 = 源文本里该行确有换行符，随行落定；末行（换行未到）不加
    this.appendSettled(this.lines.length > 1 ? `${text}\n` : text);
    this.lines = this.lines.slice(1);
  }

  private append(added: string): void {
    if (added === '') {
      return;
    }
    let current: WaveLine = this.lines.length > 0 ? this.lines[this.lines.length - 1] : this.newLine();
    const parts: string[] = added.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        current = this.newLine();
      }
      const seg: string = parts[p];
      if (seg !== '') {
        const chunks: WaveChunk[] = toWaveChunks(seg);
        for (let k = 0; k < chunks.length; k++) {
          chunks[k].id = this.nextId;
          this.nextId++;
        }
        current.chunks = current.chunks.concat(chunks);
      }
    }
    this.refreshCursor();
  }

  private newLine(): WaveLine {
    const line: WaveLine = new WaveLine();
    line.id = this.nextId;
    this.nextId++;
    this.lines = this.lines.concat([line]);
    return line;
  }

  private refreshCursor(): void {
    const n: number = this.lines.length;
    for (let i = 0; i < n; i++) {
      this.lines[i].cursor = i === n - 1;
    }
  }
}

/**
 * 渐显波尾巴：落定前缀（截头打省略号，恒空时零渲染）+ 逐行 Flex wrap，
 * 行内块 Text 带 appear(OPACITY 错峰) / disappear(IDENTITY) 非对称转场。
 * 默认度量与 MarkdownText 段落一致（15/24/text_primary），思考场景传
 * 13/21/text_secondary，段落定稿换渲染时无缝。
 */
@ComponentV2
export struct WaveTail {
  @Param stream: WaveStream = new WaveStream();
  @Param textSize: number = 15;
  @Param rowHeight: number = 24;
  @Param textColor: Resource = $r('app.color.text_primary');

  @Builder
  lineView(ln: WaveLine) {
    Flex({ wrap: FlexWrap.Wrap, alignItems: ItemAlign.Start, alignContent: FlexAlign.Start }) {
      ForEach(ln.chunks, (c: WaveChunk) => {
        Text(c.text)
          .fontSize(this.textSize)
          .lineHeight(this.rowHeight)
          .fontColor(this.textColor)
          .transition(TransitionEffect.asymmetric(
            TransitionEffect.OPACITY.animation({
              duration: WAVE_DURATION_MS,
              delay: c.delay,
              curve: curves.cubicBezierCurve(0.22, 0.75, 0.3, 1)
            }),
            TransitionEffect.IDENTITY
          ))
      }, (c: WaveChunk) => `C${c.id}`)
      if (ln.cursor) {
        Text(' ▌')
          .fontSize(this.textSize)
          .lineHeight(this.rowHeight)
          .fontColor(this.textColor)
      }
    }
    .width('100%')
  }

  build() {
    Column() {
      if (this.stream.settled !== '') {
        Text(this.stream.clipped ? `…${this.stream.settled}` : this.stream.settled)
          .fontSize(this.textSize)
          .lineHeight(this.rowHeight)
          .fontColor(this.textColor)
          .width('100%')
      }
      ForEach(this.stream.lines, (ln: WaveLine) => {
        this.lineView(ln)
      }, (ln: WaveLine) => `L${ln.id}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

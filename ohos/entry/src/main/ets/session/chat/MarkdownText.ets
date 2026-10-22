/**
 * Markdown 渲染组件（V2）：MarkdownText。
 *
 * 性能模型（用户明确要求，勿回退为逐字符渲染）：
 *  - 一个 TextBlock 一个实例；非流式挂载解析一次、完成后 raw 不再变化、永不重排
 *  - 流式期间正文按「定稿前缀 + 流动尾巴」分段（StreamWave.splitStreamingText）：
 *    前缀只在跨段落时重解析（同串零成本）；尾巴优先走渐显波（WaveTail，块只
 *    追加不重建），拿不准（超长/含块级标记）降级为尾巴节流整块渲染
 *    （LIVE_THROTTLE_MS 前沿立即 + 尾沿兜底，任何时刻至多一个挂起定时器）
 *  - live→false 收尾立即终排全文，清空尾巴状态
 *  - ForEach key 含内容长度：流式追加前缀稳定，重排只重建变化的后缀块
 * 行内样式走 Text{ForEach{Span}} 声明式（官方 faqs-arkui-591 模式），
 * 行内码用 ContainerSpan（API 12）做灰底。
 */
import { MdBlock, MdBlockKind, MdSpan, MdSpanKind, parseMarkdown, localLinkPath } from './Markdown';
import { chatModel } from '../ChatModel';
import { LocalImage } from './LocalImage';
import { StreamSplit, WaveStream, WaveTail, splitStreamingText, stripInlineMarks, CARET_BLINK_MS } from './StreamWave';

const LIVE_THROTTLE_MS: number = 400;

@ComponentV2
export struct MarkdownText {
  @Param raw: string = '';
  @Param live: boolean = false;
  /** 定稿前缀块（流式）或全文块（非流式）。 */
  @Local blocks: MdBlock[] = [];
  /** 流动尾巴的逐块累积器（@ObservedV2：块更新只触发 WaveTail 重渲）。 */
  @Local wave: WaveStream = new WaveStream();
  @Local waveOn: boolean = false;
  /** 降级尾巴块（超长/含块级标记时替代波形）。 */
  @Local tailBlocks: MdBlock[] = [];
  /** 降级尾巴流式光标闪烁相位（live 期翻转；隐相位换透明色保占位）。 */
  @Local caretOn: boolean = true;
  private frozenSrc: string = '';
  private lastParseAt: number = 0;
  private timer: number = -1;
  private caretTimer: number = -1;

  aboutToAppear(): void {
    if (this.live) {
      this.syncLive();
      this.startCaretBlink();
    } else {
      this.finalize();
    }
  }

  aboutToDisappear(): void {
    this.clearTimer();
    this.stopCaretBlink();
  }

  @Monitor('raw')
  onRawChange(m: IMonitor): void {
    if (this.live) {
      this.syncLive();
      return;
    }
    this.clearTimer();
    this.finalize();
  }

  @Monitor('live')
  onLiveChange(m: IMonitor): void {
    if (!this.live) {
      this.clearTimer();
      this.stopCaretBlink();
      this.finalize();
      return;
    }
    this.startCaretBlink();
  }

  private clearTimer(): void {
    if (this.timer >= 0) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }

  private startCaretBlink(): void {
    if (this.caretTimer < 0) {
      this.caretOn = true;
      this.caretTimer = setInterval(() => {
        this.caretOn = !this.caretOn;
      }, CARET_BLINK_MS);
    }
  }

  private stopCaretBlink(): void {
    if (this.caretTimer >= 0) {
      clearInterval(this.caretTimer);
      this.caretTimer = -1;
    }
  }

  /** 流式同步：前缀跨段才重排；尾巴优先波形，降级才整块节流渲染。 */
  private syncLive(): void {
    const split: StreamSplit = splitStreamingText(this.raw);
    if (split.frozen !== this.frozenSrc) {
      this.frozenSrc = split.frozen;
      this.blocks = parseMarkdown(split.frozen);
    }
    if (split.tail === '') {
      this.clearTimer();
      this.waveOn = false;
      this.wave.reset();
      this.tailBlocks = [];
      return;
    }
    if (split.tailAnimated) {
      this.clearTimer();
      this.tailBlocks = [];
      if (!this.waveOn) {
        this.waveOn = true;
        this.wave.reset();
      }
      this.wave.push(stripInlineMarks(split.tail));
      return;
    }
    if (this.waveOn) {
      this.waveOn = false;
      this.wave.reset();
    }
    this.scheduleTailParse();
  }

  /** 降级尾巴：前沿立即 + 尾沿兜底，任何时刻同块至多一个挂起定时器。 */
  private scheduleTailParse(): void {
    const now: number = Date.now();
    const since: number = now - this.lastParseAt;
    if (since >= LIVE_THROTTLE_MS) {
      this.parseTail();
      return;
    }
    if (this.timer < 0) {
      this.timer = setTimeout(() => {
        this.timer = -1;
        // 重新取最新尾巴，避免定时器捕获陈旧快照
        this.syncLive();
      }, LIVE_THROTTLE_MS - since);
    }
  }

  private parseTail(): void {
    this.lastParseAt = Date.now();
    this.tailBlocks = parseMarkdown(splitStreamingText(this.raw).tail);
  }

  /** 收尾：全文终排一次，清空尾巴状态。 */
  private finalize(): void {
    this.frozenSrc = this.raw;
    this.blocks = parseMarkdown(this.raw);
    this.waveOn = false;
    this.wave.reset();
    this.tailBlocks = [];
  }

  // ── 行内 ──

  @Builder
  spanView(s: MdSpan) {
    if (s.kind === MdSpanKind.Bold) {
      Span(s.text).fontWeight(FontWeight.Bold)
    } else if (s.kind === MdSpanKind.Italic) {
      Span(s.text).fontStyle(FontStyle.Italic)
    } else if (s.kind === MdSpanKind.Code && s.href !== '') {
      // 文件路径：点开只读预览 Host 上的这个文件
      ContainerSpan() {
        Span(s.text)
          .fontFamily('monospace')
          .fontSize(13)
          .fontColor($r('app.color.accent'))
          .onClick(() => {
            chatModel.openWorkspaceFile(s.href);
          })
      }
      .textBackgroundStyle({ color: $r('app.color.input_bg'), radius: 4 })
    } else if (s.kind === MdSpanKind.Code) {
      ContainerSpan() {
        Span(s.text).fontFamily('monospace').fontSize(13)
      }
      .textBackgroundStyle({ color: $r('app.color.input_bg'), radius: 4 })
    } else if (s.kind === MdSpanKind.Strike) {
      Span(s.text).decoration({ type: TextDecorationType.LineThrough })
    } else if (s.kind === MdSpanKind.Link) {
      Span(s.text)
        .fontColor($r('app.color.accent'))
        .decoration({ type: TextDecorationType.Underline })
        .onClick(() => {
          // 指向 Host 上文件的链接点开预览；网址链接仍只是样式
          const p: string = localLinkPath(s.href);
          if (p !== '') {
            chatModel.openWorkspaceFile(p);
          }
        })
    } else {
      Span(s.text)
    }
  }

  @Builder
  spansView(spans: MdSpan[]) {
    ForEach(spans, (s: MdSpan, j: number) => {
      this.spanView(s)
    }, (s: MdSpan, j: number) => `${j}-${s.kind}-${s.text.length}`)
  }

  // ── 块级 ──

  /** 流式光标（原型 .cursor）：1/8 em 细条 accent 闪烁，行内随末块文本。 */
  @Builder
  caretSpan() {
    Span(' ▏')
      .fontColor(this.caretOn ? $r('app.color.accent') : Color.Transparent)
  }

  @Builder
  blockView(b: MdBlock, caret: boolean) {
    if (b.kind === MdBlockKind.Heading) {
      Text() {
        this.spansView(b.spans)
        if (caret) {
          this.caretSpan()
        }
      }
      .fontSize(b.level === 1 ? 20 : (b.level === 2 ? 18 : (b.level === 3 ? 16 : 15)))
      .fontWeight(FontWeight.Bold)
      .lineHeight(b.level === 1 ? 28 : 26)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
    } else if (b.kind === MdBlockKind.Code) {
      Column({ space: 4 }) {
        if (b.lang !== '') {
          Text(b.lang).fontSize(11).fontColor($r('app.color.text_secondary'))
        }
        Text() {
          Span(b.text)
          if (caret) {
            this.caretSpan()
          }
        }
        .fontSize(13)
        .fontFamily('monospace')
        .fontColor($r('app.color.text_primary'))
        .lineHeight(20)
        .width('100%')
      }
      .width('100%')
      .padding(12)
      .borderRadius(8)
      .backgroundColor($r('app.color.card_bg'))
      .border({ width: 1, color: $r('app.color.line') })
      .alignItems(HorizontalAlign.Start)
    } else if (b.kind === MdBlockKind.ListItem) {
      Row() {
        Text(b.order >= 0 ? `${b.order}.` : '•')
          .fontSize(15)
          .fontColor($r('app.color.text_secondary'))
          .width(b.order >= 0 ? 24 : 20 + b.indent * 12)
        Text() {
          this.spansView(b.spans)
          if (caret) {
            this.caretSpan()
          }
        }
        .fontSize(15)
        .lineHeight(24)
        .fontColor($r('app.color.text_primary'))
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Top)
    } else if (b.kind === MdBlockKind.Quote) {
      Row({ space: 8 }) {
        Column()
          .width(3)
          .alignSelf(ItemAlign.Stretch)
          .backgroundColor($r('app.color.line'))
        Text() {
          this.spansView(b.spans)
          if (caret) {
            this.caretSpan()
          }
        }
        .fontSize(14)
        .lineHeight(22)
        .fontColor($r('app.color.text_secondary'))
        .layoutWeight(1)
      }
      .width('100%')
    } else if (b.kind === MdBlockKind.Image) {
      LocalImage({ src: b.src, alt: b.text })
    } else if (b.kind === MdBlockKind.Rule) {
      Divider().strokeWidth(1).color($r('app.color.line'))
    } else {
      Text() {
        this.spansView(b.spans)
        if (caret) {
          this.caretSpan()
        }
      }
      .fontSize(15)
      .lineHeight(24)
      .fontColor($r('app.color.text_primary'))
      .width('100%')
    }
  }

  build() {
    Column({ space: 8 }) {
      ForEach(this.blocks, (b: MdBlock, i: number) => {
        this.blockView(b, false)
      }, (b: MdBlock, i: number) => `${i}-${b.kind}-${b.text.length}-${b.src}`)
      if (this.waveOn) {
        WaveTail({ stream: this.wave })
      }
      ForEach(this.tailBlocks, (b: MdBlock, i: number) => {
        this.blockView(b, i === this.tailBlocks.length - 1)
      }, (b: MdBlock, i: number) => `${i}-${b.kind}-${b.text.length}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

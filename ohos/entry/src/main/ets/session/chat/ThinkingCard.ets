/**
 * 思考卡组件：思考内容的一屏限高滚动视图。
 *
 * 生命周期语义（状态机在 ChatStore.appendThinkingDelta / sealThinking，
 * 本组件只做展示与跟尾，不持有业务状态）：
 *  - 全程默认收起（含流式中）：仅用户点头行翻转，store 永不自动展开；
 *    头行以「思考中…」标记 active 段（收起态下唯一的进行中信号）
 *  - active 段（流式中）展开态：正文走渐显波（ThinkingWaveView，块只追加
 *    不重建 + 按块数窗口滚动退役）；内容增长自动贴内底（onAreaChange 为
 *    布局后回调，此时滚动目标已是新高度）；用户上滚离底即停跟、回底复跟
 *    （onScrollStop 后以 isAtEnd 复估跟尾位，单一回调天然覆盖拖拽/惯性/
 *    程序滚动全部来源，且不依赖已废弃的 onScroll 方向语义）
 *  - 段收尾（sealed）：卡片自动收起，点开回看从顶部开始，不再自动滚动；
 *    内容换整段 Text 渲染（尾巴状态已随 ThinkingWaveView 卸载）
 *  - 限高一屏：内容区 maxHeight 由页面按列表视口传入，「思考」头行恒可见
 */
import { ThinkingBlock } from './ChatBlocks';
import { WaveStream, WaveTail } from './StreamWave';

/** 尾巴块数上界（桌面同值）：可见窗口约 15 行 ≈ 650 字，800 字（400 块）留足
 *  余量；超出即把最老的整行批量并进 settled（见 WaveStream.drain）。 */
const TAIL_MAX_CHUNKS: number = 400;

/** 流式思考的渐显波视图：思考是纯文本，没有 markdown 安全边界问题，不做
 *  分段/降级，只按块数窗口滚动退役（WaveStream.maxChunks）。 */
@ComponentV2
struct ThinkingWaveView {
  @Param text: string = '';
  @Local wave: WaveStream = new WaveStream();

  aboutToAppear(): void {
    this.wave.maxChunks = TAIL_MAX_CHUNKS;
    this.wave.push(this.text);
  }

  @Monitor('text')
  onTextChange(m: IMonitor): void {
    this.wave.push(this.text);
  }

  build() {
    WaveTail({
      stream: this.wave,
      textSize: 13,
      rowHeight: 21,
      textColor: $r('app.color.text_secondary')
    })
  }
}

@ComponentV2
export struct ThinkingCard {
  @Param block: ThinkingBlock = new ThinkingBlock('', '');
  /** 内容区一屏限高（页面按列表视口高换算传入）。 */
  @Param maxHeight: number = 320;
  private scroller: Scroller = new Scroller();
  /** 内滚跟尾位：最近一次滚动停止时是否在底部（isAtEnd 复估，见文件头）。 */
  private follow: boolean = true;

  build() {
    Column({ space: 8 }) {
      Row({ space: 6 }) {
        Text('✦').fontSize(12).fontColor($r('app.color.text_secondary'))
        Text(this.block.active ? '思考中…' : '思考')
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_secondary'))
        Blank()
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(14)
          .fontColor([$r('app.color.text_secondary')])
          .rotate({ angle: this.block.collapsed ? 0 : 180 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.block.collapsed = !this.block.collapsed;
      })

      if (!this.block.collapsed && this.block.text !== '') {
        Divider().strokeWidth(1).color($r('app.color.line'))
        Scroll(this.scroller) {
          if (this.block.active) {
            ThinkingWaveView({ text: this.block.text })
              .onAreaChange((_o: Area, _n: Area) => {
                this.followTail();
              })
          } else {
            Text(this.block.text)
              .fontSize(13)
              .lineHeight(21)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
          }
        }
        .constraintSize({ maxHeight: this.maxHeight })
        .width('100%')
        .scrollBar(BarState.Auto)
        .edgeEffect(EdgeEffect.Spring)
        .onScrollStop(() => {
          this.follow = this.scroller.isAtEnd();
        })
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
  }

  /** 内容增长贴内底：仅 active 段且跟尾位有效（onAreaChange 布局完成后触发）。 */
  private followTail(): void {
    if (this.block.active && this.follow) {
      this.scroller.scrollEdge(Edge.Bottom);
    }
  }
}

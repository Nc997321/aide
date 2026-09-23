/**
 * 执行手册浮层（只读，对照原型 design/automation/app.html #fsPb 581-590 +
 * renderPlaybook 1024-1040）：头（返回 + 执行手册 / 任务名）/ 三态正文
 * （loading / 错误重试 / 未生成空页 / stale 横幅 + Markdown 内容）+ 底部
 * 「重新提炼」入口（见下）。
 *
 *  - 数据面：AutomationModel.readPlaybook() 开层即拉（get_automation_playbook
 *    返回 null = 未生成）；本组件纯渲染三态，重试直接复调 readPlaybook 幂等
 *  - 原型 pbSub 带「生成于 9/12 18:31」——协议无 playbook 生成时间戳
 *    （get_automation_playbook 只回文本），假数据不落 ohos，副标题只留任务名
 *  - stale 横幅（pb-banner）：任务指令修改后未重新生成，最近运行已回退原始
 *    指令——文案去假日期；⚠ 文本 → exclamationmark_triangle（SDK 符号核实）
 *  - 「↻ 重新提炼」为 ohos 增补（原型无此钮）：redistill_automation 把
 *    playbookState 置 stale，下次运行重走探索模式并重建手册；仅在手册已生成
 *    （有内容可弃）时出现；未生成空页维持「生成与更新目前请回桌面 aide 操作」
 *  - 内容渲染复用 MarkdownText（静态，live=false）；与聊天/转录同一渲染器
 */
import { AutomationModel, automationModel } from './AutomationModel';
import { MarkdownText } from './chat/MarkdownText';

@ComponentV2
export struct AutomationPlaybook {
  @Local am: AutomationModel = automationModel;

  // ── 纯展示 helper ──

  private taskName(): string {
    const t = this.am.selectedTask();
    return t !== null ? t.name : '任务';
  }

  private isStale(): boolean {
    const t = this.am.selectedTask();
    return t !== null && t.playbookState === 'stale';
  }

  private pbEnabled(): boolean {
    const t = this.am.selectedTask();
    return t === null ? true : t.playbookEnabled;
  }

  /** 手册已生成且有内容可弃时才给重新提炼入口。 */
  private canRedistill(): boolean {
    return this.am.playbookText !== '' && !this.am.playbookLoading && this.am.playbookError === '' &&
      this.am.selectedTaskId !== '';
  }

  // ── 头 ──

  @Builder
  headView() {
    Row({ space: 6 }) {
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(20)
          .fontColor([$r('app.color.text_primary')])
      }
      .width(32)
      .height(32)
      .borderRadius(8)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.am.closePlaybook();
      })

      Column({ space: 1 }) {
        Text('执行手册')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.taskName())
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 8 })
    .alignItems(VerticalAlign.Center)
  }

  // ── 三态正文 ──

  @Builder
  loadingView() {
    Column() {
      LoadingProgress().width(22).height(22).color($r('app.color.text_secondary'))
    }
    .width('100%')
    .padding(18)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  errorCard() {
    Column() {
      Text('手册拉取失败')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.status_danger'))
      Text(this.am.playbookError)
        .fontSize(11.5)
        .lineHeight(19)
        .fontColor($r('app.color.status_danger'))
        .textAlign(TextAlign.Center)
        .maxLines(3)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 2 })
      Row() {
        Text('重试')
          .fontSize(12)
          .fontColor($r('app.color.status_danger'))
      }
      .padding({ left: 18, right: 18, top: 6, bottom: 6 })
      .borderRadius(99)
      .border({ width: 1, color: $r('app.color.status_danger') })
      .margin({ top: 8 })
      .onClick(() => {
        void this.am.readPlaybook();
      })
    }
    .width('100%')
    .padding(14)
    .borderRadius(13)
    .backgroundColor($r('app.color.status_danger_weak'))
    .alignItems(HorizontalAlign.Center)
  }

  /** 未生成空页（empty-page）：图标 + 标题 + 按 playbookEnabled 分流的两行说明。 */
  @Builder
  emptyView() {
    Column({ space: 4 }) {
      Row() {
        SymbolGlyph($r('sys.symbol.book'))
          .fontSize(18)
          .fontColor([$r('app.color.accent')])
      }
      .width(38)
      .height(38)
      .borderRadius(12)
      .backgroundColor($r('app.color.accent_weak'))
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .margin({ bottom: 4 })

      Text('尚无执行手册')
        .fontSize(14)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text(this.pbEnabled()
        ? '首次运行后由模型自动沉淀，保证每次运行行为稳定'
        : '该任务未启用手册 · 每次运行直接按任务指令执行')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(20)
        .textAlign(TextAlign.Center)
      Text('生成与更新目前请回桌面 aide 操作')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(20)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ left: 30, right: 30 })
    .alignItems(HorizontalAlign.Center)
  }

  /** stale 横幅（pb-banner）：warn 弱底 + 三角叹号；文案对照原型去假日期。 */
  @Builder
  staleBanner() {
    Row({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.exclamationmark_triangle'))
        .fontSize(14)
        .fontColor([$r('app.color.status_warn')])
      Text('手册已过期：任务指令修改后未重新生成，最近运行已回退原始指令。以下为旧版内容。')
        .fontSize(12)
        .lineHeight(19)
        .fontColor($r('app.color.status_warn'))
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(12)
    .backgroundColor($r('app.color.status_warn_weak'))
    .alignItems(VerticalAlign.Top)
  }

  /** 手册内容卡（原型 .md）：card 底 + 14 圆角；MarkdownText 静态渲染。 */
  @Builder
  mdCard() {
    Column() {
      MarkdownText({ raw: this.am.playbookText, live: false })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 15, bottom: 15 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  // ── 底部重新提炼 ──

  @Builder
  footerBar() {
    Row() {
      Blank()
      Row({ space: 4 }) {
        Text('↻')
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.accent'))
        Text('重新提炼')
          .fontSize(12.5)
          .fontColor($r('app.color.accent'))
      }
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .borderRadius(99)
      .border({ width: 1, color: $r('app.color.accent') })
      .onClick(() => {
        if (this.am.selectedTaskId !== '') {
          void this.am.redistill(this.am.selectedTaskId);
        }
      })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 9, bottom: 13 })
    .border({ width: { top: 1 }, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
  }

  // ── 根 ──

  build() {
    if (this.am.playbookView) {
      Column() {
        this.headView()
        Scroll() {
          Column() {
            if (this.am.playbookLoading) {
              this.loadingView()
            } else if (this.am.playbookError !== '') {
              this.errorCard()
            } else if (this.am.playbookText === '') {
              this.emptyView()
            } else {
              Column({ space: 9 }) {
                if (this.isStale()) {
                  this.staleBanner()
                }
                this.mdCard()
              }
              .width('100%')
              .alignItems(HorizontalAlign.Start)
            }
          }
          .width('100%')
          .constraintSize({ minHeight: '100%' })
          .justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
          .padding({ left: 14, right: 14, top: 4, bottom: 18 })
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)

        if (this.canRedistill()) {
          this.footerBar()
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.page_bg'))
      .transition(TransitionEffect.translate({ y: '100%' }).animation({ duration: 240, curve: Curve.Friction }))
    }
  }
}

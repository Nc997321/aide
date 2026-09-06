/**
 * 权限应答弹层（挂起期间占据输入框位置；对照 design/chat-layout-mock.html
 * 的 .pm 权限应答卡）：FIFO 永远只应答队头，卡片头部带「还有 N 条排队」徽标。
 * 两形态（judgePermissionKind 判定，消费 PermissionShape 的解析/打包）：
 *  - 澄清提问（AskUserQuestion）：标题「需要澄清」，逐题整行选项卡（圆点 +
 *    选项 + 描述），「其他」行内直接输入回答；未全部作答前「提交回答」置灰，
 *    作答打包 answers 走 permission_response；「跳过」= 无理由拒绝。
 *  - 计划批准（ExitPlanMode）：标题「计划待批准」，计划正文（input.plan）
 *    按消息区同一 Markdown 管线渲染、一屏限高内滚——批准前必须能读完全文，
 *    「批准并执行 / 继续修改计划」恒在卡尾；批准带 nextMode='auto'（sidecar
 *    切模式后开始执行）。
 *  - 工具调用（未知工具同款卡）：工具名做标题 + 入参摘要盒；允许 / 拒绝整行
 *    排布；拒绝两步式——点拒绝原地展开理由输入（可留空）→ 确认拒绝 / 返回，
 *    理由走协议 message 通道。
 * 作答草稿状态随 PermissionRequest 实例走（@Trace 字段级观察，队头切换即
 * 全新草稿）；组件零业务逻辑，只做展示与派发（对照 PWA PermissionSheet）。
 */
import { ChatStore } from './ChatStore';
import { PermissionRequest } from './ChatBlocks';
import { QuestionSpec, QuestionOption, judgePermissionKind, planText } from './PermissionShape';
import { chatModel, RespondPermissionOpts } from '../ChatModel';
import { toolSummary, inputJson } from './ChatWire';
import { MarkdownText } from './MarkdownText';

@ComponentV2
export struct PermissionSheet {
  @Require @Param store: ChatStore;
  /** 计划正文滚动区的限高（页面按根高度折算传入——不能用 List 视口高：
   *  卡片出现会压缩 List，用它会形成布局反馈环）。 */
  @Require @Param planBodyMax: number;

  // ── 作答草稿读取（草稿数组整体替换，读侧随渲染追踪）──

  private isOptionOn(p: PermissionRequest, qi: number, label: string): boolean {
    const sel: string[] | undefined = p.selections[qi];
    return sel !== undefined && sel.includes(label);
  }

  private isFreeOn(p: PermissionRequest, qi: number): boolean {
    const f: boolean | undefined = p.useFreeText[qi];
    return f !== undefined ? f : false;
  }

  private freeTextOf(p: PermissionRequest, qi: number): string {
    const t: string | undefined = p.freeText[qi];
    return t !== undefined ? t : '';
  }

  // ── 公共件 ──

  @Builder
  queueBadgeView() {
    if (this.store.pendingPermissions.length > 1) {
      Text(`还有 ${this.store.pendingPermissions.length - 1} 条排队`)
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
    }
  }

  /** 单/多选圆点（对照 mock .pm-radio：选中描边着色 + 内嵌实心点）。 */
  @Builder
  radioDot(on: boolean) {
    Column() {
      if (on) {
        Column()
          .width(8)
          .height(8)
          .borderRadius(4)
          .backgroundColor($r('app.color.accent'))
      }
    }
    .width(16)
    .height(16)
    .borderRadius(8)
    .border({ width: 1.5, color: on ? $r('app.color.accent') : $r('app.color.line') })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  /** 拒绝两步式的理由表单（点拒绝原地替换按钮行；空理由 = 普通拒绝）。 */
  @Builder
  denyForm(p: PermissionRequest, placeholder: string) {
    TextInput({ text: p.denyReason, placeholder: placeholder })
      .onChange((value: string) => {
        p.denyReason = value;
      })
      .fontSize(13)
      .fontColor($r('app.color.text_primary'))
      .placeholderColor($r('app.color.text_secondary'))
      .caretColor($r('app.color.accent'))
      .backgroundColor($r('app.color.input_bg'))
      .borderRadius(10)
      .padding({ left: 12, right: 12 })
      .height(40)
      .width('100%')
    Button('确认拒绝')
      .fontSize(14)
      .fontColor($r('app.color.status_danger'))
      .backgroundColor(Color.Transparent)
      .border({ width: 1, color: $r('app.color.status_danger') })
      .borderRadius(18)
      .height(40)
      .width('100%')
      .onClick(() => {
        const reason: string = p.denyReason.trim();
        const opts: RespondPermissionOpts = { answers: null, reason: reason !== '' ? reason : null, nextMode: null };
        void chatModel.respondPermission(p.id, false, opts);
      })
    Button('返回')
      .fontSize(14)
      .fontColor($r('app.color.text_primary'))
      .backgroundColor($r('app.color.input_bg'))
      .borderRadius(18)
      .height(40)
      .width('100%')
      .onClick(() => {
        p.denyOpen = false;
      })
  }

  // ── 澄清提问卡（AskUserQuestion）──

  @Builder
  questionCard(p: PermissionRequest) {
    Column({ space: 10 }) {
      Row() {
        Text('需要澄清')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        this.queueBadgeView()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      ForEach(p.questions, (spec: QuestionSpec, qi: number) => {
        this.questionItem(p, spec, qi)
      }, (spec: QuestionSpec, qi: number) => `${p.id}-q${qi}`)

      Button('提交回答')
        .fontSize(14)
        .fontColor(Color.White)
        .backgroundColor(p.canSubmitAnswers() ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
        .borderRadius(18)
        .height(40)
        .width('100%')
        .onClick(() => {
          if (!p.canSubmitAnswers()) {
            return;
          }
          const opts: RespondPermissionOpts = { answers: p.packAnswers(), reason: null, nextMode: null };
          void chatModel.respondPermission(p.id, true, opts);
        })

      Button('跳过')
        .fontSize(14)
        .fontColor($r('app.color.text_primary'))
        .backgroundColor($r('app.color.input_bg'))
        .borderRadius(18)
        .height(40)
        .width('100%')
        .onClick(() => {
          void chatModel.respondPermission(p.id, false, null);
        })
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
  }

  /** 单题：头行（header + 可多选徽标 + 问题文本同行）+ 选项卡 + 其他行内输入。 */
  @Builder
  questionItem(p: PermissionRequest, spec: QuestionSpec, qi: number) {
    Column({ space: 8 }) {
      Row({ space: 6 }) {
        if (spec.header !== '') {
          Text(spec.header)
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
        }
        if (spec.multiSelect) {
          Text('可多选')
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .border({ width: 1, color: $r('app.color.line') })
            .borderRadius(6)
            .padding({ left: 6, right: 6, top: 1, bottom: 1 })
        }
        Text(spec.question)
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      ForEach(spec.options, (opt: QuestionOption) => {
        this.optionRow(p, qi, opt.label, opt.description)
      }, (opt: QuestionOption) => `${p.id}-q${qi}-${opt.label}`)

      this.freeRow(p, qi)
    }
    .width('100%')
  }

  /** 整行选项卡：圆点 + 选项 + 描述；选中描边着色 + 浅底。 */
  @Builder
  optionRow(p: PermissionRequest, qi: number, label: string, description: string) {
    Row({ space: 9 }) {
      this.radioDot(this.isOptionOn(p, qi, label))
      Column({ space: 2 }) {
        Text(label)
          .fontSize(13)
          .fontWeight(this.isOptionOn(p, qi, label) ? FontWeight.Medium : FontWeight.Normal)
          .fontColor(this.isOptionOn(p, qi, label) ? $r('app.color.accent') : $r('app.color.text_primary'))
        if (description !== '') {
          Text(description)
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(10)
    .border({ width: 1, color: this.isOptionOn(p, qi, label) ? $r('app.color.accent') : $r('app.color.line') })
    .backgroundColor(this.isOptionOn(p, qi, label) ? $r('app.color.input_bg') : $r('app.color.card_bg'))
    .onClick(() => {
      p.toggleOption(qi, label);
    })
  }

  /** 「其他」：选项行内直接输入（点行/点输入框即切换自由文本作答，与选项互斥）。 */
  @Builder
  freeRow(p: PermissionRequest, qi: number) {
    Row({ space: 9 }) {
      this.radioDot(this.isFreeOn(p, qi))
      Text('其他')
        .fontSize(13)
        .fontWeight(this.isFreeOn(p, qi) ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.isFreeOn(p, qi) ? $r('app.color.accent') : $r('app.color.text_primary'))
      TextInput({ text: this.freeTextOf(p, qi), placeholder: '输入你的回答…' })
        .onChange((value: string) => {
          p.setFreeText(qi, value);
        })
        .fontSize(13)
        .fontColor($r('app.color.text_primary'))
        .placeholderColor($r('app.color.text_secondary'))
        .caretColor($r('app.color.accent'))
        .backgroundColor(Color.Transparent)
        .padding(0)
        .height(24)
        .layoutWeight(1)
        .onClick(() => {
          p.useFreeTextAnswer(qi);
        })
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(10)
    .border({ width: 1, color: this.isFreeOn(p, qi) ? $r('app.color.accent') : $r('app.color.line') })
    .backgroundColor(this.isFreeOn(p, qi) ? $r('app.color.input_bg') : $r('app.color.card_bg'))
    .onClick(() => {
      p.useFreeTextAnswer(qi);
    })
  }

  // ── 计划批准卡（ExitPlanMode）──

  /** 计划批准卡：正文 Markdown 一屏限高内滚（短计划不撑空、长计划按钮仍恒在卡尾）。 */
  @Builder
  planCard(p: PermissionRequest) {
    Column({ space: 10 }) {
      Row() {
        Text('计划待批准')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        this.queueBadgeView()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (p.fromSubagentName !== '') {
        Text(`来自子代理 ${p.fromSubagentName}`)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }

      Scroll() {
        if (planText(p.input) !== '') {
          MarkdownText({ raw: planText(p.input), live: false })
        } else {
          Text('（无计划正文）')
            .fontSize(13)
            .fontColor($r('app.color.text_secondary'))
        }
      }
      .width('100%')
      .align(Alignment.Top)
      .constraintSize({ maxHeight: this.planBodyMax })
      .scrollBar(BarState.Auto)
      .edgeEffect(EdgeEffect.Spring)

      if (!p.denyOpen) {
        Button('批准并执行')
          .fontSize(14)
          .fontColor(Color.White)
          .backgroundColor($r('app.color.accent'))
          .borderRadius(18)
          .height(40)
          .width('100%')
          .onClick(() => {
            const opts: RespondPermissionOpts = { answers: null, reason: null, nextMode: 'auto' };
            void chatModel.respondPermission(p.id, true, opts);
          })
        Button('继续修改计划')
          .fontSize(14)
          .fontColor($r('app.color.text_primary'))
          .backgroundColor($r('app.color.input_bg'))
          .borderRadius(18)
          .height(40)
          .width('100%')
          .onClick(() => {
            p.denyOpen = true;
          })
      } else {
        this.denyForm(p, '告诉它计划哪里需要调整（可留空）…')
      }
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
  }

  // ── 工具调用卡 ──

  @Builder
  toolCard(p: PermissionRequest) {
    Column({ space: 10 }) {
      Row() {
        Text(p.name)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
        Blank()
        this.queueBadgeView()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (p.fromSubagentName !== '') {
        Text(`来自子代理 ${p.fromSubagentName}`)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .width('100%')
      }

      Text(toolSummary(p.input) !== '' ? toolSummary(p.input) : inputJson(p.input))
        .fontSize(12)
        .fontFamily('monospace')
        .fontColor($r('app.color.text_secondary'))
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .backgroundColor($r('app.color.input_bg'))
        .borderRadius(8)
        .padding({ left: 10, right: 10, top: 7, bottom: 7 })

      if (!p.denyOpen) {
        Button('允许')
          .fontSize(14)
          .fontColor(Color.White)
          .backgroundColor($r('app.color.accent'))
          .borderRadius(18)
          .height(40)
          .width('100%')
          .onClick(() => {
            void chatModel.respondPermission(p.id, true, null);
          })
        Button('拒绝')
          .fontSize(14)
          .fontColor($r('app.color.text_primary'))
          .backgroundColor($r('app.color.input_bg'))
          .borderRadius(18)
          .height(40)
          .width('100%')
          .onClick(() => {
            p.denyOpen = true;
          })
      } else {
        this.denyForm(p, '告诉它为什么拒绝（可留空）…')
      }
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
  }

  build() {
    Column() {
      ForEach(this.store.pendingPermissions, (p: PermissionRequest, i: number) => {
        if (i === 0) {
          if (judgePermissionKind(p.name) === 'question') {
            this.questionCard(p)
          } else if (judgePermissionKind(p.name) === 'plan') {
            this.planCard(p)
          } else {
            this.toolCard(p)
          }
        }
      }, (p: PermissionRequest, i: number) => `${i}-${p.id}`)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 10 })
    .transition(TransitionEffect.asymmetric(
      TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: 8 })).animation({ duration: 300, curve: Curve.EaseOut }),
      TransitionEffect.OPACITY.animation({ duration: 380, curve: Curve.EaseOut })
    ))
  }
}

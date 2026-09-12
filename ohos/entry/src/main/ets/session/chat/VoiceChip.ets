/**
 * 语音 chip（统一入口）：挂 assistant 正文消息尾部（ChatPage.assistantMessage），
 * 纯图标无文字——
 *  - 点按 = 听书（ReaderModel → 小艺朗读面板，从本条起听；音色/倍速/定时/
 *    上下篇由面板托管）
 *    - 本条朗读中：三根均衡器跳动条 → 点 = 停止并收面板
 *    - 停在本条（面板暂停/播完）：耳机高亮 → 点 = 续播 / 重听
 *    - 空闲：耳机常规 → 点 = 从本条起听
 *  - 长按 = 自动播报总开关（TtsModel.enabled：权限请求/回复完成的轻量播报，
 *    持久化 preferences）：开 ↔ 关 toast 回报；关态虚线描边灰显提示
 *  - 轻量播报进行中（本条，回复完成自动播报触发）：均衡器动画 → 点 = 只停
 *    本次播报，不动开关（开关归长按）
 * 状态机在 ReaderModel + TtsModel（本组件只读状态渲染 + 分发动作）；播放列表
 * 源经 @Param store 注入（点击时现读 store.messages，不用渲染期快照——面板
 * 列表要最新会话）。
 */
import { common } from '@kit.AbilityKit';
import { ChatMessage } from './ChatBlocks';
import { ChatStore } from './ChatStore';
import { TtsModel, ttsModel } from './TtsModel';
import { ReaderModel, readerModel } from './ReaderModel';

/** 均衡器三根条的基准高（原型 .sp-eq i：5 / 10 / 7）。 */
const EQ_BASE_H: number[] = [5, 10, 7];
/** 相位缩放序列（原型 @keyframes eq 的 scaleY .45↔1 取三档轮播近似）。 */
const EQ_SCALE: number[] = [1, 0.45, 0.75];
/** 相位节拍（ms）：全局相位推进，条 i 用 (相位+i) 取档 → 波形错峰流动。 */
const EQ_TICK_MS: number = 240;

@ComponentV2
export struct VoiceChip {
  @Require @Param msg: ChatMessage;
  /** 播放列表源（store.messages 透传；点击时现读，见文件头）。 */
  @Require @Param store: ChatStore;
  @Local tts: TtsModel = ttsModel;
  @Local rd: ReaderModel = readerModel;
  /** 均衡器全局相位（0..2 轮转；仅出声时推进）。 */
  @Local eqPhase: number = 0;
  private eqTimer: number = -1;

  aboutToAppear(): void {
    this.eqTimer = setInterval(() => {
      if (this.tts.isPlaying(this.msg.id) || this.rd.isReading(this.msg.id)) {
        this.eqPhase = (this.eqPhase + 1) % EQ_SCALE.length;
      }
    }, EQ_TICK_MS);
  }

  aboutToDisappear(): void {
    if (this.eqTimer >= 0) {
      clearInterval(this.eqTimer);
      this.eqTimer = -1;
    }
  }

  /** 点击状态机：播报中停本次 / 朗读中收面板 / 停在本条续播重听 / 空闲起听。 */
  private onTap(): void {
    if (this.tts.isPlaying(this.msg.id)) {
      this.tts.stop(); // 只停本次播报：总开关归长按
      return;
    }
    if (this.rd.isReading(this.msg.id)) {
      this.rd.stop();
      return;
    }
    if (this.rd.isCurrent(this.msg.id)) {
      if (this.rd.paused) {
        this.rd.resume();
        return;
      }
      // 播完停在本条：落到 startFrom 重听
    }
    const c: common.Context | undefined = this.getUIContext().getHostContext();
    if (c !== undefined) {
      void this.rd.startFrom(c, this.store.messages, this.msg.id);
    }
  }

  /** 长按 = 自动播报总开关（开 ↔ 关；关时顺带停当前播报）。 */
  private onLongPress(): void {
    if (this.tts.enabled) {
      this.tts.stop();
      this.tts.setEnabled(false);
      this.tts.toast('语音播报已关闭，长按重新开启', 'warn');
    } else {
      this.tts.setEnabled(true);
      this.tts.toast('语音播报已开启', 'ok');
    }
  }

  /** 条 i 当前相位高度。 */
  private eqHeight(i: number): number {
    return EQ_BASE_H[i] * EQ_SCALE[(this.eqPhase + i) % EQ_SCALE.length];
  }

  build() {
    if (this.tts.isPlaying(this.msg.id) || this.rd.isReading(this.msg.id)) {
      // 出声中（轻量播报或听书朗读）：均衡器（原型 .sp-chip.playing 视觉）；
      // 点 = 停，长按 = 开关
      Row({ space: 2 }) {
        Column()
          .width(2.5)
          .height(this.eqHeight(0))
          .borderRadius(1)
          .backgroundColor($r('app.color.accent'))
          .animation({ duration: EQ_TICK_MS, curve: Curve.EaseInOut })
        Column()
          .width(2.5)
          .height(this.eqHeight(1))
          .borderRadius(1)
          .backgroundColor($r('app.color.accent'))
          .animation({ duration: EQ_TICK_MS, curve: Curve.EaseInOut })
        Column()
          .width(2.5)
          .height(this.eqHeight(2))
          .borderRadius(1)
          .backgroundColor($r('app.color.accent'))
          .animation({ duration: EQ_TICK_MS, curve: Curve.EaseInOut })
      }
      .alignItems(VerticalAlign.Center)
      .height(24)
      .padding({ left: 10, right: 10 })
      .borderRadius(99)
      .backgroundColor($r('app.color.accent_weak'))
      .onClick(() => {
        this.onTap();
      })
      .gesture(
        LongPressGesture()
          .onAction((_e: GestureEvent) => {
            this.onLongPress();
          })
      )
    } else if (this.rd.isCurrent(this.msg.id)) {
      // 停在本条（面板暂停/播完）：耳机高亮；点 = 续播/重听
      Row() {
        SymbolGlyph($r('sys.symbol.headphones'))
          .fontSize(14)
          .fontColor([$r('app.color.accent')])
      }
      .height(24)
      .padding({ left: 6, right: 6 })
      .borderRadius(99)
      .backgroundColor($r('app.color.accent_weak'))
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onTap();
      })
      .gesture(
        LongPressGesture()
          .onAction((_e: GestureEvent) => {
            this.onLongPress();
          })
      )
    } else if (!this.tts.enabled) {
      // 自动播报关：虚线描边灰显提示（点仍可听书；长按重开）
      Row() {
        SymbolGlyph($r('sys.symbol.headphones'))
          .fontSize(14)
          .fontColor([$r('app.color.btn_disabled_bg')])
      }
      .height(24)
      .padding({ left: 6, right: 6 })
      .borderRadius(99)
      .backgroundColor($r('app.color.input_bg'))
      .border({ width: 1, color: $r('app.color.line'), style: BorderStyle.Dashed })
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onTap();
      })
      .gesture(
        LongPressGesture()
          .onAction((_e: GestureEvent) => {
            this.onLongPress();
          })
      )
    } else {
      // 常规：耳机；点 = 从本条起听（拉起朗读面板），长按 = 开关
      Row() {
        SymbolGlyph($r('sys.symbol.headphones'))
          .fontSize(14)
          .fontColor([$r('app.color.text_secondary')])
      }
      .height(24)
      .padding({ left: 6, right: 6 })
      .borderRadius(99)
      .backgroundColor($r('app.color.input_bg'))
      .border({ width: 1, color: $r('app.color.line') })
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onTap();
      })
      .gesture(
        LongPressGesture()
          .onAction((_e: GestureEvent) => {
            this.onLongPress();
          })
      )
    }
  }
}

/**
 * 停止回复 chip（VoiceChip 播放态的红色反相）：挂输入框上方左侧（ChatPage
 * inputBarView 顶部行），仅回复进行中渲染（闲态直接不占位）——
 *  - 三根均衡器跳动条 + 红色弱底胶囊（对照 VoiceChip 播放态同构视觉：
 *    accent → status_danger 反相——播报是「出声」，这里是「可停」）
 *  - 点击 = 停止回复（interrupt——残段冻结后落「已停止会话」系统分隔线，
 *    见 ChatModel.interrupt）
 * 忙碌判定与中断动作在宿主（canStop 闸门 + onStopTap 回调注入），本组件只
 * 渲染动画 + 分发点击（挂载期恒为回复中，相位无条件推进）。
 */
/** 均衡器三根条的基准高（对照 VoiceChip .sp-eq i：5 / 10 / 7）。 */
const STOP_EQ_BASE_H: number[] = [5, 10, 7];
/** 相位缩放序列（原型 @keyframes eq 的 scaleY .45↔1 取三档轮播近似）。 */
const STOP_EQ_SCALE: number[] = [1, 0.45, 0.75];
/** 相位节拍（ms）：全局相位推进，条 i 用 (相位+i) 取档 → 波形错峰流动。 */
const STOP_EQ_TICK_MS: number = 240;

@ComponentV2
export struct StopChip {
  /** 点击停止（宿主注入：状态闸门 + interrupt + toast）。 */
  @Param onStop: () => void = () => {};
  /** 均衡器全局相位（0..2 轮转；挂载期恒推进）。 */
  @Local eqPhase: number = 0;
  private eqTimer: number = -1;

  aboutToAppear(): void {
    this.eqTimer = setInterval(() => {
      this.eqPhase = (this.eqPhase + 1) % STOP_EQ_SCALE.length;
    }, STOP_EQ_TICK_MS);
  }

  aboutToDisappear(): void {
    if (this.eqTimer >= 0) {
      clearInterval(this.eqTimer);
      this.eqTimer = -1;
    }
  }

  /** 条 i 当前相位高度。 */
  private eqHeight(i: number): number {
    return STOP_EQ_BASE_H[i] * STOP_EQ_SCALE[(this.eqPhase + i) % STOP_EQ_SCALE.length];
  }

  build() {
    Row({ space: 2 }) {
      Column()
        .width(2.5)
        .height(this.eqHeight(0))
        .borderRadius(1)
        .backgroundColor($r('app.color.status_danger'))
        .animation({ duration: STOP_EQ_TICK_MS, curve: Curve.EaseInOut })
      Column()
        .width(2.5)
        .height(this.eqHeight(1))
        .borderRadius(1)
        .backgroundColor($r('app.color.status_danger'))
        .animation({ duration: STOP_EQ_TICK_MS, curve: Curve.EaseInOut })
      Column()
        .width(2.5)
        .height(this.eqHeight(2))
        .borderRadius(1)
        .backgroundColor($r('app.color.status_danger'))
        .animation({ duration: STOP_EQ_TICK_MS, curve: Curve.EaseInOut })
    }
    .alignItems(VerticalAlign.Center)
    .height(24)
    .padding({ left: 10, right: 10 })
    .borderRadius(99)
    .backgroundColor($r('app.color.status_danger_weak'))
    .onClick(() => {
      this.onStop();
    })
  }
}

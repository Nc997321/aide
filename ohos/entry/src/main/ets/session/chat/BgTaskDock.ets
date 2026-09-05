/**
 * 停靠区后台任务组件（bg_task_* 的消费端；对照 design/chat-layout-mock.html
 * 的 .bgt-bar/.bgt-panel，三变体共用）。
 *
 * 结构：状态条胶囊（● 脉冲 + 「N 个后台任务运行中」/「✓ 后台任务已完成」+
 * 命令摘要 + ▾）+ 可展开任务列表面板（状态/名称/命令/走表时长/■ 终止 +
 * 纯文本尾部输出贴尾滚动——移动端不做 xterm）。
 *
 * 生命周期语义（对照桌面 BgTaskDock 的移动端取舍）：
 *  - 跨轮次存活：message_stop 不清 bgTasks，状态条跨轮次常驻
 *  - 完成即焚：全部结束 → 状态条变 ✓ 停留 LINGER_MS → clearEndedBgTasks
 *    卸载淡出（桌面是「保留到下次点开」，这里更贴 V1「不进历史」）；
 *    停留期内新任务启动则取消即焚并清走已结束项（防状态条常年挂着旧 ✓）
 *  - 事件流侧（ChatEvents）error/session_dead/reset* 直接清空 → 组件卸载
 * 组件随 ChatPage 的 if 挂卸（bgTasks 空即隐藏）；时钟/即焚定时器随
 * aboutToDisappear 回收。
 */
import { ChatStore } from './ChatStore';
import { BgTask } from './ChatBlocks';
import { chatModel } from '../ChatModel';

/** 全部完成后状态条停留时长（对照 mock 2.5s）。 */
const LINGER_MS: number = 2500;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 走表时钟：HH:MM:SS（对照 mock fmtDur）。 */
function fmtClock(ms: number): string {
  const s: number = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 状态条完成态的短时长：12s / 3m5s（对照 mock 'pnpm dev · 12s'）。 */
function fmtShort(ms: number): string {
  const s: number = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** 脉冲圆点：挂载即起无限交替呼吸动画，卸载即随节点销毁（终态换静态圆点/字形）。 */
@ComponentV2
struct PulseDot {
  @Param dotSize: number = 7;
  @Local dim: boolean = false;

  build() {
    // 圆角容器而非 Circle.fill（fill 自 API 26，兼容面保守起步用通用属性画圆）
    Column()
      .width(this.dotSize)
      .height(this.dotSize)
      .borderRadius(this.dotSize / 2)
      .backgroundColor($r('app.color.status_ok'))
      .opacity(this.dim ? 0.35 : 1)
      .onAppear(() => {
        this.getUIContext().animateTo({ duration: 800, iterations: -1, playMode: PlayMode.Alternate, curve: Curve.Smooth }, () => {
          this.dim = true;
        })
      })
  }
}

/** 单个后台任务行：状态/名称/命令/走表时长/■ 终止 + 尾部输出贴尾滚动。 */
@ComponentV2
struct BgTaskItem {
  @Require @Param task: BgTask;
  /** 走表时钟（父组件秒级 bump；终态冻结为 endedAt 差值不随动）。 */
  @Require @Param now: number;
  private outScroller: Scroller = new Scroller();

  /** 尾部输出贴尾：增量到达后滚到底（延到下一帧布局完成后再滚）。 */
  @Monitor('task.output')
  onOutputGrow(monitor: IMonitor): void {
    setTimeout(() => {
      this.outScroller.scrollEdge(Edge.Bottom);
    }, 0);
  }

  private isRunning(): boolean {
    return this.task.status === 'running';
  }

  private statusGlyph(): string {
    if (this.task.status === 'failed') {
      return '✗';
    }
    if (this.task.status === 'stopped') {
      return '■';
    }
    return '✓';
  }

  private statusColor(): Resource {
    if (this.task.status === 'failed') {
      return $r('app.color.status_danger');
    }
    if (this.task.status === 'stopped') {
      return $r('app.color.text_secondary');
    }
    return $r('app.color.status_ok');
  }

  private nameText(): string {
    return this.task.description !== '' ? this.task.description : this.task.command;
  }

  private durationText(): string {
    const end: number = this.isRunning() ? this.now : this.task.endedAt;
    return fmtClock(Math.max(0, end - this.task.startedAt));
  }

  @Builder
  outputView() {
    Scroll(this.outScroller) {
      Text(this.task.truncatedBytes > 0
        ? `…已截断 ${this.task.truncatedBytes} 字节\n${this.task.output}` : this.task.output)
        .fontSize(11)
        .fontFamily('monospace')
        .lineHeight(17)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .wordBreak(WordBreak.BREAK_ALL)
    }
    .width('100%')
    .constraintSize({ maxHeight: 132 })
    .backgroundColor($r('app.color.input_bg'))
    .borderRadius(8)
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .margin({ left: 12, right: 12, bottom: 10 })
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .onAppear(() => {
      // 挂载即有存量输出：直接贴尾
      setTimeout(() => {
        this.outScroller.scrollEdge(Edge.Bottom);
      }, 0);
    })
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        if (this.isRunning()) {
          Row() {
            PulseDot({ dotSize: 10 })
          }
          .width(14)
          .justifyContent(FlexAlign.Center)
        } else {
          Text(this.statusGlyph())
            .fontSize(12)
            .fontColor(this.statusColor())
            .width(14)
            .textAlign(TextAlign.Center)
        }
        Column({ space: 2 }) {
          Text(this.nameText())
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.task.command !== '' && this.task.command !== this.nameText()) {
            Text(this.task.command)
              .fontSize(11)
              .fontFamily('monospace')
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Text(this.durationText())
          .fontSize(11)
          .fontFamily('monospace')
          .fontColor($r('app.color.text_secondary'))
        if (this.isRunning()) {
          Text('■ 终止')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
            .border({ width: 1, color: $r('app.color.line') })
            .borderRadius(6)
            .padding({ left: 7, right: 7, top: 2, bottom: 2 })
            .onClick(() => {
              void chatModel.stopBgTask(this.task.id);
            })
        }
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 9, bottom: 9 })
      .alignItems(VerticalAlign.Center)

      if (this.task.output !== '') {
        this.outputView()
      }
    }
    .width('100%')
  }
}

@ComponentV2
export struct BgTaskDock {
  @Require @Param store: ChatStore;
  /** 面板展开态（点状态条翻转；随组件卸载复位）。 */
  @Local panelOpen: boolean = false;
  /** 走表时钟（秒级 bump；仅存在运行中任务时更新，全终态不空转重渲染）。 */
  @Local now: number = Date.now();

  /** 运行中任务数（数组引用 + 元素 status 双依赖：endBgTask 字段翻转即刻感知）。 */
  @Computed
  get runningCount(): number {
    let n: number = 0;
    for (let i = 0; i < this.store.bgTasks.length; i++) {
      if (this.store.bgTasks[i].status === 'running') {
        n++;
      }
    }
    return n;
  }

  private clockId: number = -1;
  private lingerId: number = -1;

  aboutToAppear(): void {
    this.clockId = setInterval(() => {
      if (this.runningCount > 0) {
        this.now = Date.now();
      }
    }, 1000);
    // 挂载即同步一次（如停留期内离开再回来已全终态：补起即焚计时）
    this.syncLinger();
  }

  aboutToDisappear(): void {
    if (this.clockId !== -1) {
      clearInterval(this.clockId);
      this.clockId = -1;
    }
    this.cancelLinger();
  }

  /** runningCount 翻转 → 即焚调度同步（归零起停留计时；回正取消并清旧终态）。 */
  @Monitor('runningCount')
  onRunningChange(monitor: IMonitor): void {
    this.syncLinger();
  }

  private syncLinger(): void {
    if (this.runningCount > 0) {
      this.cancelLinger();
      if (this.hasEndedTask()) {
        this.store.clearEndedBgTasks();
      }
      return;
    }
    if (this.store.bgTasks.length > 0) {
      this.scheduleLinger();
    }
  }

  private scheduleLinger(): void {
    this.cancelLinger();
    this.lingerId = setTimeout(() => {
      this.lingerId = -1;
      this.store.clearEndedBgTasks();
    }, LINGER_MS);
  }

  private cancelLinger(): void {
    if (this.lingerId !== -1) {
      clearTimeout(this.lingerId);
      this.lingerId = -1;
    }
  }

  // ── 状态条文案 ──

  private hasEndedTask(): boolean {
    for (let i = 0; i < this.store.bgTasks.length; i++) {
      if (this.store.bgTasks[i].status !== 'running') {
        return true;
      }
    }
    return false;
  }

  private anyFailed(): boolean {
    for (let i = 0; i < this.store.bgTasks.length; i++) {
      if (this.store.bgTasks[i].status === 'failed') {
        return true;
      }
    }
    return false;
  }

  private firstRunning(): BgTask | undefined {
    for (let i = 0; i < this.store.bgTasks.length; i++) {
      if (this.store.bgTasks[i].status === 'running') {
        return this.store.bgTasks[i];
      }
    }
    return undefined;
  }

  /** 最近结束的任务（完成态命令摘要用）。 */
  private lastEnded(): BgTask | undefined {
    let last: BgTask | undefined = undefined;
    for (let i = 0; i < this.store.bgTasks.length; i++) {
      const t: BgTask = this.store.bgTasks[i];
      if (t.status !== 'running' && (last === undefined || t.endedAt >= last.endedAt)) {
        last = t;
      }
    }
    return last;
  }

  private barText(): string {
    const running: number = this.runningCount;
    if (running > 0) {
      return `${running} 个后台任务运行中`;
    }
    return this.anyFailed() ? '✗ 后台任务已结束' : '✓ 后台任务已完成';
  }

  private barCmd(): string {
    if (this.runningCount > 0) {
      const r: BgTask | undefined = this.firstRunning();
      return r !== undefined ? r.command : '';
    }
    const e: BgTask | undefined = this.lastEnded();
    if (e === undefined || e.command === '') {
      return '';
    }
    return `${e.command} · ${fmtShort(e.endedAt - e.startedAt)}`;
  }

  // ── 视图 ──

  @Builder
  barView() {
    Row({ space: 8 }) {
      if (this.runningCount > 0) {
        PulseDot({ dotSize: 7 })
      } else {
        Column()
          .width(7)
          .height(7)
          .borderRadius(3.5)
          .backgroundColor($r('app.color.status_ok'))
      }
      Text(this.barText())
        .fontSize(12)
        .fontWeight(600)
        .fontColor($r('app.color.text_primary'))
      if (this.barCmd() !== '') {
        Text(this.barCmd())
          .fontSize(11)
          .fontFamily('monospace')
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      } else {
        Blank().layoutWeight(1)
      }
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(12)
        .fontColor([$r('app.color.text_secondary')])
        .rotate({ angle: this.panelOpen ? 180 : 0 })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 7, bottom: 7 })
    .borderRadius(10)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
    .margin({ left: 12, right: 12, top: 8, bottom: 2 })
    .onClick(() => {
      this.panelOpen = !this.panelOpen;
    })
  }

  @Builder
  panelView() {
    Column() {
      ForEach(this.store.bgTasks, (t: BgTask, idx: number) => {
        if (idx > 0) {
          Divider().strokeWidth(1).color($r('app.color.line'))
        }
        BgTaskItem({ task: t, now: this.now })
      }, (t: BgTask) => t.id)
    }
    .width('100%')
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .clip(true)
    .margin({ left: 12, right: 12, top: 6, bottom: 2 })
  }

  build() {
    Column() {
      this.barView()
      if (this.panelOpen) {
        this.panelView()
      }
    }
    .width('100%')
    .transition(TransitionEffect.asymmetric(
      TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: 8 })).animation({ duration: 300, curve: Curve.EaseOut }),
      TransitionEffect.OPACITY.animation({ duration: 450, curve: Curve.EaseOut })
    ))
  }
}

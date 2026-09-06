/**
 * 会话页：消息时间线（思考 + 正文 + @引用卡片）+ 瞬态工具行 + 后台任务
 * 停靠区（状态条 + 展开面板）+ 发送/中断 + 权限应答。
 *
 * V1 排版语义（对照 design/chat-layout-mock.html）：
 *  - 永久驻留：用户气泡 / assistant 正文 / 可折叠思考卡 / @引用文件小卡片
 *  - 主线程工具调用（bash/read/grep/glob…）只走 store.liveActivities 瞬态行：
 *    运行期出现在时间线末尾，tool_result / 轮次收尾即整行消失，不进 blocks
 *  - 子代理块保留（默认收起，过程可点开）；历史思考默认收起
 * 视觉基线：白卡 card_bg + 1px line 描边（修 input_bg 与 page_bg 同色的糊感）、
 * 间距统一 8 的倍数、图标统一 sys.symbol。
 * 信息架构对照 remote-pwa 的 ChatView/MessageList/PermissionSheet 三件套
 * （状态与编排全在 ChatModel/ChatStore，页面零业务逻辑）。
 * 路由：SessionsPage 经 UIContext Router pushUrl 注入 ChatPageParams
 * （sid/name 声明在 ChatModel，两页共用）；返回键/‹ 回列表。
 * 滚动策略：List 以 initialIndex 底部起建——hydrate/重载完成后按当前消息数
 * 重建列表（if 分支切换），首帧即锚在最后一条，避免 LazyForEach 远跳估算
 * （scrollEdge 只能到「已构建内容」的底部，从顶部远跳等于没滚）；流式内容
 * 增长经 bumpTailThrottled 节流跟尾（120ms 一拍），仅在视口贴近底部时跟随
 * （对照 PWA「近底部才自动滚」，避免读历史被拽走；跟随时尾部恒已构建，
 * scrollEdge 精确贴底）。
 * 虚拟加载：消息时间线走 LazyForEach（ChatMessagesSource 对账 store 的
 * 结构原语；只建可见项 + cachedCount 预建，长会话内存/首帧与历史长度解耦）。
 * 思考卡：ThinkingCard 独立组件（一屏限高内滚 + active 段贴内底 +
 * 段收尾自动收起），状态机在 ChatStore，页面只传视口限高。
 * 凭据被吊销（needsPairing）时 @Monitor 自动退回列表页 → Index 落回连接页。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ChatModel, chatModel, ChatPageParams } from '../session/ChatModel';
import { ChatStore } from '../session/chat/ChatStore';
import {
  ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock, SubagentEntry,
  SubagentBlock, ChatMessage, PendingJump, LiveActivity
} from '../session/chat/ChatBlocks';
import { toolSummary } from '../session/chat/ChatWire';
import { PermissionSheet } from '../session/chat/PermissionSheet';
import { MarkdownText } from '../session/chat/MarkdownText';
import { BgTaskDock } from '../session/chat/BgTaskDock';
import { ThinkingCard } from '../session/chat/ThinkingCard';
import { ChatMessagesSource } from '../session/chat/ChatMessagesSource';

/** 相邻消息间隔超过 10 分钟插时间分隔线（对照 MessageList GAP_MS）。 */
const TIME_GAP_MS: number = 10 * 60 * 1000;

/** 思考卡内容一屏限高的预留：卡片头行 + 分隔线 + 卡内外边距与上下文余量。 */
const THINK_CAP_RESERVE: number = 120;

/** 思考卡内容区保底高度（视口未量得/极小时的兜底，保证仍可滚）。 */
const THINK_CAP_MIN: number = 160;

/** 近底判定：末位可见项距列表末尾不超过此项数即视为贴底，流式跟尾才生效。 */
const NEAR_BOTTOM_TAIL: number = 3;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 时间分隔线文案：今天/昨天/N月N日 + HH:mm。 */
function timeLabel(ms: number): string {
  if (ms <= 0) {
    return '';
  }
  const d: Date = new Date(ms);
  const now: Date = new Date();
  const hhmm: string = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `今天 ${hhmm}`;
  }
  const yesterday: Date = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return `昨天 ${hhmm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/** 工具入参单行摘要与 JSON 兜底统一走 ChatWire（toolSummary/inputJson）。 */

@Entry
@ComponentV2
struct ChatPage {
  @Local conn: ConnModel = connModel;
  @Local store: ChatStore = chatModel.store;
  @Local draft: string = '';
  /** 列表重建纪元（if 分支开关）：翻转即销毁重建 List——initialIndex 仅创建
   * 时生效、动态改值不重锚，重建是 LazyForEach「顶部远跳底部」的唯一通道。 */
  @Local listEpoch: number = 0;
  private model: ChatModel = chatModel;
  private scroller: Scroller = new Scroller();
  /** 视口末位列表下标（onScrollIndex 回写；仅滚动判断用，不驱动渲染）。 */
  private lastIdx: number = -1;
  /** 底部起建待消费标记：列表从空到非空的首次填充到达时重建列表锚最后一条
   *（open 默认贴底；复位/重载清空后重新武装）。 */
  private pendingAnchor: boolean = true;
  /** 重建后的贴底落位标记：新列表首帧布局（onScrollIndex）时 scrollEdge
   * 精确贴底一次（initialIndex 锚的是「末条起于视口顶」，贴底把内容底缘
   * 对齐视口底缘——尾部已构建，无估算）。 */
  private pendingSettle: boolean = false;
  /** LazyForEach 数据源：store.messages 只读投影（结构变更时对账，见类头）。 */
  private source: ChatMessagesSource = new ChatMessagesSource();
  /** 列表视口高（onAreaChange 回写；思考卡一屏限高的换算基准）。 */
  @Local listHeight: number = 0;
  /** 页面根高度（onAreaChange 回写；计划卡正文限高的换算基准。不用 List 视口
   *  高折算：权限卡出现会压缩 List，用它做限高会形成布局反馈环）。 */
  @Local rootHeight: number = 0;
  /** 消息结构变更同步回调（aboutToAppear 注册 / aboutToDisappear 反注册）。 */
  private syncSource: () => void = () => {
    const before: number = this.source.totalCount();
    this.source.syncWith(this.store.messages);
    const after: number = this.store.messages.length;
    if (before > 0 && after === 0) {
      // 复位/重载清空：重新武装——下次填充（重连 hydrate）再次底部起建
      this.pendingAnchor = true;
    } else if (this.pendingAnchor && after > 0) {
      // hydrate/重载/首条消息的首次填充：按当前消息数重建列表（见 rebuildAtTail）
      this.pendingAnchor = false;
      this.rebuildAtTail();
    }
  };

  aboutToAppear(): void {
    // 先挂数据源同步再 open：open 的复位/hydrate 结构通知一条不漏
    this.store.onMessagesStructureChanged(this.syncSource);
    this.syncSource();
    const params: Object | undefined = this.getUIContext().getRouter().getParams();
    if (params !== undefined) {
      const p: ChatPageParams = params as ChatPageParams;
      const sid: string = typeof p.sid === 'string' ? p.sid : '';
      const name: string = typeof p.name === 'string' ? p.name : '';
      if (sid !== '') {
        this.model.open(sid, name);
      }
    }
    this.model.ensureListener();
  }

  aboutToDisappear(): void {
    this.store.offMessagesStructureChanged(this.syncSource);
  }

  // ── 滚动/路由反应 ──

  @Monitor('store.tailAt')
  onTail(monitor: IMonitor): void {
    // 跟尾只在视口贴底时生效（读历史不被拽走）；底部起建保证跟随时尾部恒已
    // 构建，scrollEdge 精确贴底——无 LazyForEach 远跳估算
    if (this.isNearBottom()) {
      this.scroller.scrollEdge(Edge.Bottom);
    }
  }

  @Monitor('conn.state')
  onConnStateChange(monitor: IMonitor): void {
    // 凭据被吊销/连接被主动断开：退回列表，Index 按 conn 状态落回连接页
    const s: string = this.conn.state;
    if (s === 'needsPairing' || s === 'idle') {
      this.getUIContext().getRouter().back();
    }
  }

  // ── 滚动原语（底部起建 / 近底判定）──

  /** 列表总项数（含「加载更早」行、状态卡与瞬态工具行；近底判定基准）。 */
  private totalListItems(): number {
    let n: number = this.store.messages.length + this.store.liveActivities.length;
    if (this.store.tailOffset > 0) {
      n += 1;
    }
    if (this.store.hydrateFailed || this.store.messages.length === 0) {
      n += 1;
    }
    return n;
  }

  /** 视口是否贴底：末位可见项距列表末尾 ≤ NEAR_BOTTOM_TAIL（未量得视为贴底）。 */
  private isNearBottom(): boolean {
    return this.lastIdx < 0 || this.lastIdx >= this.totalListItems() - NEAR_BOTTOM_TAIL;
  }

  /** 底部起建锚点：最后一条消息的列表项下标（含「加载更早」/失败卡头部偏移）。 */
  private tailAnchorIndex(): number {
    let head: number = 0;
    if (this.store.tailOffset > 0) {
      head += 1;
    }
    if (this.store.hydrateFailed) {
      head += 1;
    }
    const n: number = this.store.messages.length;
    return n > 0 ? head + n - 1 : 0;
  }

  /** 销毁重建列表（listEpoch 翻转切换 if 分支）：首帧按 initialIndex 锚在
   * 最后一条；置 pendingSettle 由新列表首帧布局精确贴底。 */
  private rebuildAtTail(): void {
    this.lastIdx = -1;
    this.pendingSettle = true;
    this.listEpoch++;
  }

  // ── 交互 ──

  canSend(): boolean {
    return this.conn.state === 'authed' && this.draft.trim() !== '';
  }

  onSend(): void {
    if (!this.canSend()) {
      return;
    }
    const text: string = this.draft;
    this.draft = '';
    this.model.send(text);
    // 发送后收起键盘：清除 TextArea 焦点（发送按钮本身不可聚焦，不清则输入法常驻）
    this.getUIContext().getFocusController().clearFocus();
  }

  onBack(): void {
    this.getUIContext().getRouter().back();
  }

  showTimeGap(idx: number, ts: number): boolean {
    if (ts <= 0) {
      return false;
    }
    if (idx === 0) {
      return true;
    }
    const prev: ChatMessage | undefined = this.store.messages[idx - 1];
    return prev !== undefined && ts - prev.timestamp > TIME_GAP_MS;
  }

  // ── 顶栏 / 横幅 ──

  @Builder
  topBar() {
    Row({ space: 8 }) {
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_left'))
          .fontSize(22)
          .fontColor([$r('app.color.text_primary')])
      }
      .width(32)
      .height(32)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onBack();
      })

      Text(this.store.sessionName)
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)

      if (this.store.isBusy) {
        Text('停止')
          .fontSize(12)
          .fontColor($r('app.color.status_danger'))
          .border({ width: 1, color: $r('app.color.status_danger') })
          .borderRadius(14)
          .padding({ left: 10, right: 10, top: 3, bottom: 3 })
          .onClick(() => {
            void this.model.interrupt();
          })
      }
    }
    .width('100%')
    .padding({ left: 8, right: 12, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: { bottom: 1 }, color: $r('app.color.line') })
  }

  @Builder
  offlineBanner() {
    Row({ space: 6 }) {
      LoadingProgress().width(12).height(12).color($r('app.color.status_warn'))
      Text(this.conn.state === 'offline' ? '连接已断开，正在自动重连…' : '正在连接…')
        .fontSize(12)
        .fontColor($r('app.color.status_warn'))
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: 8, bottom: 8 })
  }

  // ── 列表头部态 ──

  @Builder
  loadOlderRow() {
    Row({ space: 6 }) {
      if (this.store.loadingOlder) {
        LoadingProgress().width(14).height(14).color($r('app.color.accent'))
        Text('加载中…').fontSize(13).fontColor($r('app.color.text_secondary'))
      } else {
        Text('加载更早的消息').fontSize(13).fontColor($r('app.color.accent'))
      }
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: 8, bottom: 8 })
    .onClick(() => {
      if (!this.store.loadingOlder) {
        this.model.loadOlder();
      }
    })
  }

  @Builder
  loadingCard() {
    Column({ space: 10 }) {
      LoadingProgress().width(28).height(28).color($r('app.color.accent'))
      Text('正在加载历史消息…').fontSize(13).fontColor($r('app.color.text_secondary'))
    }
    .width('100%')
    .padding({ top: 96, bottom: 32 })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  failedCard() {
    Column({ space: 12 }) {
      Text('历史消息加载失败').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
      Text('可能是连接中断或桌面忙，点击重试').fontSize(12).fontColor($r('app.color.text_secondary'))
      Button('重试')
        .fontSize(14)
        .fontColor(Color.White)
        .backgroundColor($r('app.color.accent'))
        .borderRadius(16)
        .height(32)
        .padding({ left: 20, right: 20 })
        .onClick(() => {
          this.model.retryHydrate();
        })
    }
    .width('100%')
    .padding({ top: 72, bottom: 32 })
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  emptyCard() {
    Column() {
      Text('发送第一条消息继续对话').fontSize(13).fontColor($r('app.color.text_secondary'))
    }
    .width('100%')
    .padding({ top: 96, bottom: 32 })
    .alignItems(HorizontalAlign.Center)
  }

  // ── 消息行 ──

  @Builder
  messageRow(m: ChatMessage, idx: number) {
    Column({ space: 8 }) {
      if (this.showTimeGap(idx, m.timestamp)) {
        Text(timeLabel(m.timestamp))
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
          .alignSelf(ItemAlign.Center)
      }
      if (m.role === 'user') {
        this.userMessage(m)
      } else {
        this.assistantMessage(m)
      }
    }
    .width('100%')
  }

  @Builder
  userMessage(m: ChatMessage) {
    Column({ space: 8 }) {
      ForEach(m.blocks, (b: ContentBlock) => {
        if (b instanceof TextBlock) {
          Text(b.text)
            .fontSize(15)
            .lineHeight(22)
            .fontColor(Color.White)
            .backgroundColor($r('app.color.accent'))
            .borderRadius({ topLeft: 16, topRight: 16, bottomLeft: 16, bottomRight: 4 })
            .padding({ left: 14, right: 14, top: 10, bottom: 10 })
            .constraintSize({ maxWidth: '82%' })
        } else if (b instanceof ToolCallBlock) {
          this.readChip(b)
        }
      }, (b: ContentBlock) => b.id)
    }
    .width('100%')
    .alignItems(HorizontalAlign.End)
  }

  /** 用户消息里的 @mention 引用文件卡片（transcript 拆出的 Read 附件，无展开态）。 */
  @Builder
  readChip(b: ToolCallBlock) {
    Row({ space: 6 }) {
      SymbolGlyph($r('sys.symbol.doc'))
        .fontSize(14)
        .fontColor([$r('app.color.text_secondary')])
      Text(toolSummary(b.input) !== '' ? toolSummary(b.input) : b.name)
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 240 })
    }
    .padding({ left: 10, right: 10, top: 7, bottom: 7 })
    .borderRadius(10)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  assistantMessage(m: ChatMessage) {
    Column({ space: 8 }) {
      if (m.modelLabel !== '') {
        Text(m.modelLabel).fontSize(11).fontColor($r('app.color.text_secondary'))
      }
      ForEach(m.blocks, (b: ContentBlock) => {
        this.blockView(b, m.streaming && m.blocks[m.blocks.length - 1] === b)
      }, (b: ContentBlock) => b.id)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  blockView(b: ContentBlock, live: boolean) {
    if (b instanceof TextBlock) {
      MarkdownText({ raw: b.text, live: live })
    } else if (b instanceof ThinkingBlock) {
      ThinkingCard({ block: b, maxHeight: this.thinkingMaxH() })
    } else if (b instanceof SubagentBlock) {
      this.subagentView(b)
    }
  }

  /** 思考卡内容一屏限高：列表视口 − 头行/边距预留，保底最小可滚高度。 */
  private thinkingMaxH(): number {
    return Math.max(this.listHeight - THINK_CAP_RESERVE, THINK_CAP_MIN);
  }

  /** 计划卡正文一屏限高：根高度折半（保底 200，短计划不撑空、长计划按钮仍在卡尾）。 */
  private planBodyMax(): number {
    return Math.max(this.rootHeight * 0.5, 200);
  }

  @Builder
  subagentView(b: SubagentBlock) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        if (b.isPending) {
          LoadingProgress().width(12).height(12).color($r('app.color.accent'))
        } else {
          Text(b.isError ? '✗' : '✓')
            .fontSize(12)
            .fontColor(b.isError ? $r('app.color.status_danger') : $r('app.color.status_ok'))
        }
        Column({ space: 2 }) {
          Text(`子代理 · ${b.agentName}`)
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
          if (b.description !== '') {
            Text(b.description)
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(14)
          .fontColor([$r('app.color.text_secondary')])
          .rotate({ angle: b.collapsed ? 0 : 180 })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        b.collapsed = !b.collapsed;
      })

      if (!b.collapsed) {
        if (b.model !== '') {
          Text(`模型 ${b.model}`).fontSize(11).fontColor($r('app.color.text_secondary')).width('100%')
        }
        if (b.prompt !== '') {
          Text(b.prompt)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(4)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
        ForEach(b.entries, (en: SubagentEntry) => {
          this.subagentEntryView(en)
        }, (en: SubagentEntry) => en.id)
        if (!b.isPending) {
          if (b.resultTruncatedBytes > 0) {
            Text(`产出已截断 ${b.resultTruncatedBytes} 字节`)
              .fontSize(10)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
          }
          Text(b.result !== '' ? b.result : '（无产出）')
            .fontSize(12)
            .fontColor(b.isError ? $r('app.color.status_danger') : $r('app.color.text_primary'))
            .maxLines(40)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
  }

  @Builder
  subagentEntryView(en: SubagentEntry) {
    if (en.type === 'tool') {
      Row({ space: 6 }) {
        if (en.result === '' && !en.isError) {
          LoadingProgress().width(10).height(10).color($r('app.color.accent'))
        } else {
          Text(en.isError ? '✗' : '✓')
            .fontSize(10)
            .fontColor(en.isError ? $r('app.color.status_danger') : $r('app.color.status_ok'))
        }
        Text(en.toolName).fontSize(11).fontColor($r('app.color.text_primary'))
        Text(toolSummary(en.input))
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    } else if (en.text !== '') {
      Text(en.text)
        .fontSize(12)
        .fontColor(en.type === 'thinking' ? $r('app.color.text_secondary') : $r('app.color.text_primary'))
        .fontStyle(en.type === 'thinking' ? FontStyle.Italic : FontStyle.Normal)
        .maxLines(8)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
  }

  // ── 瞬态工具行（V1：运行期可见，结束即焚）──

  @Builder
  liveRow(a: LiveActivity) {
    Row({ space: 8 }) {
      LoadingProgress().width(13).height(13).color($r('app.color.accent'))
      Text('正在执行')
        .fontSize(13)
        .fontColor($r('app.color.text_secondary'))
      Text(a.name)
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
      if (toolSummary(a.input) !== '') {
        Text(toolSummary(a.input))
          .fontSize(13)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ top: 2, bottom: 2 })
  }

  // ── 底部停靠区 ──

  @Builder
  sysNoteView() {
    Text(this.store.sysNote)
      .fontSize(12)
      .fontColor($r('app.color.status_warn'))
      .width('100%')
      .maxLines(2)
      .textOverflow({ overflow: TextOverflow.Ellipsis })
      .padding({ left: 16, right: 16, top: 6, bottom: 2 })
  }

  @Builder
  pendingJumpsView() {
    Column({ space: 4 }) {
      ForEach(this.store.pendingJumps, (pj: PendingJump, i: number) => {
        Row({ space: 6 }) {
          Text('待发出').fontSize(11).fontColor($r('app.color.status_warn'))
          Text(pj.text)
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }, (pj: PendingJump, i: number) => `jump-${i}`)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 2, bottom: 2 })
  }

  @Builder
  inputBarView() {
    Row({ space: 8 }) {
      TextArea({ text: this.draft, placeholder: this.store.isBusy ? '回复中，发送将排队等候' : '发送消息' })
        .onChange((value: string) => {
          this.draft = value;
        })
        .fontSize(14)
        .fontColor($r('app.color.text_primary'))
        .placeholderColor($r('app.color.text_secondary'))
        .backgroundColor($r('app.color.input_bg'))
        .borderRadius(20)
        .padding({ left: 14, right: 14, top: 9, bottom: 9 })
        .constraintSize({ minHeight: 40, maxHeight: 120 })
        .layoutWeight(1)
        .enabled(this.conn.state === 'authed')

      Row() {
        SymbolGlyph($r('sys.symbol.arrow_up'))
          .fontSize(18)
          .fontColor([Color.White])
      }
      .width(40)
      .height(40)
      .borderRadius(20)
      .backgroundColor(this.canSend() ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onSend();
      })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Bottom)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: { top: 1 }, color: $r('app.color.line') })
  }

  /** 消息时间线列表（listEpoch 翻转经 if 分支强制销毁重建，见类头滚动策略）。 */
  @Builder
  chatList() {
    List({ space: 16, scroller: this.scroller, initialIndex: this.tailAnchorIndex() }) {
      if (this.store.tailOffset > 0) {
        ListItem() {
          this.loadOlderRow()
        }
      }
      if (this.store.hydrateFailed) {
        ListItem() {
          this.failedCard()
        }
      } else if (!this.store.hydrated && this.store.messages.length === 0) {
        ListItem() {
          this.loadingCard()
        }
      } else if (this.store.hydrated && this.store.messages.length === 0) {
        ListItem() {
          this.emptyCard()
        }
      }
      // 消息时间线：LazyForEach 虚拟加载（只建可见项 + cachedCount 预建，
      // 长会话内存/首帧与已加载历史长度解耦；结构变更经数据源对账通知）
      LazyForEach(this.source, (m: ChatMessage, idx: number) => {
        ListItem() {
          this.messageRow(m, idx)
        }
      }, (m: ChatMessage) => m.id)
      ForEach(this.store.liveActivities, (a: LiveActivity) => {
        ListItem() {
          this.liveRow(a)
        }
      }, (a: LiveActivity) => a.id)
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 16, right: 16, top: 8, bottom: 16 })
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
    .cachedCount(6)
    .onScrollIndex((first: number, last: number) => {
      this.lastIdx = last;
      // 重建后的首次布局：贴底落位一次（尾部已构建，scrollEdge 无估算）
      if (this.pendingSettle && last >= this.tailAnchorIndex()) {
        this.pendingSettle = false;
        this.scroller.scrollEdge(Edge.Bottom);
      }
    })
    .onAreaChange((_o: Area, n: Area) => {
      const h: number = typeof n.height === 'number' ? n.height : 0;
      if (h > 0) {
        this.listHeight = h;
      }
    })
  }

  build() {
    Column() {
      this.topBar()

      if (this.conn.state !== 'authed') {
        this.offlineBanner()
      }

      // if 分支切换 = 销毁重建 List（见 rebuildAtTail）：重建首帧按
      // initialIndex 锚在最后一条，零滚动零动画；流式跟尾照旧走 scrollEdge
      // （仅近底时跟随，跟随时尾部恒已构建，精确贴底）
      if (this.listEpoch % 2 === 0) {
        this.chatList()
      } else {
        this.chatList()
      }

      if (this.store.bgTasks.length > 0) {
        BgTaskDock({ store: this.store })
      }
      if (this.store.sysNote !== '') {
        this.sysNoteView()
      }
      if (this.store.pendingJumps.length > 0) {
        this.pendingJumpsView()
      }
      // 弹窗期间输入框整块让位（对照原型「弹窗期间输入框隐藏」）：未决请求
      // 挂着时新消息本就会排队等答完，答完输入框回归
      if (this.store.pendingPermissions.length > 0) {
        PermissionSheet({ store: this.store, planBodyMax: this.planBodyMax() })
      } else {
        this.inputBarView()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
    .onAreaChange((_o: Area, n: Area) => {
      const h: number = typeof n.height === 'number' ? n.height : 0;
      if (h > 0) {
        this.rootHeight = h;
      }
    })
  }
}

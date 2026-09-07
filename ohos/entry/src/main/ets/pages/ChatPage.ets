/**
 * 聊天主屏（v3：常驻组件，Index authed 后直接渲染；不再 @Entry / 路由参数）。
 *
 * 结构（对照 design/remote/app.html 屏 2 .ch-*）：
 *  - 顶栏：☰ 开抽屉 + 标题/副标题（工作区色点 + 名称，纯展示）+ ⏹ 停止会话
 *    （常驻：闲态置灰点击 toast 提示；回复中转红，点击 interrupt——残段冻结
 *    后落「已停止会话」系统分隔线，见 ChatModel.interrupt）
 *  - 新会话空态（store.sid 为空）：logo + 「新会话」+「发消息即创建 · 发往
 *    工作区 X」——首条消息即 spawn（ChatModel.send 空态分支）
 *  - toast 宿主：toastModel 全局单例（抽屉切换供应商/工作区/会话等轻提示）
 *  - 输入区工具行（原型 .ch-bar）：模型/思考程度两 chip，弹层为自绘小面板
 *    （.md-pop/.ef-pop：全屏遮罩 + 锚输入栏上方，返回键经 store.handlePopups 收）
 *  - 抽屉：ChatDrawer（自遮罩 + 左滑面板 + 供应商/工作区半模态）
 *  - 连接状态反应：needsPairing / idle 不再 router.back——Index 观察 conn
 *    状态自动落回连接页
 *
 * 保留不动（V1 语义）：消息时间线（思考卡 + 瞬态工具行 + LazyForEach 虚拟
 * 加载）、权限弹层、后台任务停靠区、发送/排队输入区。
 *
 * V1 排版语义（对照 design/chat-layout-mock.html）：
 *  - 永久驻留：用户气泡 / assistant 正文 / 可折叠思考卡 / @引用文件小卡片
 *  - 主线程工具调用（bash/read/grep/glob…）只走 store.liveActivities 瞬态行：
 *    运行期出现在时间线末尾，tool_result / 轮次收尾即整行消失，不进 blocks
 *  - 子代理块保留（默认收起，过程可点开）；历史思考默认收起
 * 视觉基线：白卡 card_bg + 1px line 描边、间距统一 8 的倍数、图标统一 sys.symbol。
 * 信息架构对照 remote-pwa 的 ChatView/MessageList/PermissionSheet 三件套
 * （状态与编排全在 ChatModel/ChatStore，页面零业务逻辑）。
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
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ChatModel, chatModel, EFFORT_TIERS, effortLabel, modelDisplayName } from '../session/ChatModel';
import { EffortTier } from '../session/ChatModel';
import { ModelOption } from '../sdk/types';
import { ProviderMark } from '../session/ProviderLogos';
import { ProviderModel, providerModel } from '../session/ProviderModel';
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
import { ChatDrawer, drawerState, toastModel, ToastModel, wsAccentColor } from '../session/ChatDrawer';
import { WorkspaceModel, workspaceModel } from '../session/WorkspaceModel';

/** 相邻消息间隔超过 10 分钟插时间分隔线（对照 MessageList GAP_MS）。 */
const TIME_GAP_MS: number = 10 * 60 * 1000;

/** 思考卡内容一屏限高的预留：卡片头行 + 分隔线 + 卡内外边距与上下文余量。 */
const THINK_CAP_RESERVE: number = 120;

/** 思考卡内容区保底高度（视口未量得/极小时的兜底，保证仍可滚）。 */
const THINK_CAP_MIN: number = 160;

/** 近底判定：末位可见项距列表末尾不超过此项数即视为贴底，流式跟尾才生效。 */
const NEAR_BOTTOM_TAIL: number = 3;

/** toast 深底（原型 rgba(29,33,41,.9)）。 */
const TOAST_BG: ResourceColor = '#E61D2129';

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

@ComponentV2
export struct ChatPage {
  @Local conn: ConnModel = connModel;
  @Local store: ChatStore = chatModel.store;
  @Local ws: WorkspaceModel = workspaceModel;
  @Local toast: ToastModel = toastModel;
  @Local pv: ProviderModel = providerModel;
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
  /** 工具行实测高（onAreaChange 回写；浮层底缘锚定的换算基准：底缘 = 输入栏
   *  底 padding 8 + 工具行高 + 间距 8 = 工具行上缘再让 8px，对照原型
   *  .md-pop bottom: calc(100% + 8px)——面板浮在输入框区上方，紧贴其 chip）。 */
  @Local chipBarHeight: number = 0;
  /** 模型 chip 实测宽（onAreaChange 回写；思考程度浮层的左缘锚定基准）。 */
  @Local modelChipWidth: number = 0;
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
    // 先挂数据源同步再进屏：open/复位的结构通知一条不漏（会话由抽屉打开）
    this.store.onMessagesStructureChanged(this.syncSource);
    this.syncSource();
    this.model.ensureListener();
    // 模型/effort 域首同步（供应商未加载时 syncModelEffort 自行补拉）
    void this.model.syncModelEffort();
  }

  aboutToDisappear(): void {
    this.store.offMessagesStructureChanged(this.syncSource);
    drawerState.close(); // 浮层随卸载复位：单例不随组件销毁，防落回连接页后残置
  }

  // ── 滚动反应 ──

  @Monitor('store.tailAt')
  onTail(monitor: IMonitor): void {
    // 跟尾只在视口贴底时生效（读历史不被拽走）；底部起建保证跟随时尾部恒已
    // 构建，scrollEdge 精确贴底——无 LazyForEach 远跳估算
    if (this.isNearBottom()) {
      this.scroller.scrollEdge(Edge.Bottom);
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

  /** 停止会话可点（interrupt_session 语义；闲态置灰）。 */
  canStop(): boolean {
    return this.store.isBusy && this.conn.state === 'authed';
  }

  onStopTap(): void {
    if (this.conn.state !== 'authed') {
      toastModel.show('设备离线', 'warn');
      return;
    }
    if (!this.store.isBusy) {
      toastModel.show('当前没有进行中的回复', 'info');
      return;
    }
    void this.model.interrupt();
    toastModel.show('已停止会话', 'warn');
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
    Row({ space: 4 }) {
      // ☰ 开抽屉
      Row() {
        SymbolGlyph($r('sys.symbol.list_bullet'))
          .fontSize(20)
          .fontColor([$r('app.color.text_secondary')])
      }
      .width(34)
      .height(34)
      .borderRadius(10)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        drawerState.openDrawer();
      })

      // 标题 + 副标题（工作区色点 + 名称，纯展示——切换都收在抽屉里）
      Column({ space: 3 }) {
        Text(this.store.sessionName !== '' ? this.store.sessionName : '新会话')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .constraintSize({ maxWidth: '82%' })
        Row({ space: 5 }) {
          Circle()
            .width(6)
            .height(6)
            .fill(wsAccentColor(this.ws.displayKey()))
          Text(this.ws.selectedDisplayName())
            .fontSize(10.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Center)

      // ⏹ 停止会话（常驻：闲态置灰，回复中转红）
      Row() {
        Stack() {
          Circle()
            .width(20)
            .height(20)
            .fill(Color.Transparent)
            .stroke(this.canStop() ? $r('app.color.status_danger') : $r('app.color.btn_disabled_bg'))
            .strokeWidth(1.6)
          Rect()
            .width(7)
            .height(7)
            .radius(1.6)
            .fill(this.canStop() ? $r('app.color.status_danger') : $r('app.color.btn_disabled_bg'))
        }
      }
      .width(34)
      .height(34)
      .borderRadius(10)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onStopTap();
      })
    }
    .width('100%')
    .padding({ left: 10, right: 10, top: 8, bottom: 10 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: { bottom: 1 }, color: $r('app.color.line') })
  }

  @Builder
  offlineBanner() {
    Row({ space: 8 }) {
      LoadingProgress().width(11).height(11).color($r('app.color.status_warn'))
      Text(this.conn.state === 'offline' ? '设备离线，自动重连中…' : '正在连接…')
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.status_warn'))
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ top: 7, bottom: 7 })
    .backgroundColor($r('app.color.status_warn_weak'))
  }

  /** toast 宿主（原型 ch-toast：顶栏下方居中，2 秒自动隐藏）。 */
  @Builder
  toastView() {
    Row({ space: 7 }) {
      Circle()
        .width(6)
        .height(6)
        .fill(this.toastKindColor())
      Text(this.toast.message)
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor(Color.White)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 300 })
    }
    .padding({ left: 15, right: 15, top: 8, bottom: 8 })
    .borderRadius(99)
    .backgroundColor(TOAST_BG)
    .alignItems(VerticalAlign.Center)
    .margin({ top: 96 })
    .transition(TransitionEffect.OPACITY.combine(TransitionEffect.translate({ y: -8 }))
      .animation({ duration: 300, curve: Curve.EaseOut }))
  }

  private toastKindColor(): ResourceColor {
    if (this.toast.kind === 'ok') {
      return $r('app.color.status_ok');
    }
    if (this.toast.kind === 'warn') {
      return $r('app.color.status_warn');
    }
    return $r('app.color.accent');
  }

  // ── 新会话空态 ──

  /** 空态（store.sid 为空）：首条消息即 spawn，发往手机侧所选工作区。 */
  @Builder
  emptyState() {
    Column({ space: 7 }) {
      Row() {
        Text('a')
          .fontSize(30)
          .fontWeight(FontWeight.Bold)
          .fontColor(Color.White)
      }
      .width(56)
      .height(56)
      .borderRadius(16)
      .linearGradient({ angle: 135, colors: [['#4C8DFF', 0], ['#0A59F7', 1]] })
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .margin({ bottom: 3 })

      Text('新会话')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))

      Text() {
        Span('发消息即创建')
          .fontSize(12)
          .fontColor($r('app.color.text_secondary'))
        if (this.ws.selectedKey === '' && this.ws.activeDisplayName() === '') {
          // 跟随桌面且未解析出真名——保持占位文案
          Span(' · 发往桌面当前工作区')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
        } else {
          // 选定具体工作区，或跟随槽位已解析真名——点名展示
          Span(' · 发往工作区 ')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
          Span(this.ws.selectedDisplayName())
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.accent'))
        }
      }
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .padding({ left: 30, right: 30 })
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
    if (m.role === 'system') {
      this.systemDivider(m)
    } else {
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
  }

  /** 系统分隔线（原型 m-sys：两侧细线 + accent 文案；中断标记等 UI 痕迹）。 */
  @Builder
  systemDivider(m: ChatMessage) {
    Row({ space: 10 }) {
      Column()
        .height(1)
        .layoutWeight(1)
        .backgroundColor($r('app.color.line'))
      Text(this.systemTextOf(m))
        .fontSize(11)
        .fontColor($r('app.color.accent'))
      Column()
        .height(1)
        .layoutWeight(1)
        .backgroundColor($r('app.color.line'))
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ top: 2, bottom: 2 })
  }

  private systemTextOf(m: ChatMessage): string {
    const b: ContentBlock | undefined = m.blocks[0];
    return b instanceof TextBlock ? b.text : '';
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
    // 原型 .ch-input：输入行在上、工具行（.ch-bar 两 chip）在下
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        TextArea({ text: this.draft, placeholder: this.store.isBusy ? '回复中，发送将排队等候' : '发送消息' })
          .onChange((value: string) => {
            this.draft = value;
          })
          .onFocus(() => {
            // 键盘弹起让位 chip 浮层：聚焦即收（浮层经遮罩/返回键亦可收）
            this.store.handlePopups();
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
      .alignItems(VerticalAlign.Bottom)

      // 工具行（原型 .ch-bar）：模型 / 思考程度
      Row({ space: 8 }) {
        this.modelChip()
        this.effortChip()
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .onAreaChange((_o: Area, n: Area) => {
        const h: number = typeof n.height === 'number' ? n.height : 0;
        if (h > 0) {
          this.chipBarHeight = h;
        }
      })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: { top: 1 }, color: $r('app.color.line') })
  }

  // ── 模型 / 思考程度 chip + 浮层（原型 .md-chip/.ef-chip/.md-pop/.ef-pop）──

  /** 模型 chip：供应商商标 + 模型名 + 下折角标。 */
  @Builder
  modelChip() {
    Row({ space: 5 }) {
      ProviderMark({ p: this.pv.activeProvider(), markSize: 12, tint: $r('app.color.text_secondary') })
      Text(this.modelChipLabel())
        .fontSize(11)
        .fontWeight(600)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 118 })
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(9)
        .fontColor([$r('app.color.text_secondary')])
        .opacity(0.6)
    }
    .padding({ left: 11, right: 11, top: 4, bottom: 4 })
    .borderRadius(99)
    .backgroundColor($r('app.color.input_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onModelChipTap();
    })
    .onAreaChange((_o: Area, n: Area) => {
      const w: number = typeof n.width === 'number' ? n.width : 0;
      if (w > 0) {
        this.modelChipWidth = w;
      }
    })
  }

  /** 思考程度 chip：warn 色档位图标 + 「思考 · 档名」+ 下折角标。 */
  @Builder
  effortChip() {
    Row({ space: 5 }) {
      SymbolGlyph(this.effortIcon(this.store.effort))
        .fontSize(11)
        .fontColor([$r('app.color.status_warn')])
      Text(`思考 · ${effortLabel(this.store.effort)}`)
        .fontSize(11)
        .fontWeight(600)
        .fontColor($r('app.color.text_secondary'))
        .maxLines(1)
      SymbolGlyph($r('sys.symbol.chevron_down'))
        .fontSize(9)
        .fontColor([$r('app.color.text_secondary')])
        .opacity(0.6)
    }
    .padding({ left: 11, right: 11, top: 4, bottom: 4 })
    .borderRadius(99)
    .backgroundColor($r('app.color.input_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.store.effortPop = !this.store.effortPop;
      this.store.modelPop = false;
    })
  }

  /** 模型浮层（原型 .md-pop：宽 236、radius 14、选项行 accent 描边 + 勾）。
   *  结构同供应商弹层：遮罩即全屏容器（点空白收起），面板为子节点（空 onClick
   *  防落穿），底缘锚在工具行上方 8px（chipBarHeight + 输入栏底 padding 8 + 间距 8）。 */
  @Builder
  modelPopView() {
    Column() {
      Column() {
        ForEach(this.store.modelOptions, (o: ModelOption) => {
          this.modelOptRow(o)
        }, (o: ModelOption) => o.value)
        if (this.store.modelOptions.length === 0) {
          Text('正在获取模型列表…')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: 14, bottom: 14 })
        }
      }
      .width(236)
      .padding(6)
      .borderRadius(14)
      .backgroundColor($r('app.color.card_bg'))
      .border({ width: 1, color: $r('app.color.line') })
      .shadow({ radius: 36, color: '#241D2129', offsetX: 0, offsetY: 12 })
      .margin({ left: 12, bottom: this.chipBarHeight + 16 })
      .onClick(() => {
        // 空点击拦截落穿：面板内空白不关浮层（选项行有自己的 onClick）
      })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.End)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 遮罩即容器：空白处点击收起（面板子节点因手势竞争不触发此 onClick）
      this.store.handlePopups();
    })
    .transition(TransitionEffect.OPACITY.animation({ duration: 220 }))
  }

  /** 模型选项行（原型 .opt：名称 + mono id + 选中描边/勾；md-pop 无图标位）。 */
  @Builder
  modelOptRow(o: ModelOption) {
    Row({ space: 6 }) {
      Text(o.displayName)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize(o.value !== o.displayName ? { maxWidth: 96 } : { maxWidth: 160 })
      if (o.value !== o.displayName) {
        Text(o.value)
          .fontSize(10)
          .fontColor($r('app.color.text_secondary'))
          .fontFamily('monospace')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
      } else {
        Column().layoutWeight(1)
      }
      if (this.isModelActive(o.value)) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(15)
          .fontColor([$r('app.color.accent')])
      }
    }
    .width('100%')
    .padding(11)
    .borderRadius(14)
    .backgroundColor(this.isModelActive(o.value) ? $r('app.color.accent_weak') : Color.Transparent)
    .border({
      width: 1.5,
      color: this.isModelActive(o.value) ? $r('app.color.accent') : Color.Transparent
    })
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: 6 })
    .onClick(() => {
      this.onModelPick(o.value);
    })
  }

  /** 思考程度浮层（原型 .ef-pop：宽 218；选项行带 30px 档位图标圆）。
   *  结构同模型浮层：遮罩即全屏容器，左缘锚在思考 chip（模型 chip 右缘 + 间距 8）。 */
  @Builder
  effortPopView() {
    Column() {
      Column() {
        ForEach(EFFORT_TIERS, (t: EffortTier) => {
          this.effortOptRow(t)
        }, (t: EffortTier) => t.value)
      }
      .width(218)
      .padding(6)
      .borderRadius(14)
      .backgroundColor($r('app.color.card_bg'))
      .border({ width: 1, color: $r('app.color.line') })
      .shadow({ radius: 36, color: '#241D2129', offsetX: 0, offsetY: 12 })
      .margin({ left: 12 + this.modelChipWidth + 8, bottom: this.chipBarHeight + 16 })
      .onClick(() => {
        // 空点击拦截落穿
      })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.End)
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 遮罩即容器：空白处点击收起
      this.store.handlePopups();
    })
    .transition(TransitionEffect.OPACITY.animation({ duration: 220 }))
  }

  /** 思考档选项行（原型 .opt：档位图标圆 + 档名 + mono 档值 + 描述 + 勾）。 */
  @Builder
  effortOptRow(t: EffortTier) {
    Row({ space: 11 }) {
      Row() {
        SymbolGlyph(this.effortIcon(t.value))
          .fontSize(13)
          .fontColor([$r('app.color.text_primary')])
      }
      .width(30)
      .height(30)
      .borderRadius(15)
      .backgroundColor($r('app.color.input_bg'))
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)

      Column({ space: 1 }) {
        Row({ space: 6 }) {
          Text(t.label)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
          Text(t.value)
            .fontSize(10)
            .fontColor($r('app.color.text_secondary'))
            .fontFamily('monospace')
        }
        .alignItems(VerticalAlign.Center)
        Text(t.desc)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.store.effort === t.value) {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(15)
          .fontColor([$r('app.color.accent')])
      }
    }
    .width('100%')
    .padding(9)
    .borderRadius(14)
    .backgroundColor(this.store.effort === t.value ? $r('app.color.accent_weak') : Color.Transparent)
    .border({
      width: 1.5,
      color: this.store.effort === t.value ? $r('app.color.accent') : Color.Transparent
    })
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: 6 })
    .onClick(() => {
      this.onEffortPick(t.value);
    })
  }

  /** 档位图标（原型 EF_ICONS：低=闪电 / 中=天平 / 高=钻石；sys.symbol 无天平，
   * 以表盘 dial 代「均衡/有度」意）。 */
  private effortIcon(v: string): Resource {
    if (v === 'low') {
      return $r('sys.symbol.bolt');
    }
    if (v === 'max') {
      return $r('sys.symbol.diamond');
    }
    return $r('sys.symbol.dial');
  }

  /** chip 文案：选中项展示名 → 默认（选项集首位）→ 占位「模型」。 */
  private modelChipLabel(): string {
    if (this.store.modelOptions.length === 0) {
      return '模型';
    }
    const name: string | null = modelDisplayName(this.store.modelOptions, this.store.model);
    if (name !== null) {
      return name;
    }
    return this.store.modelOptions[0].displayName;
  }

  /** 选项是否为当前生效模型（store.model 为空 = 默认首位）。 */
  private isModelActive(v: string): boolean {
    if (this.store.model !== '') {
      return this.store.model === v;
    }
    return this.store.modelOptions.length > 0 && this.store.modelOptions[0].value === v;
  }

  private onModelChipTap(): void {
    const opening: boolean = !this.store.modelPop;
    this.store.modelPop = opening;
    this.store.effortPop = false;
    if (opening && this.store.modelOptions.length === 0) {
      // 选项集缺失兜底重同步（离线期点击 / 同步竞态的自愈通道）
      void this.model.syncModelEffort();
    }
  }

  private onModelPick(value: string): void {
    this.store.modelPop = false;
    this.model.pickModel(value).then((r: string) => {
      if (r === 'live') {
        toastModel.show('已切换模型', 'ok');
      } else if (r === 'deferred') {
        toastModel.show('已选择模型 · 下一条消息生效', 'info');
      } else if (r === 'spawn') {
        toastModel.show('已选择模型 · 随首条消息生效', 'info');
      } else if (r === 'error') {
        toastModel.show('切换失败，请重试', 'warn');
      }
    });
  }

  private onEffortPick(value: string): void {
    this.store.effortPop = false;
    this.model.pickEffort(value).then((r: string) => {
      if (r === 'live') {
        toastModel.show('已切换思考程度', 'ok');
      } else if (r === 'deferred') {
        toastModel.show('已选择思考程度 · 下一条消息生效', 'info');
      } else if (r === 'spawn') {
        toastModel.show('已选择思考程度 · 随首条消息生效', 'info');
      } else if (r === 'error') {
        toastModel.show('切换失败，请重试', 'warn');
      }
    });
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
    Stack({ alignContent: Alignment.Top }) {
      // 主列：顶栏 / 横幅 / 时间线或空态 / 停靠区 / 输入区
      Column() {
        this.topBar()

        if (this.conn.state !== 'authed') {
          this.offlineBanner()
        }

        if (this.store.sid === '') {
          // 新会话空态：首条消息即 spawn（发往所选工作区），时间线让位
          this.emptyState()
        } else {
          // if 分支切换 = 销毁重建 List（见 rebuildAtTail）：重建首帧按
          // initialIndex 锚在最后一条，零滚动零动画；流式跟尾照旧走 scrollEdge
          //（仅近底时跟随，跟随时尾部恒已构建，精确贴底）
          if (this.listEpoch % 2 === 0) {
            this.chatList()
          } else {
            this.chatList()
          }
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

      // chip 浮层（自绘小面板：遮罩 + 锚输入栏上方；toast/抽屉之下）
      if (this.store.modelPop) {
        this.modelPopView()
      }
      if (this.store.effortPop) {
        this.effortPopView()
      }

      // toast 宿主（顶栏下方居中；toastModel 由抽屉/本页共享写入）
      if (this.toast.message !== '') {
        this.toastView()
      }

      // 抽屉（自遮罩 + 左滑面板 + 供应商/工作区半模态；关闭时零渲染）
      ChatDrawer()
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

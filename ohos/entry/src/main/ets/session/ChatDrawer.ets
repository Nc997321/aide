/**
 * 抽屉组件（v3：聊天升主屏，会话列表收进左侧抽屉）——对照 design/remote/
 * app.html 的 .dr-panel 结构：设备卡（logo + 连接状态点 + 供应商徽标 + ⏻
 * 断开）/ 工作区卡（色彩字母头像 + 名称/路径/三态计数 + 切换；日常态 =
 * 气泡头像 + 定位副标题占掉路径行）/ 自动化区
 * 段（呼吸点 + 折叠 + ＋ 新建；任务行两行制 + 行内启停小开关）/ 历史会话
 *（＋ 新会话 + ↻ 刷新 + 三态状态点列表）/ 底部搜索框，外加供应商、工作区
 * 两个半模态弹层。
 *
 *  - 开合状态（drawerState，含两个半模态开关）与轻提示（toastModel）是全局
 *    单例：ChatPage 顶栏 ☰ 与 toast 宿主（ChatPage 挂载）跨组件共享；系统
 *    返回经 Index.onBackPress → drawerState.handleBack 逐层收起，@Trace 深度观察
 *  - 三态状态点：待确认（橙，呼吸）> 回复中（绿，呼吸）> 已启动（蓝，静态），
 *    列表只留点不带文字；颜色语义的文字说明只在工作区卡计数处（原型同）
 *  - 自动化区段（原型 design/automation/app.html .aut-sec，位置紧跟工作区
 *    卡）：列表四态——首拉加载中 / 拉取失败（11 命令未进远程 REGISTRY 时的
 *    常态，错误条 + 重试入口）/ 空态引导新建 / 任务行（有旧行时刷新失败照
 *    显旧行）；行点击开详情浮层不收抽屉（浮层全屏盖住，返回时抽屉仍在——
 *    原型 backFs 同款）；小开关 hitTestBehavior(Block) 阻冒泡（ArkUI 默认
 *    父子点击同时触发）
 *  - 会话点击 = chatModel.open 切会话（同会话幂等收敛，只收抽屉）；待确认
 *    会话切换后 toast 提示「有请求等待确认」；preview 文本为协议缺口，不展示
 *  - 设备卡 ⏻ 断开（原型 dr-quit 同位）：先收抽屉再 disconnectAll——Index
 *    观察 conn 状态落回连接页（原 SessionsPage 顶栏断开入口随任务 5 迁入）
 *  - 半模态自绘（遮罩 + 底部面板 + transition），不依赖 bindSheet——与原型
 *    像素对齐，且选中描边/脚注/呼吸点均可用现有资源表达
 *  - 弹层计数快照来自 WorkspaceModel.loadMetas（'' 槽位 + 日常 + 各工作区
 *    并行拉取）；工作区切换只改浏览范围与 spawn 去向，不改桌面活动工作区
 *    （协议无写 RPC；读走 get_active_workspace，跟随槽位解析真名）
 *  - 「日常」行置顶弹层首行（design/daily/app.html 原型）：气泡头像 +
 *    「默认」角标 + 定位副标题，无路径行——日常路径是内部概念永不展示
 *    （桌面 spec：docs/superpowers/specs/2026-09-20-daily-mode-design.md）；
 *    旧桌面无 daily_workspace RPC 时整个日常层不存在，列表与升级前一致
 *  - 主机名固定「桌面 aide」：PairOk 只有 device_id + token，协议无主机名来源
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ChatModel, chatModel } from './ChatModel';
import { ChatStore } from './chat/ChatStore';
import { SessionsModel, sessionsModel } from './SessionsModel';
import { WorkspaceModel, workspaceModel, WsMeta, baseName } from './WorkspaceModel';
import { ProviderModel, providerModel } from './ProviderModel';
import { ProviderMark } from './ProviderLogos';
import { Session, WorkspaceInfo, ProviderConfigView, AutomationTask } from '../sdk/types';
import { automationModel, AutomationModel } from './AutomationModel';
import { scheduleText, shortTime } from './AutomationFormat';

/** 遮罩色（原型 rgba(29,33,41,.4)）。 */
const MASK_COLOR: ResourceColor = '#661D2129';

/** 工作区色彩字母头像调色板（前景 + 弱色底；key 哈希取色，稳定不变）。 */
const WS_COLORS: string[] = ['#0A59F7', '#0FA3A3', '#F77234', '#00B42A', '#722ED1', '#F53F3F'];
const WS_TINTS: string[] = ['#140A59F7', '#140FA3A3', '#14F77234', '#1400B42A', '#14722ED1', '#14F53F3F'];

/** 日常行专用视觉：固定暖橙（不进哈希取色），对齐桌面侧栏「日常」分区与
 *  原型 design/daily/app.html 的 DAILY_FAKE 配色；DESC 为定位副标题
 *  （占掉路径行——内部目录永不展示）。 */
const DAILY_COLOR: string = '#F77234';
const DAILY_TINT: string = '#14F77234';
const DAILY_DESC: string = '随手问答的默认去处 · 与桌面共用';

function wsColorIdx(key: string): number {
  let h: number = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) % 9973;
  }
  return h % WS_COLORS.length;
}

/** 工作区强调色（顶栏副标题色点 / 空态文案用；与抽屉头像同源同色）；
 *  日常键固定暖橙（其余 key 哈希取色）。 */
export function wsAccentColor(key: string): string {
  if (workspaceModel.isDaily(key)) {
    return DAILY_COLOR;
  }
  return WS_COLORS[wsColorIdx(key)];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 相对时间（原型 sv-time：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / M月D日）。 */
function relTime(ms: number): string {
  if (ms <= 0) {
    return '';
  }
  const now: number = Date.now();
  const diff: number = now - ms;
  if (diff < 60 * 1000) {
    return '刚刚';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  }
  const d: Date = new Date(ms);
  const hhmm: string = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const y: Date = new Date(now - 24 * 60 * 60 * 1000);
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
    return `昨天 ${hhmm}`;
  }
  const n: Date = new Date(now);
  if (d.getFullYear() === n.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 供应商 kind（snake_case 枚举）→ 短名。 */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'system_default':
      return '系统默认';
    case 'cpa_gpt':
      return 'CPA GPT';
    case 'ollama':
      return 'Ollama';
    case 'kimi':
      return 'Kimi';
    case 'deepseek':
      return 'DeepSeek';
    case 'zhipu':
      return '智谱 AI';
    case 'qwen':
      return '通义千问';
    case 'custom':
      return '自定义';
    default:
      return kind;
  }
}

/** 抽屉开合全局态：ChatPage 顶栏 ☰ 与抽屉本体跨组件共享；两个半模态开关同宿
 * 于此，供 Index.onBackPress 统一消费系统返回（页面级返回只落在唯一 @Entry）。 */
@ObservedV2
export class DrawerState {
  @Trace open: boolean = false;
  /** 供应商/工作区半模态（只随抽屉开；close 一并收起）。 */
  @Trace pvSheet: boolean = false;
  @Trace wsSheet: boolean = false;

  openDrawer(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.pvSheet = false;
    this.wsSheet = false;
  }

  /** 系统返回逐层收起：半模态 > 抽屉；无浮层返回 false 交还默认行为（退出）。 */
  handleBack(): boolean {
    if (this.pvSheet) {
      this.pvSheet = false;
      return true;
    }
    if (this.wsSheet) {
      this.wsSheet = false;
      return true;
    }
    if (this.open) {
      this.close();
      return true;
    }
    return false;
  }
}

export const drawerState: DrawerState = new DrawerState();

/** 轻提示（原型 ch-toast）：2 秒自动隐藏；宿主由 ChatPage 渲染。 */
@ObservedV2
export class ToastModel {
  @Trace message: string = '';
  /** 'ok' | 'warn' | 'info'（宿主映射状态点颜色）。 */
  @Trace kind: string = 'info';
  private timer: number = -1;

  show(message: string, kind: string): void {
    this.message = message;
    this.kind = kind;
    if (this.timer >= 0) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.message = '';
    }, 2000);
  }
}

export const toastModel: ToastModel = new ToastModel();

/** 工作区弹层选项行（'' 槽位 = 跟随桌面；日常行由 wsOptions 置顶首插）。 */
class WsOpt {
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly missing: boolean;

  constructor(key: string, name: string, path: string, missing: boolean) {
    this.key = key;
    this.name = name;
    this.path = path;
    this.missing = missing;
  }
}

/** 呼吸状态点（待确认/回复中）：无限交替透明度；组件销毁动画随之终止。
 * 成员命名 dotSize/pulseOpacity：size/opacity 撞 CustomComponent 通用属性。 */
@ComponentV2
struct PulseDot {
  @Param color: ResourceColor = '#FF7D00';
  @Param dotSize: number = 7;
  @Local pulseOpacity: number = 1;

  build() {
    // 容器圆替代 Circle().fill()：drawing 组件 fill 在本 SDK 是 API 26 兼容告警
    Column()
      .width(this.dotSize)
      .height(this.dotSize)
      .borderRadius(this.dotSize / 2)
      .backgroundColor(this.color)
      .opacity(this.pulseOpacity)
      .onAppear(() => {
        this.getUIContext().animateTo(
          { duration: 1100, curve: Curve.EaseInOut, iterations: -1, playMode: PlayMode.Alternate },
          () => {
            this.pulseOpacity = 0.4;
          }
        );
      })
  }
}

@ComponentV2
export struct ChatDrawer {
  @Local conn: ConnModel = connModel;
  @Local sm: SessionsModel = sessionsModel;
  @Local ws: WorkspaceModel = workspaceModel;
  @Local pv: ProviderModel = providerModel;
  @Local chat: ChatModel = chatModel;
  @Local store: ChatStore = chatModel.store;
  @Local dr: DrawerState = drawerState;
  @Local query: string = '';
  @Local am: AutomationModel = automationModel;
  /** 自动化区段折叠（纯 UI 态，不进模型；默认展开）。 */
  @Local autCollapsed: boolean = false;

  aboutToAppear(): void {
    // 挂载即武装三态监听（抽屉未开也要推导——徽标数据全程有效）并补首拉
    this.sm.ensureListener();
    // 工作区模型的重连监听同点挂载：断线期间错过的日常/列表在重连后自愈
    this.ws.ensureListener();
    if (!this.sm.loaded) {
      void this.sm.refresh();
    }
    // 工作区列表 + 活动工作区首拉：顶栏/工作区卡随挂载即有真名（非 authed 时
    // refresh 内部守卫跳过，重连后开抽屉/弹层补拉）
    void this.ws.refresh();
  }

  @Monitor('dr.open')
  onDrawerToggle(monitor: IMonitor): void {
    if (!this.dr.open) {
      // 关抽屉时收起弹层：下次打开不残留（close() 已收，此处兜底直赋值路径）
      this.dr.pvSheet = false;
      this.dr.wsSheet = false;
      return;
    }
    // 每次开抽屉都重拉工作区（列表 + 活动工作区）：真名跟随桌面切换、桌面新
    // 开项目即入列；refresh 防重入，成本 = 两路并行 RPC
    void this.ws.refresh();
    if (!this.pv.loaded) {
      void this.pv.refresh();
    }
    // 自动化区段首拉（已加载不重拉，重开不闪；REGISTRY 未开口子时错误条接管）
    this.am.ensureLoaded();
  }

  // ── 交互 ──

  private filteredSessions(): Session[] {
    const kw: string = this.query.trim().toLowerCase();
    if (kw === '') {
      return this.sm.sessions;
    }
    const out: Session[] = [];
    for (let i = 0; i < this.sm.sessions.length; i++) {
      if (this.sm.sessions[i].name.toLowerCase().indexOf(kw) >= 0) {
        out.push(this.sm.sessions[i]);
      }
    }
    return out;
  }

  private activePvName(): string {
    const p: ProviderConfigView | null = this.pv.activeProvider();
    return p !== null ? p.name : '供应商';
  }

  /** 供应商行副标题：kind 短名；未配置密钥追加提示（脱敏视图只有布尔）。 */
  private providerDesc(p: ProviderConfigView): string {
    if (p.kind === 'system_default') {
      return '跟随桌面设置的首选供应商';
    }
    const configured: boolean = p.apiKeyConfigured || p.authTokenConfigured;
    return kindLabel(p.kind) + (configured ? '' : ' · 未配置密钥');
  }

  private wsOptions(): WsOpt[] {
    const out: WsOpt[] = [];
    // 日常行置顶（新桌面才有：daily 为 null 的旧桌面无此行，列表与升级前一致）
    if (this.ws.daily !== null) {
      out.push(new WsOpt(this.ws.daily.key, '日常', '', false));
    }
    out.push(new WsOpt('', '当前工作区', '', false));
    for (let i = 0; i < this.ws.workspaces.length; i++) {
      const w: WorkspaceInfo = this.ws.workspaces[i];
      out.push(new WsOpt(w.key, baseName(w.name), w.name, w.missing));
    }
    return out;
  }

  /** 弹层计数快照取值（null = 未拉取，UI 隐藏该段）。 */
  private metaTotalText(key: string): string {
    const m: WsMeta | null = this.ws.metaOfKey(key);
    return m !== null ? `${m.total} 个会话` : '';
  }

  private wsMetaCount(key: string, which: string): number {
    const m: WsMeta | null = this.ws.metaOfKey(key);
    if (m === null) {
      return 0;
    }
    if (which === 'started') {
      return m.started;
    }
    if (which === 'live') {
      return m.live;
    }
    return m.wait;
  }

  onSessionTap(s: Session): void {
    if (s.id === this.store.sid) {
      this.dr.close(); // 当前会话：幂等收敛，不重开不重拉
      return;
    }
    this.chat.open(s.id, s.name);
    this.dr.close();
    if (this.sm.statusOf(s.id) === 'wait') {
      toastModel.show(`已切换到「${s.name}」· 有请求等待确认`, 'warn');
    } else {
      toastModel.show(`已切换到「${s.name}」`, 'ok');
    }
  }

  onNewSession(): void {
    this.chat.newSession();
    this.dr.close();
  }

  /** 断开（原型 dr-quit）：先收抽屉（drawerState 单例不随卸载复位）再断传输。 */
  onDisconnectTap(): void {
    this.dr.close();
    this.conn.disconnectAll();
  }

  onPvBadgeTap(): void {
    if (this.conn.state !== 'authed') {
      toastModel.show('设备离线，无法切换供应商', 'warn');
      return;
    }
    this.dr.wsSheet = false;
    this.dr.pvSheet = true;
    void this.pv.refresh(); // 每次打开重拉兜底（供应商配置低频变化）
  }

  async onPvPick(p: ProviderConfigView): Promise<void> {
    this.dr.pvSheet = false;
    if (p.id === this.pv.activeId) {
      return;
    }
    const ok: boolean = await this.pv.setActive(p.id);
    if (ok) {
      toastModel.show(`已切换到 ${p.name}`, 'ok');
      // 切供应商：模型/effort 域随新供应商重解析（会话记忆不在新选项集内回落默认）
      void this.chat.syncModelEffort();
    } else {
      toastModel.show('切换失败，请重试', 'warn');
    }
  }

  onWsCardTap(): void {
    if (this.conn.state !== 'authed') {
      toastModel.show('设备离线，无法切换工作区', 'warn');
      return;
    }
    this.dr.pvSheet = false;
    this.dr.wsSheet = true;
    void this.ensureWsMetas();
  }

  /** 弹层打开时刷新工作区列表 + 计数快照（refresh 防重入内置于模型）。 */
  private async ensureWsMetas(): Promise<void> {
    await this.ws.refresh();
    await this.ws.loadMetas();
  }

  onWsPick(o: WsOpt): void {
    this.dr.wsSheet = false;
    if (o.key === this.ws.selectedKey) {
      return;
    }
    this.ws.select(o.key);
    toastModel.show(`已切换工作区 · ${o.name}`, 'ok');
  }

  // ── 设备卡 / 区段 ──

  @Builder
  deviceHead() {
    Column({ space: 12 }) {
      Row({ space: 10 }) {
        Image($r('app.media.startIcon'))
          .width(38)
          .height(38)
          .borderRadius(11)

        Column({ space: 2 }) {
          Text('桌面 aide')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
          Row({ space: 5 }) {
            if (this.conn.state === 'authed') {
              // 容器圆替代 Circle().fill()（drawing 组件 fill 本 SDK 报 API 26 兼容告警）
              Column().width(6).height(6).borderRadius(3).backgroundColor($r('app.color.status_ok'))
            } else {
              PulseDot({ color: $r('app.color.status_warn'), dotSize: 6 })
            }
            Text(this.conn.state === 'authed' ? '已连接 · 桌面 aide' : '设备离线 · 自动重连中')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
          }
          .alignItems(VerticalAlign.Center)
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        // ⏻ 断开（原型 dr-quit 同位）
        Row() {
          SymbolGlyph($r('sys.symbol.power'))
            .fontSize(16)
            .fontColor([$r('app.color.text_secondary')])
        }
        .width(28)
        .height(28)
        .borderRadius(8)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          this.onDisconnectTap();
        })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 供应商徽标（点击开切换弹层）
      Row({ space: 6 }) {
        ProviderMark({ p: this.pv.activeProvider(), markSize: 12, tint: $r('app.color.accent') })
        Text(this.activePvName())
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.accent'))
          .maxLines(1)
          .constraintSize({ maxWidth: 190 })
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(10)
          .fontColor([$r('app.color.accent')])
          .opacity(0.6)
      }
      .padding({ left: 12, right: 12, top: 5, bottom: 5 })
      .borderRadius(99)
      .backgroundColor($r('app.color.accent_weak'))
      .alignItems(VerticalAlign.Center)
      .constraintSize({ maxWidth: '100%' })
      .onClick(() => {
        this.onPvBadgeTap();
      })
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 14, bottom: 12 })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  sectionLabel(title: string) {
    Text(title)
      .fontSize(12)
      .fontColor($r('app.color.text_secondary'))
      .letterSpacing(1)
      .width('100%')
      .padding({ left: 15, right: 15, top: 8, bottom: 6 })
  }

  // ── 工作区卡 ──

  @Builder
  wsAvatar(key: string, label: string, size: number, radius: number, font: number) {
    Row() {
      if (this.ws.isDaily(key)) {
        // 日常：对话气泡图标（对齐桌面侧栏「日常」分区语汇），固定暖橙
        Image($r('app.media.ic_daily_bubble'))
          .width(font + 3)
          .height(font + 3)
          .fillColor(DAILY_COLOR)
      } else if (key === '') {
        Text('a')
          .fontSize(font)
          .fontWeight(FontWeight.Bold)
          .fontColor(WS_COLORS[0])
      } else {
        Text(label.length > 0 ? label.substring(0, 1).toUpperCase() : '·')
          .fontSize(font)
          .fontWeight(FontWeight.Bold)
          .fontColor(WS_COLORS[wsColorIdx(key)])
      }
    }
    .width(size)
    .height(size)
    .borderRadius(radius)
    .backgroundColor(this.ws.isDaily(key)
      ? DAILY_TINT
      : key === '' ? WS_TINTS[0] : WS_TINTS[wsColorIdx(key)])
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
  }

  /** 工作区卡计数（当前浏览范围 = sessionsModel 现势列表；只列非零项）。 */
  @Builder
  wsCardMeta() {
    Text() {
      Span(`${this.sm.sessions.length} 个会话`).fontColor($r('app.color.text_secondary'))
      if (this.sm.startedCount() > 0) {
        Span(` · ${this.sm.startedCount()} 个已启动`).fontColor($r('app.color.accent'))
      }
      if (this.sm.liveCount() > 0) {
        Span(` · ${this.sm.liveCount()} 个回复中`).fontColor($r('app.color.status_ok'))
      }
      if (this.sm.waitCount() > 0) {
        Span(` · ${this.sm.waitCount()} 个待确认`).fontColor($r('app.color.status_warn'))
      }
    }
    .fontSize(10.5)
    .maxLines(1)
    .textOverflow({ overflow: TextOverflow.Ellipsis })
    .margin({ top: 3 })
  }

  @Builder
  wsCard() {
    Row({ space: 11 }) {
      this.wsAvatar(this.ws.displayKey(), this.ws.selectedDisplayName(), 42, 12, 19)
      Column({ space: 1 }) {
        Text(this.ws.selectedDisplayName())
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.ws.isDaily(this.ws.selectedKey)) {
          // 日常态：定位副标题占掉路径行——内部目录永不展示
          Text(DAILY_DESC)
            .fontSize(10.5)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        } else if (this.ws.selectedPath() !== '') {
          Text(this.ws.selectedPath())
            .fontSize(10.5)
            .fontColor($r('app.color.text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        this.wsCardMeta()
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Row({ space: 2 }) {
        Text('切换')
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.accent'))
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(12)
          .fontColor([$r('app.color.accent')])
      }
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 11, bottom: 11 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onWsCardTap();
    })
  }

  // ── 自动化区段（对照原型 .aut-sec；详情/表单浮层本体在 ChatPage 根栈挂载）──

  /** 启停小开关（36×22 药丸 + 18 圆点；Block 阻冒泡——点开关不触发行点击）。
   *  圆点用 Column 药丸而非 Circle().fill()：drawing 组件 fill 在本 SDK 是
   *  API 26 兼容告警，容器圆无此问题（AutomationDetail/Editor 同款）。 */
  @Builder
  autSwitch(t: AutomationTask) {
    Stack() {
      Column()
        .width(18)
        .height(18)
        .borderRadius(9)
        .backgroundColor('#FFFFFF')
        .translate({ x: t.enabled ? 7 : -7 })
    }
    .width(36)
    .height(22)
    .borderRadius(11)
    .backgroundColor(t.enabled ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
    .onClick(() => {
      // 等回执再落列表：失败 toast，开关不跳变（模型层语义）
      void this.am.toggleEnabled(t.id, !t.enabled);
    })
    .hitTestBehavior(HitTestMode.Block)
  }

  /** 上次结果短语（行第二行右段）：运行中（呼吸点）/ 上次成功/失败/跳过（时间）/ 尚未运行。 */
  @Builder
  autLastRun(t: AutomationTask) {
    if (t.lastRunStatus === 'running') {
      PulseDot({ color: $r('app.color.accent'), dotSize: 6 })
      Text('运行中')
        .fontSize(11.5)
        .fontColor($r('app.color.accent'))
    } else if (t.lastRunStatus === 'succeeded') {
      Text(`上次成功（${shortTime(t.lastRunAt)}）`)
        .fontSize(11.5)
        .fontColor($r('app.color.status_ok'))
    } else if (t.lastRunStatus === 'failed') {
      Text(`上次失败（${shortTime(t.lastRunAt)}）`)
        .fontSize(11.5)
        .fontColor($r('app.color.status_danger'))
    } else if (t.lastRunStatus === 'skipped') {
      Text(`上次跳过（${shortTime(t.lastRunAt)}）`)
        .fontSize(11.5)
        .fontColor($r('app.color.text_secondary'))
    } else {
      Text('尚未运行')
        .fontSize(11.5)
        .fontColor($r('app.color.text_secondary'))
    }
  }

  /** 任务行（两行制：名称 + 小开关 / 调度 · 上次结果）。 */
  @Builder
  autRow(t: AutomationTask) {
    Column() {
      Row({ space: 8 }) {
        Text(t.name)
          .fontSize(13.5)
          .fontWeight(FontWeight.Medium)
          .fontColor(t.enabled ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        this.autSwitch(t)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: 5 }) {
        Text(scheduleText(t.schedule))
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .flexShrink(1)
        Text('·')
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
        this.autLastRun(t)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
      .margin({ top: 3 })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 开详情浮层不收抽屉：浮层全屏盖住，返回时抽屉仍在（原型 backFs 同款）
      this.am.selectTask(t.id);
    })
  }

  /** 区段头：呼吸点（有任务在跑）+ 标题 + ＋ 新建 + 折叠 chevron。 */
  @Builder
  autHeader() {
    Row({ space: 7 }) {
      if (this.am.hasRunning()) {
        PulseDot({ color: $r('app.color.status_ok'), dotSize: 7 })
      }
      Text('自动化')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .letterSpacing(1)
      Blank()
      Row() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(15)
          .fontColor([$r('app.color.text_secondary')])
      }
      .width(26)
      .height(26)
      .borderRadius(8)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.am.openEditor('');
      })
      Row() {
        SymbolGlyph($r('sys.symbol.chevron_down'))
          .fontSize(14)
          .fontColor([$r('app.color.text_secondary')])
          .rotate({ angle: this.autCollapsed ? -90 : 0 })
          .animation({ duration: 180, curve: Curve.EaseOut })
      }
      .width(26)
      .height(26)
      .borderRadius(8)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.autCollapsed = !this.autCollapsed;
      })
    }
    .width('100%')
    .padding({ left: 15, right: 15, top: 12, bottom: 6 })
    .alignItems(VerticalAlign.Center)
  }

  /** 拉取失败卡（11 命令未进 REGISTRY 时的常态）：如实呈现错误文本 + 重试。 */
  @Builder
  autErrorCard() {
    Column() {
      Text('自动化任务拉取失败')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.status_danger'))
      Text(this.am.lastError)
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
        void this.am.refreshTasks();
      })
    }
    .width('100%')
    .padding(14)
    .borderRadius(13)
    .backgroundColor($r('app.color.status_danger_weak'))
    .alignItems(HorizontalAlign.Center)
  }

  /** 首拉加载中（后续刷新不闪——有行照显旧行）。 */
  @Builder
  autLoadingCard() {
    Column() {
      LoadingProgress().width(22).height(22).color($r('app.color.text_secondary'))
    }
    .width('100%')
    .padding(18)
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
  }

  /** 空态引导（大图标 + 文案 + 主色胶囊按钮）。 */
  @Builder
  autEmptyCard() {
    Column() {
      Row() {
        SymbolGlyph($r('sys.symbol.clock'))
          .fontSize(18)
          .fontColor([$r('app.color.accent')])
      }
      .width(38)
      .height(38)
      .borderRadius(12)
      .backgroundColor($r('app.color.accent_weak'))
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .margin({ bottom: 8 })
      Text('还没有自动化任务')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text('定时汇总提交、巡检依赖、生成周报……')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .margin({ top: 2 })
      Text('都从下面这个 + 开始')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
      Row() {
        Text('＋ 新建任务')
          .fontSize(12.5)
          .fontWeight(FontWeight.Medium)
          .fontColor(Color.White)
      }
      .padding({ left: 16, right: 16, top: 7, bottom: 7 })
      .borderRadius(99)
      .backgroundColor($r('app.color.accent'))
      .margin({ top: 10 })
      .onClick(() => {
        this.am.openEditor('');
      })
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 18, bottom: 18 })
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
  }

  /** 区段本体：头 + 列表（四态 + 行；折叠时只藏列表）。 */
  @Builder
  autSection() {
    Column() {
      this.autHeader()
      if (!this.autCollapsed) {
        Column({ space: 8 }) {
          if (!this.am.loaded && this.am.refreshing) {
            this.autLoadingCard()
          } else if (this.am.tasks.length === 0 && this.am.lastError !== '') {
            this.autErrorCard()
          } else if (this.am.loaded && this.am.tasks.length === 0) {
            this.autEmptyCard()
          } else {
            ForEach(this.am.tasks, (t: AutomationTask) => {
              this.autRow(t)
            }, (t: AutomationTask): string => {
              return t.id + '|' + t.name + '|' + (t.enabled ? 'on' : 'off') + '|' +
                scheduleText(t.schedule) + '|' + (t.lastRunStatus ?? '-') + '|' + (t.lastRunAt ?? '-');
            })
          }
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 2, bottom: 6 })
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
  }

  // ── 历史会话区段 ──

  @Builder
  historyHeader() {
    Row({ space: 8 }) {
      Text('历史会话')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .letterSpacing(1)
        .layoutWeight(1)
      Row() {
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(16)
          .fontColor([$r('app.color.text_secondary')])
      }
      .width(28)
      .height(28)
      .borderRadius(8)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        this.onNewSession();
      })
      if (this.sm.refreshing) {
        LoadingProgress().width(14).height(14).color($r('app.color.accent'))
      } else {
        Row() {
          SymbolGlyph($r('sys.symbol.arrow_clockwise'))
            .fontSize(14)
            .fontColor([$r('app.color.text_secondary')])
        }
        .width(28)
        .height(28)
        .borderRadius(8)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          void this.sm.refresh();
        })
      }
    }
    .width('100%')
    .padding({ left: 15, right: 15, top: 8, bottom: 6 })
    .alignItems(VerticalAlign.Center)
  }

  /** 三态状态点（只留点不带文字，优先级见类头；'none' 占空位保持对齐）。 */
  @Builder
  statusDot(status: string) {
    if (status === 'wait') {
      PulseDot({ color: $r('app.color.status_warn'), dotSize: 7 })
    } else if (status === 'live') {
      PulseDot({ color: $r('app.color.status_ok'), dotSize: 7 })
    } else if (status === 'started') {
      // 容器圆替代 Circle().fill()（drawing 组件 fill 在本 SDK 是 API 26 兼容告警）
      Column().width(7).height(7).borderRadius(3.5).backgroundColor($r('app.color.accent'))
    }
  }

  @Builder
  sessionRow(s: Session) {
    Row({ space: 8 }) {
      Row() {
        this.statusDot(this.sm.statusOf(s.id))
      }
      .width(7)
      .height(7)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)

      Text(s.name)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      if (s.timestamp > 0) {
        Text(relTime(s.timestamp))
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 11, bottom: 11 })
    .borderRadius(14)
    .backgroundColor(s.id === this.store.sid ? $r('app.color.accent_weak') : $r('app.color.card_bg'))
    .border({ width: 1, color: s.id === this.store.sid ? $r('app.color.accent') : $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.onSessionTap(s);
    })
  }

  @Builder
  sessionList() {
    List({ space: 8 }) {
      if (this.sm.lastError !== '') {
        ListItem() {
          Text(`列表拉取失败，点击重试`)
            .fontSize(12)
            .fontColor($r('app.color.status_warn'))
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: 10, bottom: 10 })
            .onClick(() => {
              void this.sm.refresh();
            })
        }
      }
      if (!this.sm.loaded) {
        ListItem() {
          Column({ space: 8 }) {
            LoadingProgress().width(16).height(16).color($r('app.color.accent'))
            Text('正在加载会话…').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .width('100%')
          .alignItems(HorizontalAlign.Center)
          .padding({ top: 22, bottom: 22 })
        }
      } else {
        if (this.filteredSessions().length === 0) {
          ListItem() {
            Text(this.query.trim() !== '' ? '无匹配会话' : '暂无会话')
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Center)
              .padding({ top: 22, bottom: 22 })
          }
        } else {
          ForEach(this.filteredSessions(), (s: Session) => {
            ListItem() {
              this.sessionRow(s)
            }
          }, (s: Session) => s.id)
        }
      }
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 12, right: 12, top: 2, bottom: 10 })
    .scrollBar(BarState.Off)
    .edgeEffect(EdgeEffect.Spring)
  }

  @Builder
  searchBox() {
    Row({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.magnifyingglass'))
        .fontSize(13)
        .fontColor([$r('app.color.text_secondary')])
      TextInput({ placeholder: '搜索会话', text: this.query })
        .onChange((value: string) => {
          this.query = value;
        })
        .fontSize(13)
        .fontColor($r('app.color.text_primary'))
        .placeholderColor($r('app.color.text_secondary'))
        .backgroundColor(Color.Transparent)
        .caretColor($r('app.color.accent'))
        .padding({ left: 0, right: 0, top: 0, bottom: 0 })
        .height(36)
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 9, bottom: 9 })
    .borderRadius(99)
    .backgroundColor($r('app.color.card_bg'))
    .border({ width: 1, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
  }

  // ── 半模态骨架 ──

  @Builder
  sheetGrip() {
    Column()
      .width(36)
      .height(4.5)
      .borderRadius(3)
      .backgroundColor($r('app.color.line'))
      .margin({ top: 4, bottom: 10 })
  }

  /** 供应商弹层主体（自绘半模态：遮罩即全屏容器，底部对齐；面板内点击不落穿）。 */
  @Builder
  providerSheetBody() {
    Column() {
      this.sheetGrip()
      Row({ space: 8 }) {
        Text('选择供应商')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text('切换即时生效 · 与桌面标题栏同步')
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.pv.refreshing) {
          LoadingProgress().width(12).height(12).color($r('app.color.accent'))
        }
      }
      .width('100%')
      .padding({ left: 4, right: 4, bottom: 10 })
      .alignItems(VerticalAlign.Center)

      List({ space: 6 }) {
        if (this.pv.providers.length === 0) {
          ListItem() {
            Text(this.pv.loaded ? '暂无供应商，回桌面 aide → 设置 → 供应商' : '正在加载供应商…')
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
              .width('100%')
              .textAlign(TextAlign.Center)
              .padding({ top: 20, bottom: 20 })
          }
        } else {
          ForEach(this.pv.providers, (p: ProviderConfigView) => {
            ListItem() {
              Row({ space: 11 }) {
                Row() {
                  ProviderMark({ p: p, markSize: 15, tint: $r('app.color.text_primary') })
                }
                .width(34)
                .height(34)
                .borderRadius(17)
                .backgroundColor($r('app.color.card_bg'))
                .justifyContent(FlexAlign.Center)
                .alignItems(VerticalAlign.Center)

                Column({ space: 1 }) {
                  Text(p.name)
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor($r('app.color.text_primary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(this.providerDesc(p))
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .layoutWeight(1)
                .alignItems(HorizontalAlign.Start)

                if (p.id === this.pv.activeId) {
                  SymbolGlyph($r('sys.symbol.checkmark'))
                    .fontSize(18)
                    .fontColor([$r('app.color.accent')])
                }
              }
              .width('100%')
              .padding(11)
              .borderRadius(14)
              .backgroundColor(p.id === this.pv.activeId ? $r('app.color.accent_weak') : $r('app.color.input_bg'))
              .border({
                width: 1.5,
                color: p.id === this.pv.activeId ? $r('app.color.accent') : Color.Transparent
              })
              .alignItems(VerticalAlign.Center)
              .onClick(() => {
                void this.onPvPick(p);
              })
            }
          }, (p: ProviderConfigView) => p.id)
        }
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)

      Text('管理 / 新增供应商请回桌面 aide → 设置 → 供应商')
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Center)
        .border({ width: { top: 1 }, color: $r('app.color.line') })
        .padding({ top: 12 })
        .margin({ top: 10 })
    }
    .width('100%')
    .height('62%')
    .backgroundColor($r('app.color.card_bg'))
    .borderRadius({ topLeft: 24, topRight: 24 })
    .padding({ left: 16, right: 16, top: 8, bottom: 20 })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 面板内点击不落穿遮罩（ArkUI 点击不冒泡，空 handler 即拦截）
    })
    .transition(TransitionEffect.translate({ y: 40 }).animation({ duration: 240, curve: Curve.EaseOut }))
  }

  /** 工作区弹层主体。 */
  @Builder
  workspaceSheetBody() {
    Column() {
      this.sheetGrip()
      Row({ space: 8 }) {
        Text('切换工作区')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text('会话按工作区隔离 · 新会话发往所选工作区')
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.ws.loadingMetas) {
          LoadingProgress().width(12).height(12).color($r('app.color.accent'))
        }
      }
      .width('100%')
      .padding({ left: 4, right: 4, bottom: 10 })
      .alignItems(VerticalAlign.Center)

      List({ space: 6 }) {
        ForEach(this.wsOptions(), (o: WsOpt) => {
          ListItem() {
            Row({ space: 11 }) {
              this.wsAvatar(o.key, o.name, 36, 10, 16)
              Column({ space: 1 }) {
                Row({ space: 6 }) {
                  Text(o.name)
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor($r('app.color.text_primary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  if (this.ws.isDaily(o.key)) {
                    // 「默认」角标：手机默认范围即日常（暖橙弱底，区别于选中态 accent）
                    Text('默认')
                      .fontSize(9.5)
                      .fontWeight(FontWeight.Medium)
                      .fontColor(DAILY_COLOR)
                      .backgroundColor(DAILY_TINT)
                      .borderRadius(8)
                      .padding({ left: 6, right: 6, top: 1, bottom: 1.5 })
                  }
                }
                .alignItems(VerticalAlign.Center)
                if (this.ws.isDaily(o.key)) {
                  // 定位副标题占掉路径行——日常路径是内部概念，永不展示
                  Text(DAILY_DESC)
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                } else if (o.key === '') {
                  // 已解析出活动工作区时点名展示，跟随语义落到实处
                  Text(this.ws.activeDisplayName() !== ''
                    ? `桌面 aide 正在打开 · ${this.ws.activeDisplayName()}`
                    : '桌面 aide 当前打开的项目')
                    .fontSize(11)
                    .fontColor($r('app.color.text_secondary'))
                } else {
                  Text(o.path)
                    .fontSize(10.5)
                    .fontColor($r('app.color.text_secondary'))
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                if (o.missing) {
                  Text('文件夹已不存在')
                    .fontSize(10.5)
                    .fontColor($r('app.color.status_warn'))
                }
                if (this.ws.metaOfKey(o.key) !== null) {
                  Text() {
                    Span(this.metaTotalText(o.key)).fontColor($r('app.color.text_secondary'))
                    if (this.wsMetaCount(o.key, 'started') > 0) {
                      Span(` · ${this.wsMetaCount(o.key, 'started')} 个已启动`)
                        .fontColor($r('app.color.accent'))
                    }
                    if (this.wsMetaCount(o.key, 'live') > 0) {
                      Span(` · ${this.wsMetaCount(o.key, 'live')} 个回复中`)
                        .fontColor($r('app.color.status_ok'))
                    }
                    if (this.wsMetaCount(o.key, 'wait') > 0) {
                      Span(` · ${this.wsMetaCount(o.key, 'wait')} 个待确认`)
                        .fontColor($r('app.color.status_warn'))
                    }
                  }
                  .fontSize(10.5)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ top: 2 })
                }
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              if (o.key === this.ws.selectedKey) {
                SymbolGlyph($r('sys.symbol.checkmark'))
                  .fontSize(18)
                  .fontColor([$r('app.color.accent')])
              }
            }
            .width('100%')
            .padding(11)
            .borderRadius(14)
            .backgroundColor(o.key === this.ws.selectedKey ? $r('app.color.accent_weak') : $r('app.color.input_bg'))
            .border({
              width: 1.5,
              color: o.key === this.ws.selectedKey ? $r('app.color.accent') : Color.Transparent
            })
            .alignItems(VerticalAlign.Center)
            .onClick(() => {
              this.onWsPick(o);
            })
          }
        }, (o: WsOpt) => o.key)
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .edgeEffect(EdgeEffect.Spring)

      Text('工作区由桌面 aide 管理 · 在桌面打开项目文件夹即加入列表')
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .width('100%')
        .textAlign(TextAlign.Center)
        .border({ width: { top: 1 }, color: $r('app.color.line') })
        .padding({ top: 12 })
        .margin({ top: 10 })
    }
    .width('100%')
    .height('62%')
    .backgroundColor($r('app.color.card_bg'))
    .borderRadius({ topLeft: 24, topRight: 24 })
    .padding({ left: 16, right: 16, top: 8, bottom: 20 })
    .alignItems(HorizontalAlign.Start)
    .onClick(() => {
      // 面板内点击不落穿遮罩
    })
    .transition(TransitionEffect.translate({ y: 40 }).animation({ duration: 240, curve: Curve.EaseOut }))
  }

  // ── 根：遮罩 + 左滑面板 + 两个弹层 ──

  build() {
    if (this.dr.open) {
      Stack() {
        // 抽屉遮罩（点击关闭）
        Column()
          .width('100%')
          .height('100%')
          .backgroundColor(MASK_COLOR)
          .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))
          .onClick(() => {
            this.dr.close();
          })

        // 左滑面板
        Row() {
          Column() {
            this.deviceHead()
            this.sectionLabel('工作区')
            Column() {
              this.wsCard()
            }
            .width('100%')
            .padding({ left: 12, right: 12, bottom: 8 })

            this.autSection()

            this.historyHeader()
            this.sessionList()

            Column() {
              this.searchBox()
            }
            .width('100%')
            .padding({ left: 12, right: 12, top: 10, bottom: 14 })
          }
          .width('85%')
          .constraintSize({ maxWidth: 310 })
          .height('100%')
          .backgroundColor($r('app.color.page_bg'))
          .border({ width: { right: 1 }, color: $r('app.color.line') })
          .onClick(() => {
            // 空点击拦截落穿：面板内点击不关抽屉
          })
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Start)
        // 全宽透明行自身不做触摸测试（右侧空白让给下层遮罩），子面板照常命中：
        // 命中规则——Stack 重叠时最上层节点独占触摸测试，无 handler 的目标会吞掉点击
        .hitTestBehavior(HitTestMode.None)
        .transition(TransitionEffect.translate({ x: -320 }).animation({ duration: 260, curve: Curve.Friction }))

        // 供应商弹层（遮罩即全屏容器 + 底部对齐）
        if (this.dr.pvSheet) {
          Column() {
            this.providerSheetBody()
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.End)
          .backgroundColor(MASK_COLOR)
          .onClick(() => {
            this.dr.pvSheet = false;
          })
          .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))
        }

        // 工作区弹层
        if (this.dr.wsSheet) {
          Column() {
            this.workspaceSheetBody()
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.End)
          .backgroundColor(MASK_COLOR)
          .onClick(() => {
            this.dr.wsSheet = false;
          })
          .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))
        }
      }
      .width('100%')
      .height('100%')
      // 退场续命锚（官方 transition 文档规则：删除整棵子树时，子树存活时长取决于
      // 根节点的消失转场；根无转场则整树立即销毁，子节点动画无从播放——v3 起抽屉
      // 瞬消的根因）。1→0.99 的不可感知淡出仅为续命 260ms，让遮罩淡出与面板左滑
      // 收进完整播完（照官方 transition 文档示例3 的 opacity(0.99) 根锚模式）。
      .transition(TransitionEffect.opacity(0.99).animation({ duration: 260, curve: Curve.Friction }))
    }
  }
}

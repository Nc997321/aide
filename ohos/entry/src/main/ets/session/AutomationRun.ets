/**
 * 自动化运行转录浮层（只读，对照原型 design/automation/app.html #fsRun
 * 557-579 + renderRun）：头（返回 + 任务名 / 时间·触发·模式 + 状态徽标）/
 * 错误条（failed 的 error）/ 运行中横幅（第 N 轮 + ↻刷新→refreshRunView）/
 * 消息时间线（用户气泡 / 思考卡 / 工具行 / Markdown 正文）+ 加载更早分页 /
 * 底部用量条（轮次 · 成本 · 用时 · 缓存命中 · stopReason）。
 *
 *  - 数据面：api.load_messages(sessionId, offset, null) → itemsToChatMessages
 *    （与聊天历史同一映射——分页与首载同形）；@Monitor('am.runView') 驱动：
 *    openRun / closeRun / refreshRunView（刷新按钮只调 refreshRunView，记录
 *    对象被换新 → Monitor 重载整页）
 *  - 协议缺口如实呈现：自动化会话目录暂不在远程 load_messages 扫描范围，
 *    空结果给说明文案（桌面端补齐后此屏点亮）；拉取失败错误卡 + 重试
 *  - 渲染复用件：ThinkingCard（历史思考收起卡）/ MarkdownText（静态）/
 *    toolSummary；user 气泡 accent 右尾 4、AI 卡左尾 4（原型 tr-user/tr-ai）；
 *    原型「✦ 已注入执行手册」角标是假数据（真实转录无此块），略
 *  - 用量条缓存命中 = cacheRead / (input + cacheRead + cacheCreation)；
 *    running 的已运行时长取 Date.now() - startedAt（静态快照，刷新按钮重估）
 *  - 图标经 SDK 符号表核实：exclamationmark_circle / checkmark
 */
import { AutomationModel, automationModel } from './AutomationModel';
import { shortTime, statusLabel, triggerLabel, modeLabel, costText, formatDurationMs, runDurationMs } from './AutomationFormat';
import { itemsToChatMessages } from './chat/ChatTranscript';
import { ChatMessage, ContentBlock, TextBlock, ThinkingBlock, ToolCallBlock } from './chat/ChatBlocks';
import { ThinkingCard } from './chat/ThinkingCard';
import { MarkdownText } from './chat/MarkdownText';
import { toolSummary } from './chat/ChatWire';
import { api } from '../sdk/api';
import { LoadMessagesResult, RunRecord } from '../sdk/types';

@ComponentV2
export struct AutomationRun {
  @Local am: AutomationModel = automationModel;

  // ── 转录页态（runView 打开时重置装载）──
  @Local loading: boolean = false;
  @Local loadError: string = '';
  @Local messages: ChatMessage[] = [];
  /** 下一页字节游标（0 = 已到文件头，无更早页）。 */
  @Local nextOffset: number = 0;
  @Local loadingEarlier: boolean = false;

  @Monitor('am.runView')
  onRunViewChange(): void {
    const r: RunRecord | null = this.am.runView;
    if (r !== null) {
      this.reload();
    }
  }

  // ── 数据 ──

  private reload(): void {
    const r: RunRecord | null = this.am.runView;
    if (r === null) {
      return;
    }
    this.messages = [];
    this.nextOffset = 0;
    this.loadError = '';
    this.loadingEarlier = false;
    if (r.sessionId === '') {
      // skipped 记录无会话（详情行已拦，此处防御）：直接空态
      this.loading = false;
      return;
    }
    this.loading = true;
    void this.fetchPage(r.sessionId, null);
  }

  private async fetchPage(sid: string, offset: number | null): Promise<void> {
    try {
      const res: LoadMessagesResult = await api.loadMessages(sid, offset, null);
      if (this.am.runView === null || this.am.runView.sessionId !== sid) {
        return; // 已关或已切运行：丢弃过期页
      }
      const page: ChatMessage[] = itemsToChatMessages(res.messages);
      if (offset === null) {
        this.messages = page;
      } else {
        this.messages = page.concat(this.messages);
        this.loadingEarlier = false;
      }
      this.nextOffset = res.nextOffsetBytes;
      this.loadError = '';
      this.loading = false;
    } catch (e) {
      if (this.am.runView === null || this.am.runView.sessionId !== sid) {
        return;
      }
      this.loading = false;
      this.loadingEarlier = false;
      // 渲染分流：无内容 → 整卡呈现；已有内容（取更早页失败）→ 行内重试条
      this.loadError = e instanceof Error ? e.message : String(e);
    }
  }

  private async loadEarlier(): Promise<void> {
    const r: RunRecord | null = this.am.runView;
    if (r === null || this.nextOffset <= 0 || this.loadingEarlier) {
      return;
    }
    this.loadingEarlier = true;
    await this.fetchPage(r.sessionId, this.nextOffset);
  }

  // ── 纯展示 helper ──

  private taskName(): string {
    const t = this.am.selectedTask();
    return t !== null ? t.name : '运行详情';
  }

  private cachePct(r: RunRecord): number {
    const u = r.usage;
    if (u === null) {
      return -1;
    }
    const total: number = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    if (total <= 0) {
      return -1;
    }
    return Math.round((100 * u.cacheReadTokens) / total);
  }

  private metaText(r: RunRecord): string {
    const segs: string[] = [];
    if (r.rounds !== null) {
      segs.push(`${r.rounds} 轮`);
    }
    if (r.costUsd !== null) {
      segs.push(costText(r.costUsd));
    }
    if (r.status === 'running') {
      const start: number = Date.parse(r.startedAt);
      if (start > 0) {
        segs.push(`已运行 ${formatDurationMs(Date.now() - start)}`);
      }
    } else {
      const ms: number | null = runDurationMs(r);
      if (ms !== null) {
        segs.push(`用时 ${formatDurationMs(ms)}`);
      }
    }
    const pct: number = this.cachePct(r);
    if (pct >= 0) {
      segs.push(`缓存命中 ${pct}%`);
    }
    if (r.stopReason !== null && r.stopReason !== '') {
      segs.push(r.stopReason);
    }
    if (segs.length === 0) {
      return '—';
    }
    let out: string = segs[0];
    for (let i = 1; i < segs.length; i++) {
      out += ' · ' + segs[i];
    }
    return out;
  }

  private badgeColor(s: string): ResourceColor {
    if (s === 'succeeded') {
      return $r('app.color.status_ok');
    }
    if (s === 'failed') {
      return $r('app.color.status_danger');
    }
    if (s === 'running') {
      return $r('app.color.accent');
    }
    return $r('app.color.text_secondary');
  }

  private badgeBg(s: string): ResourceColor {
    if (s === 'succeeded') {
      return $r('app.color.status_ok_weak');
    }
    if (s === 'failed') {
      return $r('app.color.status_danger_weak');
    }
    if (s === 'running') {
      return $r('app.color.accent_weak');
    }
    return $r('app.color.input_bg');
  }

  // ── 头 / 横幅 ──

  @Builder
  statusBadge(status: string) {
    Row({ space: 4 }) {
      if (status === 'running') {
        LoadingProgress().width(10).height(10).color($r('app.color.accent'))
      }
      Text(statusLabel(status))
        .fontSize(10.5)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.badgeColor(status))
    }
    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
    .borderRadius(99)
    .backgroundColor(this.badgeBg(status))
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  headView(r: RunRecord) {
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
        this.am.closeRun();
      })

      Column({ space: 1 }) {
        Text(this.taskName())
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${shortTime(r.startedAt)} · 触发：${triggerLabel(r.trigger)} · 模式：${modeLabel(r.mode)}`)
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      this.statusBadge(r.status)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 8 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  errBar(text: string) {
    Row({ space: 7 }) {
      SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
        .fontSize(14)
        .fontColor([$r('app.color.status_danger')])
      Text(text)
        .fontSize(12)
        .fontColor($r('app.color.status_danger'))
        .lineHeight(18)
        .layoutWeight(1)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .borderRadius(12)
    .backgroundColor($r('app.color.status_danger_weak'))
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  liveBar(r: RunRecord) {
    Row({ space: 8 }) {
      LoadingProgress().width(13).height(13).color($r('app.color.accent'))
      Text(`正在运行 · 第 ${r.rounds !== null ? r.rounds : '—'} 轮`)
        .fontSize(12.5)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.accent'))
        .layoutWeight(1)
      Text('↻ 刷新')
        .fontSize(12)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.accent'))
        .onClick(() => {
          // 只触发记录对账；runView 被换新 → @Monitor 重载整页
          void this.am.refreshRunView();
        })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .borderRadius(12)
    .backgroundColor($r('app.color.accent_weak'))
    .alignItems(VerticalAlign.Center)
  }

  // ── 消息时间线（只读；块映射与聊天历史同源）──

  @Builder
  userBubble(text: string) {
    Row() {
      Text(text)
        .fontSize(13)
        .fontColor(Color.White)
        .lineHeight(21)
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .borderRadius({ topLeft: 14, topRight: 14, bottomLeft: 14, bottomRight: 4 })
        .backgroundColor($r('app.color.accent'))
        .constraintSize({ maxWidth: '88%' })
    }
    .width('100%')
    .justifyContent(FlexAlign.End)
  }

  @Builder
  aiCard(text: string) {
    Column() {
      MarkdownText({ raw: text, live: false })
    }
    .width('100%')
    .padding({ left: 13, right: 13, top: 11, bottom: 11 })
    .borderRadius({ topLeft: 4, topRight: 14, bottomLeft: 14, bottomRight: 14 })
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  toolRow(b: ToolCallBlock) {
    Row({ space: 8 }) {
      Text(b.name)
        .fontSize(12)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.text_primary'))
      Text(toolSummary(b.input))
        .fontSize(11)
        .fontFamily('monospace')
        .fontColor($r('app.color.text_secondary'))
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (b.isError) {
        SymbolGlyph($r('sys.symbol.exclamationmark_circle'))
          .fontSize(13)
          .fontColor([$r('app.color.status_danger')])
      } else {
        SymbolGlyph($r('sys.symbol.checkmark'))
          .fontSize(12)
          .fontColor([$r('app.color.status_ok')])
      }
    }
    .width('100%')
    .padding({ left: 11, right: 11, top: 8, bottom: 8 })
    .borderRadius(11)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  blockRow(b: ContentBlock, isUser: boolean) {
    if (b instanceof ThinkingBlock) {
      ThinkingCard({ block: b, maxHeight: 320 })
    } else if (b instanceof ToolCallBlock) {
      this.toolRow(b)
    } else if (b instanceof TextBlock) {
      if (isUser) {
        this.userBubble(b.text)
      } else {
        this.aiCard(b.text)
      }
    }
  }

  @Builder
  messageRow(m: ChatMessage) {
    Column({ space: 9 }) {
      ForEach(m.blocks, (b: ContentBlock) => {
        this.blockRow(b, m.role === 'user')
      }, (b: ContentBlock) => b.type + '|' + b.id)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ── 页态卡 ──

  @Builder
  loadErrorCard() {
    Column() {
      Text('转录拉取失败')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.status_danger'))
      Text(this.loadError)
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
        this.reload();
      })
    }
    .width('100%')
    .padding(14)
    .borderRadius(13)
    .backgroundColor($r('app.color.status_danger_weak'))
    .alignItems(HorizontalAlign.Center)
  }

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
  emptyMsgsCard() {
    Column({ space: 2 }) {
      Text('未取回到消息')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text('自动化会话目录暂不在远程 load_messages 的扫描范围（协议缺口），' +
        '或该运行尚未产生消息；桌面端补齐后此屏点亮')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(19)
        .textAlign(TextAlign.Center)
        .margin({ top: 2 })
    }
    .width('100%')
    .padding({ left: 20, right: 20, top: 18, bottom: 18 })
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  loadEarlierRow() {
    Text(this.loadingEarlier ? '加载中…' : '加载更早的消息 ↑')
      .fontSize(12)
      .fontColor($r('app.color.accent'))
      .alignSelf(ItemAlign.Center)
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .onClick(() => {
        if (!this.loadingEarlier) {
          void this.loadEarlier();
        }
      })
  }

  @Builder
  earlierFailedRow() {
    Text('加载更早消息失败 · 点按重试')
      .fontSize(12)
      .fontColor($r('app.color.status_danger'))
      .alignSelf(ItemAlign.Center)
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .onClick(() => {
        this.loadError = '';
        void this.loadEarlier();
      })
  }

  // ── 底部用量条 ──

  @Builder
  metaBar(r: RunRecord) {
    Row() {
      Text(this.metaText(r))
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 9, bottom: 13 })
    .border({ width: { top: 1 }, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
  }

  // ── 根 ──

  build() {
    if (this.am.runView !== null) {
      Column() {
        this.headView(this.am.runView)
        Scroll() {
          Column({ space: 9 }) {
            if (this.am.runView.error !== null && this.am.runView.error !== '') {
              this.errBar(this.am.runView.error)
            }
            if (this.am.runView.status === 'running') {
              this.liveBar(this.am.runView)
            }

            if (this.loadError !== '' && this.messages.length === 0) {
              this.loadErrorCard()
            } else if (this.loading) {
              this.loadingView()
            } else if (this.messages.length === 0) {
              this.emptyMsgsCard()
            } else {
              if (this.loadError !== '') {
                this.earlierFailedRow()
              } else if (this.nextOffset > 0) {
                this.loadEarlierRow()
              }
              ForEach(this.messages, (m: ChatMessage) => {
                this.messageRow(m)
              }, (m: ChatMessage) => m.id)
            }
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 4, bottom: 18 })
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)

        this.metaBar(this.am.runView)
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.page_bg'))
      .transition(TransitionEffect.translate({ y: '100%' }).animation({ duration: 240, curve: Curve.Friction }))
    }
  }
}

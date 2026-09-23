/**
 * 自动化任务详情浮层（对照原型 design/automation/app.html #fsDetail）：头
 *（返回 + 名称 / 调度·工作区 + 启停开关）/ chips + 操作行（立即运行 / 编辑 /
 * 删除）/ 任务指令卡（clamp2 + 展开）/ 执行手册卡（三态）/ 运行统计四格 /
 * 运行记录列表（skipped 置灰不可点）/ 删除确认自绘半模态。
 *
 *  - 挂载：ChatPage 根栈常挂，view === 'detail' 自显（自底滑入转场）；返回
 *    不收抽屉——原型 backFs 关浮层后抽屉仍在原位
 *  - 数据面：automationModel.selectedTask() + runs/stats；11 命令未进远程
 *    REGISTRY 时错误态如实呈现（runsError 错误条 + 重试，不崩不白屏）
 *  - 立即运行 busy 防连点（busyTaskId 置灰）；启停等回执再落列表（模型层语义）
 *  - 手册 ready 态无时间戳（协议无 playbook-generated-at；原型 9/12 18:31 是
 *    假数据，如实省略）；stale 小字去掉假日期
 *  - 统计四格对照原型 stat-strip（runs=0 → 0/—/$0/—；桌面另有 perDay/
 *    cacheHit，ohos 原型未含，不扩）
 *  - 图标经 SDK 符号表核实：book（两卡同款，原型同 svg）/ data_line /
 *    chevron_left；运行中徽标内嵌 LoadingProgress（原型 spinner）
 */
import { AutomationModel, automationModel } from './AutomationModel';
import {
  scheduleText, shortTime, formatDurationMs, runDurationMs, costText, noteText,
  statusLabel, triggerLabel, modeLabel, presetLabel, effortLabel
} from './AutomationFormat';
import { baseName } from './WorkspaceModel';
import { AutomationTask, RunRecord } from '../sdk/types';

/** 删除确认遮罩（原型 rgba(0,0,0,.38)）。 */
const SHEET_MASK: ResourceColor = '#61000000';

/** 空任务占位（build 门已保证非空；防远端并发删除时 selectedTask 忽然置空）。 */
const EMPTY_TASK: AutomationTask = {
  id: '',
  name: '',
  prompt: '',
  workspacePath: null,
  model: '',
  effort: '',
  permissionPreset: 'auto',
  connectors: [],
  schedule: { kind: 'daily' },
  validFrom: null,
  validTo: null,
  missedPolicy: 'catchup',
  playbookEnabled: false,
  playbookState: 'none',
  notifySuccess: false,
  notifyFailure: false,
  enabled: false,
  createdAt: '',
  lastRunAt: null,
  lastRunStatus: null
};

@ComponentV2
export struct AutomationDetail {
  @Local am: AutomationModel = automationModel;
  /** 指令卡展开（clamp2 ⇄ 全文）。 */
  @Local promptExpanded: boolean = false;
  /** 删除确认半模态（自绘：遮罩 + 底部面板）。 */
  @Local confirmDelete: boolean = false;

  @Monitor('am.view')
  onViewChange(): void {
    // 关浮层即清 UI 态：重开不残留展开/确认
    if (this.am.view !== 'detail') {
      this.promptExpanded = false;
      this.confirmDelete = false;
    }
  }

  // ── 纯展示 helper ──

  private cur(): AutomationTask {
    return this.am.selectedTask() ?? EMPTY_TASK;
  }

  private wsLabel(t: AutomationTask): string {
    return t.workspacePath !== null && t.workspacePath !== '' ? baseName(t.workspacePath) : '无工作区';
  }

  private durText(r: RunRecord): string {
    const ms: number | null = runDurationMs(r);
    return ms === null ? '—' : formatDurationMs(ms);
  }

  private statRate(): string {
    const s = this.am.stats;
    if (s === null || s.runs === 0) {
      return '—';
    }
    return `${(s.successRate * 100).toFixed(1)}%`;
  }

  private statCost(): string {
    const s = this.am.stats;
    if (s === null) {
      return '$0';
    }
    return s.totalCostUsd === 0 ? '$0' : `$${s.totalCostUsd.toFixed(2)}`;
  }

  private statAvg(): string {
    const s = this.am.stats;
    if (s === null || s.avgDurationMs === null) {
      return '—';
    }
    return formatDurationMs(s.avgDurationMs);
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

  // ── 头 ──

  /** 启停小开关（36×22 药丸 + 18 圆点；与抽屉行同款，等回执再跳变）。
   *  圆点用 Column 药丸而非 Circle().fill()：drawing 组件 fill 在本 SDK 是
   *  API 26 兼容告警，容器圆无此问题。 */
  @Builder
  switchView(t: AutomationTask) {
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
      void this.am.toggleEnabled(t.id, !t.enabled);
    })
  }

  @Builder
  headView(t: AutomationTask) {
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
        this.am.closeDetail();
      })

      Column({ space: 1 }) {
        Text(t.name)
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(`${scheduleText(t.schedule)} · ${this.wsLabel(t)}`)
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      this.switchView(t)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 8 })
    .alignItems(VerticalAlign.Center)
  }

  // ── 卡片 ──

  @Builder
  cardTitle(icon: Resource, title: string, small: string) {
    Row({ space: 7 }) {
      SymbolGlyph(icon)
        .fontSize(14)
        .fontColor([$r('app.color.accent')])
      Text(title)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Blank()
      if (small !== '') {
        Text(small)
          .fontSize(11)
          .fontColor($r('app.color.text_secondary'))
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: 8 })
  }

  @Builder
  chipView(text: string, accent: boolean) {
    Text(text)
      .fontSize(11)
      .fontColor(accent ? $r('app.color.accent') : $r('app.color.text_secondary'))
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .borderRadius(99)
      .backgroundColor(accent ? $r('app.color.accent_weak') : $r('app.color.input_bg'))
      .margin({ right: 6, bottom: 6 })
  }

  @Builder
  actionsCard(t: AutomationTask) {
    Column() {
      Flex({ wrap: FlexWrap.Wrap }) {
        this.chipView(scheduleText(t.schedule), true)
        this.chipView(`思考 · ${effortLabel(t.effort)}`, false)
        this.chipView(`权限 · ${presetLabel(t.permissionPreset)}`, false)
        this.chipView(`错过 · ${t.missedPolicy === 'catchup' ? '补跑' : '跳过'}`, false)
        ForEach(t.connectors, (c: string) => {
          this.chipView(c, false)
        }, (c: string) => c)
      }
      .width('100%')

      Row({ space: 8 }) {
        Row() {
          Text('▶ 立即运行')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor(Color.White)
        }
        .layoutWeight(1)
        .padding({ top: 8, bottom: 8 })
        .borderRadius(10)
        .backgroundColor($r('app.color.accent'))
        .justifyContent(FlexAlign.Center)
        .opacity(this.am.busyTaskId === t.id ? 0.55 : 1)
        .onClick(() => {
          if (this.am.busyTaskId === '') {
            void this.am.runNow(t.id);
          }
        })

        Row() {
          Text('编辑')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
        }
        .layoutWeight(1)
        .padding({ top: 8, bottom: 8 })
        .borderRadius(10)
        .backgroundColor($r('app.color.card_bg'))
        .border({ width: 1, color: $r('app.color.line') })
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.am.openEditor(t.id);
        })

        Row() {
          Text('删除')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.status_danger'))
        }
        .layoutWeight(1)
        .padding({ top: 8, bottom: 8 })
        .borderRadius(10)
        .backgroundColor($r('app.color.card_bg'))
        .border({ width: 1, color: $r('app.color.line') })
        .justifyContent(FlexAlign.Center)
        .onClick(() => {
          this.confirmDelete = true;
        })
      }
      .width('100%')
      .margin({ top: 12 })
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  promptCard(t: AutomationTask) {
    Column() {
      this.cardTitle($r('sys.symbol.book'), '任务指令', `${t.prompt.length} 字`)
      Text(t.prompt)
        .fontSize(12.5)
        .fontColor($r('app.color.text_primary'))
        .lineHeight(21)
        .maxLines(this.promptExpanded ? 999 : 2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
      Text(this.promptExpanded ? '收起 ▴' : '展开 ▾')
        .fontSize(11.5)
        .fontColor($r('app.color.accent'))
        .margin({ top: 4 })
        .onClick(() => {
          this.promptExpanded = !this.promptExpanded;
        })
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  /** 手册未就绪说明行（未启用 / 尚未生成）。 */
  @Builder
  pbNone(text: string) {
    Row({ space: 8 }) {
      SymbolGlyph($r('sys.symbol.book'))
        .fontSize(15)
        .fontColor([$r('app.color.text_secondary')])
      Text(text)
        .fontSize(12.5)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(20)
        .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  playbookCard(t: AutomationTask) {
    Column() {
      this.cardTitle($r('sys.symbol.book'), '执行手册', '首跑后由模型沉淀')
      if (!t.playbookEnabled) {
        this.pbNone('未启用：每次运行直接按任务指令执行')
      } else if (t.playbookState === 'ready' || t.playbookState === 'stale') {
        Row({ space: 8 }) {
          Column({ space: 1 }) {
            Text(t.playbookState === 'stale' ? '已过期' : '已生成')
              .fontSize(12.5)
              .fontWeight(FontWeight.Bold)
              .fontColor(t.playbookState === 'stale' ? $r('app.color.status_warn') : $r('app.color.text_primary'))
            Text(t.playbookState === 'stale'
              ? '指令修改后未重新生成 · 最近运行回退原始指令 · 点开看旧版'
              : '每次运行自动注入，保证行为稳定 · 点开查看')
              .fontSize(11)
              .fontColor($r('app.color.text_secondary'))
              .lineHeight(16)
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(13)
            .fontColor([$r('app.color.text_secondary')])
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .onClick(() => {
          void this.am.readPlaybook();
        })
      } else {
        this.pbNone('尚未生成——任务首次运行后由模型自动沉淀')
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  statCell(value: string, label: string) {
    Column({ space: 1 }) {
      Text(value)
        .fontSize(15)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
        .maxLines(1)
      Text(label)
        .fontSize(10)
        .fontColor($r('app.color.text_secondary'))
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  statsCard() {
    Column() {
      this.cardTitle($r('sys.symbol.data_line'), '运行统计', '')
      Row({ space: 6 }) {
        this.statCell(this.am.stats !== null ? `${this.am.stats.runs}` : '0', '运行')
        this.statCell(this.statRate(), '成功率')
        this.statCell(this.statCost(), '累计成本')
        this.statCell(this.statAvg(), '平均时长')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  // ── 运行记录 ──

  @Builder
  statusBadge(r: RunRecord) {
    Row({ space: 4 }) {
      if (r.status === 'running') {
        LoadingProgress().width(10).height(10).color($r('app.color.accent'))
      }
      Text(statusLabel(r.status))
        .fontSize(10.5)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.badgeColor(r.status))
    }
    .padding({ left: 8, right: 8, top: 2, bottom: 2 })
    .borderRadius(99)
    .backgroundColor(this.badgeBg(r.status))
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  runRow(r: RunRecord) {
    Column() {
      Row({ space: 7 }) {
        this.statusBadge(r)
        Text(shortTime(r.startedAt))
          .fontSize(12.5)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(r.status === 'skipped'
          ? triggerLabel(r.trigger)
          : `${triggerLabel(r.trigger)} · ${modeLabel(r.mode)}`)
          .fontSize(10.5)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (r.status !== 'skipped' && r.summary !== null && r.summary !== '') {
        Text(r.summary)
          .fontSize(11.5)
          .fontColor($r('app.color.text_secondary'))
          .lineHeight(18)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 4 })
          .width('100%')
      }

      if (r.status !== 'skipped') {
        Row({ space: 10 }) {
          if (r.status === 'running') {
            Text('正在运行 · 点击查看')
              .fontSize(10.5)
              .fontColor($r('app.color.text_secondary'))
          } else {
            Text(this.durText(r))
              .fontSize(10.5)
              .fontColor($r('app.color.text_secondary'))
            if (r.rounds !== null) {
              Text(`${r.rounds} 轮`)
                .fontSize(10.5)
                .fontColor($r('app.color.text_secondary'))
            }
            if (r.costUsd !== null) {
              Text(costText(r.costUsd))
                .fontSize(10.5)
                .fontColor($r('app.color.text_secondary'))
            }
          }
        }
        .margin({ top: 5 })
        .alignItems(VerticalAlign.Center)
      }

      if (r.note !== null && r.note !== '') {
        Text(noteText(r.note))
          .fontSize(11)
          .fontColor($r('app.color.status_warn'))
          .lineHeight(16)
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .borderRadius(8)
          .backgroundColor($r('app.color.status_warn_weak'))
          .margin({ top: 6 })
          .alignSelf(ItemAlign.Start)
      }

      if (r.error !== null && r.error !== '') {
        Text(r.error)
          .fontSize(11)
          .fontColor($r('app.color.status_danger'))
          .lineHeight(16)
          .padding({ left: 8, right: 8, top: 4, bottom: 4 })
          .borderRadius(8)
          .backgroundColor($r('app.color.status_danger_weak'))
          .margin({ top: 6 })
          .alignSelf(ItemAlign.Start)
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 11, bottom: 11 })
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
    .opacity(r.status === 'skipped' ? 0.55 : 1)
    .onClick(() => {
      // skipped（无会话）置灰不可点；行点击开只读转录
      if (r.status !== 'skipped' && r.sessionId !== '') {
        this.am.openRun(r);
      }
    })
  }

  @Builder
  runsLoadingCard() {
    Column() {
      LoadingProgress().width(22).height(22).color($r('app.color.text_secondary'))
    }
    .width('100%')
    .padding(18)
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  runsErrorCard() {
    Column() {
      Text('运行记录拉取失败')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.status_danger'))
      Text(this.am.runsError)
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
        void this.am.refreshRuns();
      })
    }
    .width('100%')
    .padding(14)
    .borderRadius(13)
    .backgroundColor($r('app.color.status_danger_weak'))
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  runsEmptyCard() {
    Column() {
      Text('还没有运行记录')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text('到点自动触发，或点上方「立即运行」试一次')
        .fontSize(12)
        .fontColor($r('app.color.text_secondary'))
        .margin({ top: 2 })
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 18, bottom: 18 })
    .borderRadius(13)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  runsSection() {
    Column({ space: 8 }) {
      Row() {
        Text('运行记录')
          .fontSize(12)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_secondary'))
          .letterSpacing(0.5)
        Blank()
        Text(`近 ${this.am.runs.length} 条 · 点击查看转录`)
          .fontSize(10.5)
          .fontColor($r('app.color.text_secondary'))
      }
      .width('100%')
      .padding({ left: 2, right: 2, top: 6 })
      .alignItems(VerticalAlign.Center)

      if (this.am.runsError !== '' && this.am.runs.length === 0) {
        this.runsErrorCard()
      } else if (this.am.runsLoading && this.am.runs.length === 0) {
        this.runsLoadingCard()
      } else if (this.am.runs.length === 0) {
        this.runsEmptyCard()
      } else {
        ForEach(this.am.runs, (r: RunRecord) => {
          this.runRow(r)
        }, (r: RunRecord): string => {
          return r.runId + '|' + r.status + '|' + (r.summary ?? '') + '|' +
            String(r.rounds ?? -1) + '|' + String(r.costUsd ?? -1) + '|' +
            (r.note ?? '') + '|' + (r.error ?? '') + '|' + (r.finishedAt ?? '');
        })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ── 删除确认半模态（原型 #delMask：遮罩 + 底部面板 + 取消/删除）──

  @Builder
  deleteSheet() {
    Column() {
      Column() {
        Row()
          .width(36)
          .height(4)
          .borderRadius(2)
          .backgroundColor($r('app.color.line'))
          .margin({ top: 4, bottom: 12 })
        Text(`删除「${this.cur().name}」？`)
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
        Text('运行记录与执行手册将一并删除，不可恢复。')
          .fontSize(12.5)
          .fontColor($r('app.color.text_secondary'))
          .lineHeight(21)
          .textAlign(TextAlign.Center)
          .margin({ top: 7, bottom: 16 })
        Row({ space: 10 }) {
          Row() {
            Text('取消')
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.text_primary'))
          }
          .layoutWeight(1)
          .padding({ top: 11, bottom: 11 })
          .borderRadius(12)
          .backgroundColor($r('app.color.card_bg'))
          .border({ width: 1, color: $r('app.color.line') })
          .justifyContent(FlexAlign.Center)
          .onClick(() => {
            this.confirmDelete = false;
          })
          Row() {
            Text('删除')
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.status_danger'))
          }
          .layoutWeight(1)
          .padding({ top: 11, bottom: 11 })
          .borderRadius(12)
          .backgroundColor($r('app.color.status_danger_weak'))
          .justifyContent(FlexAlign.Center)
          .onClick(() => {
            this.confirmDelete = false;
            void this.am.deleteTask(this.cur().id);
          })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .backgroundColor($r('app.color.card_bg'))
      .borderRadius({ topLeft: 20, topRight: 20 })
      .padding({ left: 18, right: 18, bottom: 20 })
      .alignItems(HorizontalAlign.Center)
      .onClick(() => {
        // 面板内点击不落穿遮罩
      })
      .transition(TransitionEffect.translate({ y: '100%' }).animation({ duration: 220, curve: Curve.Friction }))
    }
    .width('100%')
    .height('100%')
    .backgroundColor(SHEET_MASK)
    .justifyContent(FlexAlign.End)
    .transition(TransitionEffect.OPACITY.animation({ duration: 220, curve: Curve.EaseOut }))
    .onClick(() => {
      this.confirmDelete = false;
    })
  }

  // ── 根 ──

  build() {
    if (this.am.view === 'detail' && this.am.selectedTask() !== null) {
      Stack() {
        Column() {
          this.headView(this.cur())
          Scroll() {
            Column({ space: 10 }) {
              this.actionsCard(this.cur())
              this.promptCard(this.cur())
              this.playbookCard(this.cur())
              this.statsCard()
              this.runsSection()
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 4, bottom: 18 })
            .alignItems(HorizontalAlign.Start)
          }
          .layoutWeight(1)
          .width('100%')
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
        }
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.page_bg'))

        if (this.confirmDelete) {
          this.deleteSheet()
        }
      }
      .width('100%')
      .height('100%')
      .transition(TransitionEffect.translate({ y: '100%' }).animation({ duration: 240, curve: Curve.Friction }))
    }
  }
}

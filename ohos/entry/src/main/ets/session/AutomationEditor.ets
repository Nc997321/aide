/**
 * 自动化任务表单浮层（新建 / 编辑，对照原型 design/automation/app.html
 * #fsEditor 458-558/940-983）：基本信息（名称 + 指令）/ 运行设置（工作区
 * 只读行 + 模型 + 思考程度 + 连接器）/ 权限预设两卡 / 调度五臂 + 错过处理 /
 * 成败通知开关；脚注 取消 / 保存 / ▶运行（保存并立即运行）。
 *
 *  - 保存语义对照桌面 AutomationTaskEditor.vue buildInput：validFrom/validTo/
 *    playbookEnabled/connectors 编辑透传（新建 null/true/[]），enabled 新建
 *    true、编辑透传；不暴露的字段绝不静默改写
 *  - workspacePath：新建 = 桌面当前活动工作区（workspaceModel.activePath，
 *    原型只读行「手机端不单独指定」的落库语义；空则 null=任务目录），编辑
 *    透传原绑定
 *  - 模型选项与聊天模型 chip 同源（打开瞬间快照 chatModel.store.modelOptions），
 *    空串 = 跟随桌面（Rust 不下发 ANTHROPIC_MODEL）；原型 seg → bindMenu
 *    （供应商清单长度不可控，seg 会挤爆）；清单外的当前值不进菜单但原样
 *    显示与保存（桌面 modelOptions.ts 同款保留语义）
 *  - 未知枚举值不静默归并：effort 三档（low/high/max）外原值入 seg 项；
 *    missedPolicy 'ask' 时补第三项「询问」（桌面有此档）；权限预设两卡
 *    auto/full（Rust 侧 readonly 是并入 auto 的 serde alias，只读卡不真实
 *    存在——用户拍板；编辑 readonly 任务回填归并 auto）
 *  - 调度五臂与协议 kind 一一对应；间隔单位含 分钟/小时/天（协议含 minutes，
 *    原型只画两种）；时间走 UIContext.showTimePickerDialog、单次日期走
 *    showDatePickerDialog（原生选择器防手输脏值）；every/day 数字输入保存时
 *    钳制（≥1 / 1-31，桌面 buildSchedule 同款 max(1, floor)）
 *  - 校验对照桌面 validate() 四条：名称 / 指令（行内 err + toast）/ 每周
 *    ≥1 个星期几 / 单次必有日期（toast）；保存成功 toast「已保存 · 下个
 *    调度点生效」，▶运行 走 runNow(quiet) 后「已保存，运行已触发」；
 *    保存失败模型层 toast 错误文本，停留表单保留草稿
 *  - 原型权限卡 small「离线时按只读处理」未在上游核实，略；原型间隔输入
 *    与单位并排（duo）改为上下两行（单位 seg 三格放不进半行）
 */
import { AutomationModel, automationModel } from './AutomationModel';
import { chatModel } from './ChatModel';
import { workspaceModel } from './WorkspaceModel';
import { AutomationTask, AutomationTaskInput, ModelOption, Schedule } from '../sdk/types';

/** seg 选项（v = 协议值，label = 显示文案）。 */
interface SegOpt {
  v: string;
  label: string;
}

const KIND_OPTS: SegOpt[] = [
  { v: 'daily', label: '每天' },
  { v: 'weekly', label: '每周' },
  { v: 'monthly', label: '每月' },
  { v: 'interval', label: '间隔' },
  { v: 'once', label: '单次' }
];

/** 间隔单位（协议 IntervalUnit：minutes/hours/days；原型只画了两种）。 */
const UNIT_OPTS: SegOpt[] = [
  { v: 'minutes', label: '分钟' },
  { v: 'hours', label: '小时' },
  { v: 'days', label: '天' }
];

const EFFORT_BASE: SegOpt[] = [
  { v: 'low', label: '快速' },
  { v: 'high', label: '均衡' },
  { v: 'max', label: '极致' }
];

const MISSED_BASE: SegOpt[] = [
  { v: 'catchup', label: '补跑一次' },
  { v: 'skip', label: '跳过并记录' }
];

/** 星期几圆片文案（下标 = 协议值 1..7 减一）。 */
const WD_NAMES: string[] = ['一', '二', '三', '四', '五', '六', '日'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

@ComponentV2
export struct AutomationEditor {
  @Local am: AutomationModel = automationModel;

  // ── 表单态（view 变 'editor' 时 resetForm 回填 / 置默认）──
  @Local fName: string = '';
  @Local fPrompt: string = '';
  @Local fModel: string = '';
  @Local fEffort: string = 'high';
  @Local fPerm: string = 'auto';
  @Local fMissed: string = 'catchup';
  @Local fKind: string = 'daily';
  @Local fTime: string = '09:00';
  @Local fWeekdays: number[] = [1, 3, 5];
  @Local fDayText: string = '1';
  @Local fEveryText: string = '6';
  @Local fUnit: string = 'hours';
  @Local fOnceDate: string = '';
  @Local fOnceTime: string = '09:00';
  @Local fNotifyOk: boolean = true;
  @Local fNotifyFail: boolean = true;
  @Local nameErr: boolean = false;
  @Local promptErr: boolean = false;
  /** 模型选项快照（打开瞬间取，与聊天模型 chip 同源）。 */
  @Local modelOpts: ModelOption[] = [];

  @Monitor('am.view')
  onViewChange(): void {
    if (this.am.view === 'editor') {
      this.resetForm();
    }
  }

  // ── 表单初始化 ──

  private resetForm(): void {
    const t: AutomationTask | null = this.am.editingTaskId === '' ? null : this.am.taskById(this.am.editingTaskId);
    this.modelOpts = chatModel.store.modelOptions;
    if (t !== null) {
      this.fName = t.name;
      this.fPrompt = t.prompt;
      this.fModel = t.model;
      this.fEffort = t.effort;
      // readonly 是并入 auto 的 serde alias：不真实存在，回填归并
      this.fPerm = t.permissionPreset === 'full' ? 'full' : 'auto';
      this.fMissed = t.missedPolicy;
      const s: Schedule = t.schedule;
      this.fKind = this.isKnownKind(s.kind) ? s.kind : 'daily';
      this.fTime = s.time !== undefined && s.time !== '' ? s.time : '09:00';
      this.fWeekdays = s.weekdays !== undefined ? s.weekdays.slice() : [1, 3, 5];
      this.fDayText = s.day !== undefined ? `${s.day}` : '1';
      this.fEveryText = s.every !== undefined ? `${s.every}` : '6';
      this.fUnit = s.unit === 'minutes' || s.unit === 'hours' || s.unit === 'days' ? s.unit : 'hours';
      if (s.at !== undefined && s.at.length >= 16) {
        this.fOnceDate = s.at.substring(0, 10);
        this.fOnceTime = s.at.substring(11, 16);
      } else {
        this.fOnceDate = '';
        this.fOnceTime = '09:00';
      }
      this.fNotifyOk = t.notifySuccess;
      this.fNotifyFail = t.notifyFailure;
    } else {
      // 新建默认（桌面 form 默认 + 原型 ed 默认；once 日期必选，校验把关）
      this.fName = '';
      this.fPrompt = '';
      this.fModel = '';
      this.fEffort = 'high';
      this.fPerm = 'auto';
      this.fMissed = 'catchup';
      this.fKind = 'daily';
      this.fTime = '09:00';
      this.fWeekdays = [1, 3, 5];
      this.fDayText = '1';
      this.fEveryText = '6';
      this.fUnit = 'hours';
      this.fOnceDate = '';
      this.fOnceTime = '09:00';
      this.fNotifyOk = true;
      this.fNotifyFail = true;
    }
    this.nameErr = false;
    this.promptErr = false;
  }

  // ── 纯 helper ──

  private isKnownKind(k: string): boolean {
    for (let i = 0; i < KIND_OPTS.length; i++) {
      if (KIND_OPTS[i].v === k) {
        return true;
      }
    }
    return false;
  }

  private segHas(opts: SegOpt[], v: string): boolean {
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].v === v) {
        return true;
      }
    }
    return false;
  }

  /** 三档外原值原样入项（不静默改写任务）。 */
  private effortOpts(): SegOpt[] {
    const opts: SegOpt[] = [];
    for (let i = 0; i < EFFORT_BASE.length; i++) {
      opts.push(EFFORT_BASE[i]);
    }
    if (this.fEffort !== '' && !this.segHas(opts, this.fEffort)) {
      opts.push({ v: this.fEffort, label: this.fEffort });
    }
    return opts;
  }

  /** 'ask' 档只在编辑 ask 任务时出现（桌面有此档，原型两档）。 */
  private missedOpts(): SegOpt[] {
    const opts: SegOpt[] = [];
    for (let i = 0; i < MISSED_BASE.length; i++) {
      opts.push(MISSED_BASE[i]);
    }
    if (this.fMissed === 'ask') {
      opts.push({ v: 'ask', label: '询问' });
    }
    return opts;
  }

  private modelLabel(): string {
    if (this.fModel === '') {
      return '跟随桌面';
    }
    for (let i = 0; i < this.modelOpts.length; i++) {
      if (this.modelOpts[i].value === this.fModel) {
        return this.modelOpts[i].displayName;
      }
    }
    return this.fModel;
  }

  private modelMenu(): Array<MenuElement> {
    const items: Array<MenuElement> = [];
    items.push({
      value: '跟随桌面',
      action: (): void => {
        this.fModel = '';
      }
    });
    for (let i = 0; i < this.modelOpts.length; i++) {
      const o: ModelOption = this.modelOpts[i];
      items.push({
        value: o.displayName,
        action: (): void => {
          this.fModel = o.value;
        }
      });
    }
    return items;
  }

  private wsRowText(): string {
    if (this.am.editingTaskId !== '') {
      const t: AutomationTask | null = this.am.taskById(this.am.editingTaskId);
      if (t !== null && t.workspacePath !== null && t.workspacePath !== '') {
        return t.workspacePath;
      }
      return '（不绑定 · 以任务目录为工作目录）';
    }
    return workspaceModel.activePath !== '' ? workspaceModel.activePath : '未获取到桌面工作区';
  }

  private connList(): string[] {
    if (this.am.editingTaskId === '') {
      return [];
    }
    const t: AutomationTask | null = this.am.taskById(this.am.editingTaskId);
    return t !== null ? t.connectors : [];
  }

  // ── 数字输入钳制（桌面 buildSchedule 同款；!(n>=x) 同时兜住 NaN）──

  private parseEvery(): number {
    const n: number = Number(this.fEveryText);
    if (!(n >= 1)) {
      return 1;
    }
    return Math.floor(n);
  }

  private parseDay(): number {
    const n: number = Number(this.fDayText);
    if (!(n >= 1)) {
      return 1;
    }
    if (n > 31) {
      return 31;
    }
    return Math.floor(n);
  }

  // ── 原生选择器（时间 / 单次日期）──

  private timeToDate(hhmm: string): Date {
    const parts: string[] = hhmm.split(':');
    let h: number = 9;
    let m: number = 0;
    if (parts.length === 2) {
      const hh: number = Number(parts[0]);
      const mm: number = Number(parts[1]);
      if (hh >= 0 && mm >= 0) {
        h = hh;
        m = mm;
      }
    }
    return new Date(2026, 0, 1, h, m);
  }

  private onceToDate(): Date {
    if (this.fOnceDate.length >= 10) {
      const y: number = Number(this.fOnceDate.substring(0, 4));
      const m: number = Number(this.fOnceDate.substring(5, 7));
      const d: number = Number(this.fOnceDate.substring(8, 10));
      if (y > 0 && m >= 1 && d >= 1) {
        return new Date(y, m - 1, d);
      }
    }
    return new Date();
  }

  private pickTime(field: string): void {
    const cur: string = field === 'onceTime' ? this.fOnceTime : this.fTime;
    this.getUIContext().showTimePickerDialog({
      selected: this.timeToDate(cur),
      useMilitaryTime: true,
      format: TimePickerFormat.HOUR_MINUTE,
      onAccept: (value: TimePickerResult) => {
        if (value.hour !== undefined && value.minute !== undefined) {
          const picked: string = `${pad2(value.hour)}:${pad2(value.minute)}`;
          if (field === 'onceTime') {
            this.fOnceTime = picked;
          } else {
            this.fTime = picked;
          }
        }
      }
    });
  }

  private pickOnceDate(): void {
    this.getUIContext().showDatePickerDialog({
      selected: this.onceToDate(),
      onDateAccept: (value: Date) => {
        this.fOnceDate = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
      }
    });
  }

  // ── 交互派发（@Builder 不传闭包，字符串字段名派发保 ArkTS 简洁）──

  private pickSeg(field: string, v: string): void {
    if (field === 'kind') {
      this.fKind = v;
    } else if (field === 'effort') {
      this.fEffort = v;
    } else if (field === 'missed') {
      this.fMissed = v;
    } else if (field === 'unit') {
      this.fUnit = v;
    }
  }

  private toggleWeekday(d: number): void {
    const next: number[] = [];
    let had: boolean = false;
    for (let i = 0; i < this.fWeekdays.length; i++) {
      if (this.fWeekdays[i] === d) {
        had = true;
      } else {
        next.push(this.fWeekdays[i]);
      }
    }
    if (!had) {
      next.push(d);
    }
    next.sort((a: number, b: number): number => a - b);
    this.fWeekdays = next;
  }

  // ── 组装 / 校验 / 保存 ──

  private sortedWeekdays(): number[] {
    const arr: number[] = [];
    for (let i = 0; i < this.fWeekdays.length; i++) {
      arr.push(this.fWeekdays[i]);
    }
    arr.sort((a: number, b: number): number => a - b);
    return arr;
  }

  private buildSchedule(): Schedule {
    if (this.fKind === 'weekly') {
      const s: Schedule = { kind: 'weekly', time: this.fTime, weekdays: this.sortedWeekdays() };
      return s;
    }
    if (this.fKind === 'monthly') {
      const s: Schedule = { kind: 'monthly', time: this.fTime, day: this.parseDay() };
      return s;
    }
    if (this.fKind === 'interval') {
      const s: Schedule = { kind: 'interval', every: this.parseEvery(), unit: this.fUnit };
      return s;
    }
    if (this.fKind === 'once') {
      const s: Schedule = { kind: 'once', at: `${this.fOnceDate}T${this.fOnceTime}` };
      return s;
    }
    const s: Schedule = { kind: 'daily', time: this.fTime };
    return s;
  }

  private buildInput(): AutomationTaskInput {
    const cur: AutomationTask | null = this.am.editingTaskId === '' ? null : this.am.taskById(this.am.editingTaskId);
    const input: AutomationTaskInput = {
      name: this.fName.trim(),
      prompt: this.fPrompt.trim(),
      workspacePath: cur !== null
        ? cur.workspacePath
        : (workspaceModel.activePath !== '' ? workspaceModel.activePath : null),
      model: this.fModel,
      effort: this.fEffort,
      permissionPreset: this.fPerm,
      connectors: cur !== null ? cur.connectors.slice() : [],
      schedule: this.buildSchedule(),
      validFrom: cur !== null ? cur.validFrom : null,
      validTo: cur !== null ? cur.validTo : null,
      missedPolicy: this.fMissed,
      playbookEnabled: cur !== null ? cur.playbookEnabled : true,
      notifySuccess: this.fNotifyOk,
      notifyFailure: this.fNotifyFail,
      enabled: cur !== null ? cur.enabled : true
    };
    return input;
  }

  /** 校验（桌面 validate 同款四条）：非空串 = 应 toast 的错误文案。 */
  private validate(): string {
    if (this.fName.trim() === '') {
      this.nameErr = true;
    }
    if (this.fPrompt.trim() === '') {
      this.promptErr = true;
    }
    if (this.nameErr || this.promptErr) {
      return '请填写任务名称与任务指令';
    }
    if (this.fKind === 'weekly' && this.fWeekdays.length === 0) {
      return '每周任务至少选择一个星期几';
    }
    if (this.fKind === 'once' && this.fOnceDate === '') {
      return '单次任务需要选择日期';
    }
    return '';
  }

  private save(andRun: boolean): void {
    if (this.am.saving) {
      return;
    }
    const problem: string = this.validate();
    if (problem !== '') {
      this.am.pickToast(problem, 'warn');
      return;
    }
    const input: AutomationTaskInput = this.buildInput();
    void this.doSave(input, andRun);
  }

  private async doSave(input: AutomationTaskInput, andRun: boolean): Promise<void> {
    const ok: boolean = await this.am.saveTask(input);
    if (!ok) {
      return; // 失败 toast 模型层已发，停留表单保留草稿
    }
    if (andRun) {
      const id: string = this.am.selectedTaskId;
      if (id !== '') {
        void this.am.runNow(id, true);
      }
      this.am.pickToast('已保存，运行已触发', 'ok');
    } else {
      this.am.pickToast('已保存 · 下个调度点生效', 'ok');
    }
  }

  // ── 通用小件 ──

  @Builder
  fLabel(text: string, small: string) {
    Row({ space: 5 }) {
      Text(text)
        .fontSize(12.5)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Blank()
      if (small !== '') {
        Text(small)
          .fontSize(10.5)
          .fontWeight(FontWeight.Regular)
          .fontColor($r('app.color.text_secondary'))
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .margin({ bottom: 6 })
  }

  @Builder
  hintText(text: string) {
    Text(text)
      .fontSize(10.5)
      .fontColor($r('app.color.text_secondary'))
      .lineHeight(17)
      .margin({ top: 5 })
      .width('100%')
  }

  @Builder
  segCell(o: SegOpt, on: boolean, field: string) {
    Text(o.label)
      .fontSize(12)
      .fontWeight(FontWeight.Medium)
      .fontColor(on ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
      .layoutWeight(1)
      .textAlign(TextAlign.Center)
      .padding({ top: 7, bottom: 7 })
      .borderRadius(9)
      .backgroundColor(on ? $r('app.color.card_bg') : Color.Transparent)
      .onClick(() => {
        this.pickSeg(field, o.v);
      })
  }

  /** 分段选择器（原型 .seg：input_bg 轨道 + card_bg 选中浮起）。 */
  @Builder
  segView(opts: SegOpt[], selected: string, field: string) {
    Row({ space: 2 }) {
      ForEach(opts, (o: SegOpt) => {
        this.segCell(o, o.v === selected, field)
      }, (o: SegOpt) => o.v)
    }
    .width('100%')
    .padding(3)
    .borderRadius(11)
    .backgroundColor($r('app.color.input_bg'))
  }

  @Builder
  presetCard(perm: string, title: string, desc: string) {
    Column() {
      Text(title)
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text(desc)
        .fontSize(11)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(17)
        .margin({ top: 2 })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(12)
    .border({ width: 1.5, color: this.fPerm === perm ? $r('app.color.accent') : $r('app.color.line') })
    .backgroundColor(this.fPerm === perm ? $r('app.color.accent_weak') : $r('app.color.card_bg'))
    .onClick(() => {
      this.fPerm = perm;
    })
  }

  /** 启停小开关同款药丸（36×22 + 18 圆点），通知两行复用。 */
  @Builder
  toggleSwitch(on: boolean, field: string) {
    Stack() {
      // 圆点用 Column 药丸而非 Circle().fill()：drawing 组件 fill 在本 SDK 是
      // API 26 兼容告警（ChatPage canvas fill 同类），容器圆无此问题
      Column()
        .width(18)
        .height(18)
        .borderRadius(9)
        .backgroundColor('#FFFFFF')
        .translate({ x: on ? 7 : -7 })
    }
    .width(36)
    .height(22)
    .borderRadius(11)
    .backgroundColor(on ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
    .onClick(() => {
      if (field === 'notifyOk') {
        this.fNotifyOk = !this.fNotifyOk;
      } else {
        this.fNotifyFail = !this.fNotifyFail;
      }
    })
  }

  /** 选择器行（input_bg 底 + 右箭头；label 空时显示 placeholder 灰字）。 */
  @Builder
  pickerRow(label: string, placeholder: string, field: string) {
    Row({ space: 8 }) {
      Text(label !== '' ? label : placeholder)
        .fontSize(12.5)
        .fontColor(label !== '' ? $r('app.color.text_primary') : $r('app.color.text_secondary'))
        .layoutWeight(1)
        .maxLines(1)
      SymbolGlyph($r('sys.symbol.chevron_right'))
        .fontSize(13)
        .fontColor([$r('app.color.text_secondary')])
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(11)
    .backgroundColor($r('app.color.input_bg'))
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      if (field === 'onceDate') {
        this.pickOnceDate();
      } else {
        this.pickTime(field);
      }
    })
  }

  @Builder
  wdChip(d: number) {
    Stack() {
      Text(WD_NAMES[d - 1])
        .fontSize(12)
        .fontColor(this.fWeekdays.includes(d) ? Color.White : $r('app.color.text_secondary'))
    }
    .width(34)
    .height(34)
    .borderRadius(17)
    .border({ width: 1.5, color: this.fWeekdays.includes(d) ? $r('app.color.accent') : $r('app.color.line') })
    .backgroundColor(this.fWeekdays.includes(d) ? $r('app.color.accent') : $r('app.color.card_bg'))
    .onClick(() => {
      this.toggleWeekday(d);
    })
  }

  @Builder
  wdChips() {
    Row({ space: 6 }) {
      ForEach([1, 2, 3, 4, 5, 6, 7], (d: number) => {
        this.wdChip(d)
      }, (d: number): string => `${d}`)
    }
    .width('100%')
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
        this.am.closeEditor();
      })

      Column({ space: 1 }) {
        Text(this.am.editingTaskId === '' ? '新建任务' : '编辑任务')
          .fontSize(16)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.text_primary'))
          .maxLines(1)
        Text('调度由桌面端触发 · 保存后立即生效')
          .fontSize(10.5)
          .fontColor($r('app.color.text_secondary'))
          .maxLines(1)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 8 })
    .alignItems(VerticalAlign.Center)
  }

  // ── 卡片 ──

  @Builder
  basicCard() {
    Column({ space: 13 }) {
      Column() {
        this.fLabel('任务名称', '')
        TextInput({ text: this.fName, placeholder: '例：每日提交汇总' })
          .onChange((value: string) => {
            this.fName = value;
            if (value.trim() !== '') {
              this.nameErr = false;
            }
          })
          .fontSize(13.5)
          .fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary'))
          .caretColor($r('app.color.accent'))
          .backgroundColor(this.nameErr ? $r('app.color.card_bg') : $r('app.color.input_bg'))
          .borderRadius(11)
          .border({ width: 1, color: this.nameErr ? $r('app.color.status_danger') : Color.Transparent })
          .padding({ left: 12, right: 12 })
          .height(42)
          .maxLength(40)
          .width('100%')
        if (this.nameErr) {
          Text('请填写任务名称')
            .fontSize(11)
            .fontColor($r('app.color.status_danger'))
            .margin({ top: 4 })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column() {
        this.fLabel('任务指令', '')
        TextArea({ text: this.fPrompt, placeholder: '描述这个任务要做什么、做到什么程度…' })
          .onChange((value: string) => {
            this.fPrompt = value;
            if (value.trim() !== '') {
              this.promptErr = false;
            }
          })
          .fontSize(13.5)
          .fontColor($r('app.color.text_primary'))
          .placeholderColor($r('app.color.text_secondary'))
          .caretColor($r('app.color.accent'))
          .backgroundColor(this.promptErr ? $r('app.color.card_bg') : $r('app.color.input_bg'))
          .borderRadius(11)
          .border({ width: 1, color: this.promptErr ? $r('app.color.status_danger') : Color.Transparent })
          .padding(12)
          .height(96)
          .width('100%')
        if (this.promptErr) {
          Text('请填写任务指令')
            .fontSize(11)
            .fontColor($r('app.color.status_danger'))
            .margin({ top: 4 })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  runCard() {
    Column({ space: 13 }) {
      Column() {
        this.fLabel('工作区', '')
        Row() {
          Text(this.wsRowText())
            .fontSize(12)
            .fontFamily('monospace')
            .fontColor($r('app.color.text_secondary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .borderRadius(11)
        .backgroundColor($r('app.color.input_bg'))
        .alignItems(VerticalAlign.Center)
        this.hintText(this.am.editingTaskId === ''
          ? '任务在桌面端当前选中的工作区内执行，手机端不单独指定'
          : '工作区绑定不在手机端修改 · 换绑请回桌面 aide')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column() {
        this.fLabel('模型', '留空跟随桌面设置')
        Row({ space: 8 }) {
          Text(this.modelLabel())
            .fontSize(12.5)
            .fontColor($r('app.color.text_primary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          SymbolGlyph($r('sys.symbol.chevron_down'))
            .fontSize(13)
            .fontColor([$r('app.color.text_secondary')])
        }
        .width('100%')
        .padding({ left: 12, right: 12, top: 10, bottom: 10 })
        .borderRadius(11)
        .backgroundColor($r('app.color.input_bg'))
        .alignItems(VerticalAlign.Center)
        .bindMenu(this.modelMenu())
        this.hintText('选项取自当前供应商的本地模型列表（与聊天模型 chip 同源），不调用远程 getDefaultModel')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)

      Column() {
        this.fLabel('思考程度', '')
        this.segView(this.effortOpts(), this.fEffort, 'effort')
      }
      .width('100%')

      Column() {
        this.fLabel('连接器', 'v1 只读')
        Flex({ wrap: FlexWrap.Wrap }) {
          if (this.connList().length === 0) {
            this.chipView('无连接器', false)
          } else {
            ForEach(this.connList(), (c: string) => {
              this.chipView(c, true)
            }, (c: string) => c)
          }
        }
        .width('100%')
        this.hintText(this.am.editingTaskId === ''
          ? '新建任务暂不带连接器 · 增删请回桌面 aide（v1 只读）'
          : '连接器随任务保存 · 增删请回桌面 aide（v1 只读）')
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  permCard() {
    Column({ space: 8 }) {
      this.fLabel('权限预设', '')
      this.presetCard('auto', '● 自动（推荐）', '安全操作自动放行；写盘与命令执行需桌面确认')
      this.presetCard('full', '○ 全自动', '所有操作自动放行，仅建议在受信任工作区使用')
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  schedCard() {
    Column({ space: 13 }) {
      Column() {
        this.fLabel('调度方式', '与协议 kind 一一对应')
        this.segView(KIND_OPTS, this.fKind, 'kind')
      }
      .width('100%')

      if (this.fKind === 'daily') {
        Column() {
          this.fLabel('执行时间', '')
          this.pickerRow(this.fTime, '', 'time')
        }
        .width('100%')
      } else if (this.fKind === 'weekly') {
        Column() {
          this.fLabel('执行时间', '')
          this.pickerRow(this.fTime, '', 'time')
        }
        .width('100%')
        Column() {
          this.fLabel('重复于', '')
          this.wdChips()
        }
        .width('100%')
      } else if (this.fKind === 'monthly') {
        Column() {
          this.fLabel('执行时间', '')
          this.pickerRow(this.fTime, '', 'time')
        }
        .width('100%')
        Column() {
          this.fLabel('每月几号', '1-31')
          TextInput({ text: this.fDayText, placeholder: '1' })
            .type(InputType.Number)
            .onChange((value: string) => {
              this.fDayText = value;
            })
            .fontSize(13.5)
            .fontColor($r('app.color.text_primary'))
            .placeholderColor($r('app.color.text_secondary'))
            .caretColor($r('app.color.accent'))
            .backgroundColor($r('app.color.input_bg'))
            .borderRadius(11)
            .padding({ left: 12, right: 12 })
            .height(42)
            .maxLength(2)
            .width('100%')
        }
        .width('100%')
      } else if (this.fKind === 'interval') {
        Column() {
          this.fLabel('间隔', '')
          TextInput({ text: this.fEveryText, placeholder: '6' })
            .type(InputType.Number)
            .onChange((value: string) => {
              this.fEveryText = value;
            })
            .fontSize(13.5)
            .fontColor($r('app.color.text_primary'))
            .placeholderColor($r('app.color.text_secondary'))
            .caretColor($r('app.color.accent'))
            .backgroundColor($r('app.color.input_bg'))
            .borderRadius(11)
            .padding({ left: 12, right: 12 })
            .height(42)
            .maxLength(4)
            .width('100%')
        }
        .width('100%')
        Column() {
          this.fLabel('单位', '')
          this.segView(UNIT_OPTS, this.fUnit, 'unit')
        }
        .width('100%')
      } else {
        Column() {
          this.fLabel('日期', '')
          this.pickerRow(this.fOnceDate, '请选择日期', 'onceDate')
        }
        .width('100%')
        Column() {
          this.fLabel('时间', '')
          this.pickerRow(this.fOnceTime, '', 'onceTime')
        }
        .width('100%')
      }

      Column() {
        this.fLabel('错过处理', '桌面离线错过排程时')
        this.segView(this.missedOpts(), this.fMissed, 'missed')
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  notifyCard() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Column({ space: 1 }) {
          Text('成功通知')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
          Text('运行成功时发系统通知')
            .fontSize(10.5)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        this.toggleSwitch(this.fNotifyOk, 'notifyOk')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: 10 }) {
        Column({ space: 1 }) {
          Text('失败通知')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
          Text('运行失败时发系统通知')
            .fontSize(10.5)
            .fontColor($r('app.color.text_secondary'))
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        this.toggleSwitch(this.fNotifyFail, 'notifyFail')
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      this.hintText('通知由桌面端发出（手机在后台也能从运行记录看到结果）')
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 13, bottom: 13 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Start)
  }

  // ── 脚注 ──

  @Builder
  footView() {
    Row({ space: 10 }) {
      Row() {
        Text('取消')
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.text_primary'))
      }
      .padding({ left: 18, right: 18, top: 11, bottom: 11 })
      .borderRadius(12)
      .backgroundColor($r('app.color.card_bg'))
      .border({ width: 1, color: $r('app.color.line') })
      .justifyContent(FlexAlign.Center)
      .onClick(() => {
        this.am.closeEditor();
      })

      Row() {
        Text('保存')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor(Color.White)
      }
      .layoutWeight(1)
      .padding({ top: 11, bottom: 11 })
      .borderRadius(12)
      .backgroundColor($r('app.color.accent'))
      .justifyContent(FlexAlign.Center)
      .opacity(this.am.saving ? 0.55 : 1)
      .onClick(() => {
        this.save(false);
      })

      Row() {
        Text('▶ 运行')
          .fontSize(14)
          .fontWeight(FontWeight.Bold)
          .fontColor(Color.White)
      }
      .padding({ left: 18, right: 18, top: 11, bottom: 11 })
      .borderRadius(12)
      .backgroundColor($r('app.color.accent'))
      .justifyContent(FlexAlign.Center)
      .opacity(this.am.saving ? 0.55 : 1)
      .onClick(() => {
        this.save(true);
      })
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 10, bottom: 14 })
    .border({ width: { top: 1 }, color: $r('app.color.line') })
    .alignItems(VerticalAlign.Center)
  }

  // ── 根 ──

  build() {
    if (this.am.view === 'editor') {
      Column() {
        this.headView()
        Scroll() {
          Column({ space: 10 }) {
            this.basicCard()
            this.runCard()
            this.permCard()
            this.schedCard()
            this.notifyCard()
          }
          .width('100%')
          .padding({ left: 14, right: 14, top: 4, bottom: 18 })
          .alignItems(HorizontalAlign.Start)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .edgeEffect(EdgeEffect.Spring)
        this.footView()
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.page_bg'))
      .transition(TransitionEffect.translate({ y: '100%' }).animation({ duration: 240, curve: Curve.Friction }))
    }
  }
}

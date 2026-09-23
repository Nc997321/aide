/**
 * 自动化任务模型：列表 / 详情 / 表单 / 转录 / 手册的全局可观察状态 + CRUD
 * 编排 + live 事件层。
 *
 * 编排对照桌面 src/composables/useAutomation.ts（ArkTS 化）：
 *  - 视图层不 import 本模型直接改状态——变更只经动作方法
 *  - ⚠️ 此域 11 个命令未进远程 REGISTRY（见 api.ets 头注）：桌面开口子前
 *    所有 invoke 必败——错误态是一等公民（lastError 驱动错误条 / toast 提示），
 *    不崩不白屏；桌面清单落地后逐级点亮
 *  - live 事件层（第三路 chat-event 监听；ChatModel / SessionsModel 双监听
 *    先例，监听挂传输实例只挂一次，ensureListener 幂等）：
 *      · session_init 的 session_id 以 run_ 开头 → 登记别名（路由键 →
 *        sdk_session_id；蒸馏轮 {run_id}-d 同法）并刷新列表点亮呼吸点
 *      · 别名会话（或 run_ 前缀自身）的 message_stop / error / session_dead
 *        → refreshTasks() 对账 + 详情开着则重拉 runs/stats
 *      · 归因靠刷新对账：事件流不含任务 id，lastRunStatus 以列表拉取为权威；
 *        只认生命周期/终态事件（增量可被 stdout 背压丢弃，不假设 delta 完整）
 *      · 断线窗口无从得知 → onReconnected 后 refreshTasks() 兜底
 *      · automation_run_finished / automation_missed 现状不达远程端
 *        （scheduler 只 app.emit 本地 webview），桌面补 chat_events_tx 后再接
 *  - toast 通道注入（pickToast）：本模型不 import ChatDrawer 防循环依赖
 *    （ChatDrawer → AutomationModel 已成链，回指即环——ChatAttachments 同款）
 * 差异：Vue reactive Set → @ObservedV2 + @Trace（整体替换数组驱动观察）。
 */
import { AideEvent } from '../sdk/transport';
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { AutomationTask, AutomationTaskInput, RunRecord, RunStats } from '../sdk/types';
import { str } from './chat/ChatWire';

@ObservedV2
export class AutomationModel {
  /** 首次拉取完成（区分「加载中」与「真空」空态）。 */
  @Trace loaded: boolean = false;
  @Trace tasks: AutomationTask[] = [];
  @Trace refreshing: boolean = false;
  /** 列表拉取失败提示（空串 = 无错；驱动抽屉区段错误条）。 */
  @Trace lastError: string = '';

  /** 当前浮层：'' 无 / 'detail' 详情 / 'editor' 表单。 */
  @Trace view: string = '';
  @Trace selectedTaskId: string = '';
  /** 表单编辑中的任务 id（空串 = 新建）。 */
  @Trace editingTaskId: string = '';

  @Trace runs: RunRecord[] = [];
  @Trace stats: RunStats | null = null;
  @Trace runsLoading: boolean = false;
  /** 运行记录拉取失败提示（空串 = 无错）。 */
  @Trace runsError: string = '';

  /** 转录浮层打开的运行记录（null = 关闭）。 */
  @Trace runView: RunRecord | null = null;

  /** 手册浮层（playbookView + 三态：loading / text / error）。 */
  @Trace playbookView: boolean = false;
  @Trace playbookLoading: boolean = false;
  /** 手册内容（加载成功后空串 = 未生成）。 */
  @Trace playbookText: string = '';
  @Trace playbookError: string = '';

  /** runNow 在途的任务 id（按钮禁用防连点）。 */
  @Trace busyTaskId: string = '';
  /** 保存（create/update）在途（表单保存按钮禁用）。 */
  @Trace saving: boolean = false;

  /** toast 通道（ChatPage aboutToAppear 注入；缺省静默）。 */
  pickToast: (msg: string, kind: string) => void = (_msg: string, _kind: string) => {};

  private listening: boolean = false;
  /** run 路由键别名表：SDK 真实 id → run_xxx（session_init 登记，终态判归用）。 */
  private aliases: Map<string, string> = new Map();
  /** 刷新排队标记：在途时再收终态事件，完成后补一拍（对账终值）。 */
  private refreshQueued: boolean = false;

  /** 页面挂载时调用：幂等挂 chat-event + 重连监听（挂传输实例，只挂一次）。 */
  ensureListener(): void {
    if (this.listening) {
      return;
    }
    const t = connModel.transport;
    if (t === null) {
      return; // authed 后 transport 必在；防御未连接时提前挂载
    }
    this.listening = true;
    t.listen<Record<string, Object>>('chat-event', (e: AideEvent<Record<string, Object>>) => {
      this.onChatEvent(e.payload);
    });
    // 断线期间的运行起止无从得知：重连成功后整表对账
    t.onReconnected(() => {
      this.refreshTasks();
    });
  }

  // ── 列表 ──

  /** 拉取任务列表（authed 前置 + 防重入；在途再触发 → 完成后补一拍）。 */
  async refreshTasks(): Promise<void> {
    if (connModel.state !== 'authed') {
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      this.tasks = await api.listAutomations();
      this.loaded = true;
      this.lastError = '';
    } catch (e) {
      // 拉取失败不静默：抽屉区段错误条如实呈现（REGISTRY 未开口子时的常态）
      if (connModel.state === 'authed') {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshTasks();
      }
    }
  }

  /** 抽屉打开 / 详情进入时的兜底首拉（已加载则不重拉，重开不闪）。 */
  ensureLoaded(): void {
    if (!this.loaded && !this.refreshing) {
      void this.refreshTasks();
    }
  }

  taskById(id: string): AutomationTask | null {
    for (let i = 0; i < this.tasks.length; i++) {
      if (this.tasks[i].id === id) {
        return this.tasks[i];
      }
    }
    return null;
  }

  selectedTask(): AutomationTask | null {
    return this.selectedTaskId === '' ? null : this.taskById(this.selectedTaskId);
  }

  /** 是否有任务在跑（抽屉呼吸点；lastRunStatus 以列表拉取为权威）。 */
  hasRunning(): boolean {
    for (let i = 0; i < this.tasks.length; i++) {
      if (this.tasks[i].lastRunStatus === 'running') {
        return true;
      }
    }
    return false;
  }

  // ── 详情 / 运行记录 ──

  /** 打开详情：选中 + 静默对账列表 + 拉 runs/stats。 */
  selectTask(id: string): void {
    this.selectedTaskId = id;
    this.view = 'detail';
    void this.refreshTasks();
    void this.refreshRuns();
  }

  closeDetail(): void {
    this.view = '';
    this.selectedTaskId = '';
    this.runs = [];
    this.stats = null;
    this.runsError = '';
    this.runView = null;
  }

  /** 拉运行记录 + 统计（limit 100 对照桌面；防重入）。 */
  async refreshRuns(): Promise<void> {
    if (this.runsLoading || this.selectedTaskId === '' || connModel.state !== 'authed') {
      return;
    }
    this.runsLoading = true;
    const id: string = this.selectedTaskId;
    try {
      const rs: RunRecord[] = await api.listAutomationRuns(id, 100);
      // 竞态防护：等待期间切了任务，丢弃过期结果
      if (this.selectedTaskId !== id) {
        return;
      }
      this.runs = rs;
      this.stats = await api.automationRunStats(id);
      this.runsError = '';
    } catch (e) {
      if (this.selectedTaskId === id && connModel.state === 'authed') {
        this.runs = [];
        this.stats = null;
        this.runsError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.runsLoading = false;
    }
  }

  // ── 表单 ──

  /** 打开表单：id 空串 = 新建；编辑既有则从详情进入（返回回详情）。 */
  openEditor(id: string): void {
    this.editingTaskId = id;
    this.view = 'editor';
  }

  /** 关表单：编辑既有 → 回详情；新建 → 直接收（无详情层）。 */
  closeEditor(): void {
    this.view = this.editingTaskId !== '' && this.selectedTaskId !== '' ? 'detail' : '';
    if (this.view === '') {
      // 新建取消：不残留编辑态
      this.editingTaskId = '';
    }
  }

  /**
   * 保存（新建走 create / 编辑走 update）。成功：任务落列表、选中进详情、
   * 拉 runs；失败：错误文本 toast、停留表单（保留草稿）。返回是否成功。
   */
  async saveTask(input: AutomationTaskInput): Promise<boolean> {
    if (this.saving) {
      return false;
    }
    this.saving = true;
    try {
      const saved: AutomationTask = this.editingTaskId === ''
        ? await api.createAutomation(input)
        : await api.updateAutomation(this.editingTaskId, input);
      this.replaceTask(saved);
      this.selectedTaskId = saved.id;
      this.view = 'detail';
      this.editingTaskId = '';
      void this.refreshRuns();
      return true;
    } catch (e) {
      this.pickToast(e instanceof Error ? e.message : String(e), 'warn');
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 删除任务（运行历史与手册一并删除——服务端语义）：列表摘除 + 收详情。 */
  async deleteTask(id: string): Promise<void> {
    try {
      await api.deleteAutomation(id);
      this.tasks = this.tasks.filter((t: AutomationTask) => t.id !== id);
      if (this.selectedTaskId === id) {
        this.closeDetail();
      }
      this.pickToast('已删除', 'ok');
    } catch (e) {
      this.pickToast(e instanceof Error ? e.message : String(e), 'warn');
    }
  }

  /** 启停开关：等回执再落列表（不乐观更新——失败时开关不该跳变）。 */
  async toggleEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      const t: AutomationTask = await api.setAutomationEnabled(id, enabled);
      this.replaceTask(t);
    } catch (e) {
      this.pickToast(e instanceof Error ? e.message : String(e), 'warn');
    }
  }

  /**
   * 立即运行：busy 时 Err 文本 `「{name}」正在运行中` 直显 toast；成功后
   * 对账列表（呼吸点点亮）+ 详情开着重拉 runs。quiet = 调用方自带确认
   * toast（表单「保存并运行」）：成功提示由调用方发，失败仍直显。
   */
  async runNow(id: string, quiet: boolean = false): Promise<void> {
    if (this.busyTaskId !== '') {
      return;
    }
    this.busyTaskId = id;
    try {
      await api.runAutomationNow(id);
      if (!quiet) {
        this.pickToast('已开始运行', 'ok');
      }
      void this.refreshTasks();
      if (this.selectedTaskId === id) {
        void this.refreshRuns();
      }
    } catch (e) {
      this.pickToast(e instanceof Error ? e.message : String(e), 'warn');
    } finally {
      this.busyTaskId = '';
    }
  }

  // ── 手册 ──

  /** 打开手册浮层并拉取内容（null → 空态文案由 UI 呈现）。 */
  async readPlaybook(): Promise<void> {
    if (this.selectedTaskId === '') {
      return;
    }
    this.playbookView = true;
    this.playbookLoading = true;
    this.playbookError = '';
    const id: string = this.selectedTaskId;
    try {
      const content: string | null = await api.getAutomationPlaybook(id);
      if (this.selectedTaskId !== id) {
        return;
      }
      this.playbookText = content ?? '';
    } catch (e) {
      if (this.selectedTaskId === id) {
        this.playbookError = e instanceof Error ? e.message : String(e);
        this.playbookText = '';
      }
    } finally {
      this.playbookLoading = false;
    }
  }

  closePlaybook(): void {
    this.playbookView = false;
  }

  /** 重新提炼：playbookState → stale（下次运行重走 explore + 蒸馏）。 */
  async redistill(id: string): Promise<void> {
    try {
      const t: AutomationTask = await api.redistillAutomation(id);
      this.replaceTask(t);
      this.pickToast('已标记重新提炼：下次运行将按探索模式执行并重建手册', 'ok');
    } catch (e) {
      this.pickToast(e instanceof Error ? e.message : String(e), 'warn');
    }
  }

  // ── 转录 ──

  openRun(r: RunRecord): void {
    this.runView = r;
  }

  closeRun(): void {
    this.runView = null;
  }

  /**
   * 运行中转录的「刷新」入口：重拉 runs 并原位更新 runView
   * （不做实时流——打开的是只读历史，运行中经手动刷新回查）。
   */
  async refreshRunView(): Promise<void> {
    if (this.runView === null) {
      return;
    }
    const targetId: string = this.runView.runId;
    await this.refreshRuns();
    for (let i = 0; i < this.runs.length; i++) {
      if (this.runs[i].runId === targetId) {
        this.runView = this.runs[i];
        return;
      }
    }
  }

  // ── 返回栈（Index.onBackPress 最前；转录 > 手册 > 表单 > 详情）──

  handleBack(): boolean {
    if (this.runView !== null) {
      this.runView = null;
      return true;
    }
    if (this.playbookView) {
      this.playbookView = false;
      return true;
    }
    if (this.view === 'editor') {
      this.closeEditor();
      return true;
    }
    if (this.view === 'detail') {
      this.closeDetail();
      return true;
    }
    return false;
  }

  /** 页面卸载复位（ChatPage.aboutToDisappear）：单例不随组件销毁，浮层全收
   * （与 drawerState.close 同款约定——落回连接页不残留，重进不闪旧态）。 */
  resetViews(): void {
    this.view = '';
    this.selectedTaskId = '';
    this.editingTaskId = '';
    this.runs = [];
    this.stats = null;
    this.runsError = '';
    this.runView = null;
    this.playbookView = false;
    this.playbookLoading = false;
    this.playbookText = '';
    this.playbookError = '';
  }

  // ── 内部 ──

  /** 列表内替换（保存/开关/重蒸馏回执落位；不在列表则追加）。 */
  private replaceTask(t: AutomationTask): void {
    const next: AutomationTask[] = [];
    let found: boolean = false;
    for (let i = 0; i < this.tasks.length; i++) {
      if (this.tasks[i].id === t.id) {
        next.push(t);
        found = true;
      } else {
        next.push(this.tasks[i]);
      }
    }
    if (!found) {
      next.push(t);
    }
    this.tasks = next;
  }

  /**
   * chat-event → live 推导（只认生命周期/终态事件；其余 chat 事件零开销返回）。
   * 主机制：run_ 前缀 session_init 登记别名 → 别名会话终态事件 → 刷新对账。
   */
  private onChatEvent(payload: Record<string, Object>): void {
    const sid: string = str(payload, 'session_id');
    if (sid === '') {
      return;
    }
    const type: string = str(payload, 'type');
    if (type === 'session_init') {
      if (sid.indexOf('run_') === 0) {
        // 别名登记：此后事件全带 SDK 真实 id（sidecar re-key；蒸馏轮 -d 同法）
        const sdk: string = str(payload, 'sdk_session_id');
        if (sdk !== '') {
          this.aliases.set(sdk, sid);
        }
        // 运行起跑：对账点亮呼吸点（详情开着顺带重拉 runs）
        this.onRunActivity();
      }
      return;
    }
    if (type === 'message_stop' || type === 'error' || type === 'session_dead') {
      if (this.aliases.has(sid) || sid.indexOf('run_') === 0) {
        // 终态：刷新对账（lastRunStatus 以列表拉取为权威）；别名保留——
        // error(fatal:false) 可恢复，后续 message_stop 再对账无害且幂等
        this.onRunActivity();
      }
    }
  }

  /** run 流活动：列表对账 + 详情命中刷新（REGISTRY 未开口子时静默失败）。 */
  private onRunActivity(): void {
    void this.refreshTasks();
    if (this.view === 'detail') {
      void this.refreshRuns();
    }
  }
}

/** 全局单例：抽屉区段 / 详情 / 表单 / 转录 / 手册共用同一份状态。 */
export const automationModel: AutomationModel = new AutomationModel();

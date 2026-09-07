/**
 * 会话列表模型：工作区作用域拉取 + 三态徽标推导（chat-event 驱动）+ 重连补拉。
 *
 * 编排对照 remote-pwa/src/App.vue 的会话列表段（ArkTS 化）：
 *  - 三态推导（纯客户端事件面，无协议改动）：
 *    · 回复中（live）：事件流中标记，message_stop / 轮次终结清除
 *    · 待确认（wait）：permission_request 置位；应答（本机 clearWaitConfirm /
 *      桌面侧放行后的首个工作恢复事件）/ permission_cancelled / message_stop /
 *      会话死清除——sidecar 阻塞等答期间无工作事件，恢复信号即「已应答」
 *    · 已启动（started）：见过任意事件即运行时存活；message_stop 保留（进程
 *      仍在，仅回合结束）；session_dead / 致命 error（fatal !== false）清除。
 *      仅内存态：重启后需等下一事件点亮（假阴性可接受）；权威态需 list_sessions
 *      扩展 started / pending_confirm 字段（原型实施清单标注的协议缺口）
 *  - 工作区作用域：wsKey = '' 跟随桌面当前活动工作区（list_sessions），
 *    其余按 key 拉 list_sessions_for_workspace——手机侧只改浏览范围
 *  - 拉取失败不静默（lastError 驱动错误条）；重连后 refresh 补齐断线窗口缺口
 * 差异：Vue reactive Set → @ObservedV2 + @Trace 数组（整体替换，观察可靠）。
 */
import { AideEvent } from '../sdk/transport';
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { Session } from '../sdk/types';

/**
 * 「工作恢复」信号：这些事件到达说明等待态实际已结束（应答放行 / 拒绝后
 * 模型续跑都会先出其一）。不含 user_message——等答期间排队的消息不算恢复。
 */
const WAIT_RESUME_EVENTS: string[] = [
  'tool_use_start', 'text_delta', 'thinking', 'thinking_delta',
  'subagent_start', 'subagent_text_delta', 'subagent_thinking_delta',
  'subagent_progress', 'subagent_tool_result', 'subagent_end'
];

/** id 集合置位/清除（纯函数：整体替换驱动 @Trace；幂等，状态未变时原样返回）。 */
function flipId(ids: string[], sid: string, on: boolean): string[] {
  const has: boolean = ids.indexOf(sid) >= 0;
  if (on === has) {
    return ids;
  }
  return on ? ids.concat([sid]) : ids.filter((s: string) => s !== sid);
}

@ObservedV2
export class SessionsModel {
  @Trace sessions: Session[] = [];
  /** 正在回复中的会话 id（chat-event 标记 / message_stop 清除）。 */
  @Trace liveIds: string[] = [];
  /** 挂起权限请求的会话 id（待确认；置位/清除见类头推导表）。 */
  @Trace waitConfirmIds: string[] = [];
  /** 运行时存活的会话 id（已启动；含回复中/待确认——推导上后者必在前者）。 */
  @Trace startedIds: string[] = [];
  /** 手机侧浏览的工作区 key（'' = 桌面当前活动工作区）。 */
  @Trace wsKey: string = '';
  /** 下拉刷新/手动刷新进行中。 */
  @Trace refreshing: boolean = false;
  /** 首次拉取完成（区分「加载中」与「真空」空态）。 */
  @Trace loaded: boolean = false;
  /** 拉取失败提示（空串 = 无错）。 */
  @Trace lastError: string = '';

  private listening: boolean = false;

  /** 页面挂载时调用：幂等挂 chat-event + 重连监听（监听挂在传输实例上，只挂一次）。 */
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
    // 断线期间的事件缺口：重连成功后整表重拉
    t.onReconnected(() => {
      this.refresh();
    });
  }

  /** 拉取会话列表（按 wsKey 作用域；authed 前置；防重入）。 */
  async refresh(): Promise<void> {
    if (this.refreshing || connModel.state !== 'authed') {
      return;
    }
    this.refreshing = true;
    try {
      this.sessions = this.wsKey === ''
        ? await api.listSessions()
        : await api.listSessionsForWorkspace(this.wsKey);
      this.loaded = true;
      this.lastError = '';
    } catch (e) {
      // 拉取失败不静默：显示错误条，下拉可重试
      if (connModel.state === 'authed') {
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** 切换浏览的工作区（'' = 跟随桌面）并立即重拉列表。 */
  selectWorkspace(key: string): void {
    if (key === this.wsKey) {
      return;
    }
    this.wsKey = key;
    this.refresh();
  }

  isLive(sid: string): boolean {
    return this.liveIds.indexOf(sid) >= 0;
  }

  /** 本机应答权限：等待态同步终结（事件面幂等，后续事件重复到达无害）。 */
  clearWaitConfirm(sid: string): void {
    this.setWait(sid, false);
  }

  /** 本机中断等主动终结轮次：回复中/待确认让位，已启动保留（进程仍存活）。 */
  markRoundEnd(sid: string): void {
    this.setLive(sid, false);
    this.setWait(sid, false);
  }

  /**
   * 会话状态点（原型：列表只留点不带文字）：'wait' > 'live' > 'started' >
   * 'none'，单点取最高优先级；颜色语义的文字说明只在工作区卡计数处。
   */
  statusOf(sid: string): string {
    if (this.waitConfirmIds.indexOf(sid) >= 0) {
      return 'wait';
    }
    if (this.liveIds.indexOf(sid) >= 0) {
      return 'live';
    }
    if (this.startedIds.indexOf(sid) >= 0) {
      return 'started';
    }
    return 'none';
  }

  /** 工作区卡元信息三态计数（当前列表 ∩ 对应 id 集合；只列非零由 UI 决定）。 */
  liveCount(): number {
    return this.countIn(this.liveIds);
  }

  waitCount(): number {
    return this.countIn(this.waitConfirmIds);
  }

  /** 已启动 = 运行时存活（推导上含回复中/待确认，原型 startedCount 同语义）。 */
  startedCount(): number {
    return this.countIn(this.startedIds);
  }

  /** 自动命名落地（chat session_title 事件）：列表注册表同步改名（整体替换驱动 @Trace）。 */
  adoptName(sid: string, name: string): void {
    for (let i = 0; i < this.sessions.length; i++) {
      const s: Session = this.sessions[i];
      if (s.id === sid) {
        const renamed: Session = { id: s.id, name: name, timestamp: s.timestamp };
        this.sessions = this.sessions.slice(0, i).concat([renamed]).concat(this.sessions.slice(i + 1));
        return;
      }
    }
  }

  /**
   * spawn 定名后登记新会话（列表头插；对照 PWA sidebar.addSession）。
   * 归属核对：仅当列表仍在 spawn 发起时的工作区才头插——切换竞态下不插错
   * 列表（正确条目随下次 refresh 从磁盘归位）。
   */
  adoptNewSession(s: Session, wsKey: string): void {
    for (let i = 0; i < this.sessions.length; i++) {
      // 已在列表（重复回执/并发刷新竞态）：只改名不重插
      if (this.sessions[i].id === s.id) {
        this.adoptName(s.id, s.name);
        return;
      }
    }
    if (wsKey !== this.wsKey) {
      return;
    }
    const head: Session[] = [s];
    this.sessions = head.concat(this.sessions);
  }

  // ── 内部 ──

  private countIn(ids: string[]): number {
    let n: number = 0;
    for (let i = 0; i < this.sessions.length; i++) {
      if (ids.indexOf(this.sessions[i].id) >= 0) {
        n++;
      }
    }
    return n;
  }

  private setLive(sid: string, on: boolean): void {
    this.liveIds = flipId(this.liveIds, sid, on);
  }

  private setWait(sid: string, on: boolean): void {
    this.waitConfirmIds = flipId(this.waitConfirmIds, sid, on);
  }

  private setStarted(sid: string, on: boolean): void {
    this.startedIds = flipId(this.startedIds, sid, on);
  }

  /** chat-event → 三态推导（对照 App.vue 全局监听；全 sid 生效，不限于打开的会话）。 */
  private onChatEvent(payload: Record<string, Object>): void {
    const sidObj: Object | undefined = payload['session_id'];
    if (sidObj === undefined || typeof sidObj !== 'string') {
      return;
    }
    const sid: string = sidObj as string;
    const typeObj: Object | undefined = payload['type'];
    const type: string = typeof typeObj === 'string' ? typeObj as string : '';
    if (type === '') {
      return;
    }
    switch (type) {
      case 'permission_request':
        // 阻塞等答：待确认置位，回复中让位（blocked ≠ 流式），运行时必存活
        this.setWait(sid, true);
        this.setLive(sid, false);
        this.setStarted(sid, true);
        break;
      case 'permission_cancelled':
        this.setWait(sid, false);
        break;
      case 'message_stop':
        // 轮次收尾：回复中/待确认清，已启动保留
        this.setLive(sid, false);
        this.setWait(sid, false);
        break;
      case 'session_dead':
        // 进程覆灭：三态全清
        this.setLive(sid, false);
        this.setWait(sid, false);
        this.setStarted(sid, false);
        break;
      case 'error': {
        // fatal:false = 可恢复（进程仍存活，仅本回合复位）；缺省/true = 运行时覆灭
        const fatalObj: Object | undefined = payload['fatal'];
        const recoverable: boolean = typeof fatalObj === 'boolean' && !(fatalObj as boolean);
        this.setLive(sid, false);
        this.setWait(sid, false);
        if (!recoverable) {
          this.setStarted(sid, false);
        }
        break;
      }
      default:
        // 工作恢复信号（应答放行后首个工作事件）：待确认让位回复中
        if (WAIT_RESUME_EVENTS.indexOf(type) >= 0) {
          this.setWait(sid, false);
        }
        this.setLive(sid, true);
        this.setStarted(sid, true);
        break;
    }
  }
}

/** 全局单例：页面与后续会话层共用同一份列表状态。 */
export const sessionsModel: SessionsModel = new SessionsModel();

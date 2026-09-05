/**
 * 会话列表模型：sessions 拉取 + live 徽标（chat-event 驱动）+ 重连补拉。
 *
 * 编排对照 remote-pwa/src/App.vue 的会话列表段（ArkTS 化）：
 *  - liveSessions 标记：收到事件即 live，message_stop 清除（Set → 数组，@Trace 可观察）
 *  - 拉取失败不静默：列表空会直接落空态，用户无从知道为什么（lastError 驱动错误条）
 *  - 重连后 refresh 补齐断线窗口的缺口
 * 差异：Vue reactive Set → @ObservedV2 + @Trace 数组（整体替换，观察可靠）。
 */
import { AideEvent } from '../sdk/transport';
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { Session } from '../sdk/types';

@ObservedV2
export class SessionsModel {
  @Trace sessions: Session[] = [];
  /** 正在回复中的会话 id（chat-event 标记 / message_stop 清除）。 */
  @Trace liveIds: string[] = [];
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

  /** 拉取会话列表（authed 前置；防重入）。 */
  async refresh(): Promise<void> {
    if (this.refreshing || connModel.state !== 'authed') {
      return;
    }
    this.refreshing = true;
    try {
      this.sessions = await api.listSessions();
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

  isLive(sid: string): boolean {
    return this.liveIds.indexOf(sid) >= 0;
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

  // ── 内部 ──

  /** chat-event → live 徽标：有事件即 live，message_stop 清除（对照 App.vue 全局监听）。 */
  private onChatEvent(payload: Record<string, Object>): void {
    const sidObj: Object | undefined = payload['session_id'];
    if (sidObj === undefined || typeof sidObj !== 'string') {
      return;
    }
    const sid: string = sidObj as string;
    const typeObj: Object | undefined = payload['type'];
    const isStop: boolean = typeof typeObj === 'string' && (typeObj as string) === 'message_stop';
    if (isStop) {
      if (this.liveIds.indexOf(sid) >= 0) {
        this.liveIds = this.liveIds.filter((s: string) => s !== sid);
      }
    } else {
      if (this.liveIds.indexOf(sid) < 0) {
        this.liveIds = this.liveIds.concat([sid]);
      }
    }
  }
}

/** 全局单例：页面与后续会话层共用同一份列表状态。 */
export const sessionsModel: SessionsModel = new SessionsModel();

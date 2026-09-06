/**
 * 会话状态层宿主门面：事件/重连接线 + 打开会话 + 发送/中断/权限应答。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession.ts（宿主），模块
 * 组织对照上游「目录结构即架构层级」拆入 chat/ 子目录：
 *  - chat/ChatStore.ets      per-会话可观察状态 + 回填注册表 + 生命周期原语（state.ts）
 *  - chat/ChatBlocks.ets     可观察块类型 + 子代理条目累积（types/chat.ts + state.ts 块段）
 *  - chat/ChatTranscript.ets 历史块映射纯函数（transcriptMapping.ts）
 *  - chat/ChatPagination.ets hydrate + 上滚分页（pagination.ts；d88dd73c 修复在此）
 *  - chat/ChatEvents.ets     流式事件总路由（events.ts）
 *  - chat/ChatWire.ets       JSON 边界小工具
 * 语义对齐：
 *  - 发送链路两段（对照 prepareSend/sendQueued）：本地状态就绪（isBusy + 排队提示）
 *    → fire-and-forget invoke → 失败 catch 兜底复位；忙碌排队带 jumpQueue 透传
 *  - **不本地渲染用户气泡**：气泡由 sidecar 广播的 user_message 事件统一渲染，
 *    本地发送也多一个 RTT 才出气泡。对照上游 useChatSession.ts 的方案 C
 *  - 断线重连整页重载（对照 reloadSessionMessages）：清消息/游标后重新 hydrate
 *  - 监听挂在传输实例上只挂一次（重建实例会让 listener 挂死连接）
 * 未过筛（随 UI 扩容）：evict 字节降级、页级回收 recycle、模型/effort/权限
 * 模式选择器、btw 支线、图片消息、AskUserQuestion 选项作答（v1 仅允许/拒绝）。
 * 本类无可观察状态（全在 ChatStore），是纯服务持有者；页面经 chatModel.store
 * 观察（@ObservedV2 字段级追踪，store 实例终生不变）。
 */
import { AideEvent } from '../sdk/transport';
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { BgTaskInfo } from '../sdk/types';
import { ChatStore } from './chat/ChatStore';
import { ChatMessage, PendingJump, PermissionRequest } from './chat/ChatBlocks';
import { hydrate as hydrateStore, loadOlder as loadOlderStore } from './chat/ChatPagination';
import { routeChatEvent } from './chat/ChatEvents';

/** 会话页路由参数（SessionsPage → ChatPage；声明一次，两页共用）。 */
export interface ChatPageParams {
  sid: string;
  name: string;
}

export class ChatModel {
  /** 单会话 store（单例实例终生不变；打开新会话 = resetForOpen 整体复位）。 */
  readonly store: ChatStore = new ChatStore();

  private listening: boolean = false;

  /** 页面挂载时调用：幂等挂 chat-event + 重连监听。 */
  ensureListener(): void {
    if (this.listening) {
      return;
    }
    const t = connModel.transport;
    if (t === null) {
      return; // 会话页只在 authed 后可达；防御未连接时提前挂载
    }
    this.listening = true;
    t.listen<Record<string, Object>>('chat-event', (e: AideEvent<Record<string, Object>>) => {
      routeChatEvent(this.store, e.payload);
    });
    // 断线期间的事件缺口：重连成功后整页重载对齐
    t.onReconnected(() => {
      this.reload();
    });
  }

  /** 打开会话（路由进入）：整体复位 + 立即 hydrate + 后台任务快照对账。 */
  open(sid: string, name: string): void {
    this.store.resetForOpen(sid, name);
    void hydrateStore(this.store);
    void this.syncBgTasks();
  }

  /** 历史加载失败后的显式重试（d88dd73c 回滚保证此处可恢复）。 */
  retryHydrate(): void {
    void hydrateStore(this.store);
  }

  /** 取更早一页（「加载更早」入口）。 */
  loadOlder(): void {
    void loadOlderStore(this.store);
  }

  /**
   * 发消息。忙碌（上一轮还在生成）走排队：带 jumpQueue 透传给 sidecar，由它在
   * 安全边界（当前工具跑完）interrupt 后再发；等待期间消息暂存 pendingJumps
   * 显示「待发出」条。离线直接拒绝（对照 PWA offline 禁用输入）。
   */
  send(prompt: string): void {
    const text: string = prompt.trim();
    if (text === '' || connModel.state !== 'authed' || this.store.sid === '') {
      return;
    }
    const sid: string = this.store.sid;
    const wasBusy: boolean = this.store.isBusy;
    this.store.isBusy = true;
    this.store.sysNote = '';
    if (wasBusy) {
      // 排队：只登记"待发出"提示条——气泡等 sidecar 真正接入这条消息时广播的
      // user_message 渲染。不 finishStreaming（当前 assistant 仍在流式，提前收尾
      // 会让工具结果/后续文本错位新建）。
      this.store.pendingJumps = this.store.pendingJumps.concat([new PendingJump(text)]);
    }
    // 直发路径同样不落气泡：与桌面端同源，统一由 user_message 事件渲染。本地乐观
    // 渲染意味着只有发起方看得见自己提的问题——手机上发的在桌面端消失，反之亦然。
    this.dispatchSend(sid, text, wasBusy);
  }

  /** 真实发送（fire-and-forget；失败兜底复位——对照上游 sendQueued 的 catch）。 */
  private async dispatchSend(sid: string, text: string, wasBusy: boolean): Promise<void> {
    try {
      await api.sendMessage({
        sessionId: sid,
        prompt: text,
        workspaceRoot: null,
        images: null,
        provider: null,
        resumeId: sid,
        initialModel: null,
        initialEffort: null,
        permissionMode: null,
        jumpQueue: wasBusy
      });
    } catch (e) {
      if (this.store.sid !== sid) {
        return; // 会话已切走：reject 不回写新会话状态
      }
      this.store.isBusy = false;
      this.store.pendingJumps = [];
      this.store.sysNote = `发送失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 中断当前生成（sidecar 仍存活）：复位忙碌态并收尾流式消息。 */
  async interrupt(): Promise<void> {
    const sid: string = this.store.sid;
    if (sid === '') {
      return;
    }
    try {
      await api.interruptSession(sid);
    } finally {
      if (this.store.sid === sid) {
        // 用户主动打断：待排队消息一并作废（sidecar 同）；权限队列同样清空
        this.store.resetRuntimeState();
      }
    }
  }

  /** 终止后台任务（fire-and-forget；终态经 bg_task_ended 回来自然收尾）。 */
  async stopBgTask(taskId: string): Promise<void> {
    const sid: string = this.store.sid;
    if (sid === '') {
      return;
    }
    try {
      await api.stopBgTask(sid, taskId);
    } catch (e) {
      // 终止失败静默——任务多半已自行结束，终态事件会照常到达
    }
  }

  /** 权限应答（v1 仅允许/拒绝；出队后 invoke，失败提示不回滚队列——sidecar 会重发）。 */
  async respondPermission(id: string, approved: boolean): Promise<void> {
    const sid: string = this.store.sid;
    this.store.pendingPermissions = this.store.pendingPermissions
      .filter((p: PermissionRequest) => p.id !== id);
    try {
      await api.permissionResponse(sid, id, approved);
    } catch (e) {
      if (this.store.sid === sid) {
        this.store.sysNote = `权限应答失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  /**
   * 后台任务快照对账：bg_task_* 是纯事件流，relay 只实时转发无重放——
   * 离线/未进会话页期间错过的任务靠 list_bg_tasks 回填（open / 重连
   * reload 后各一次）。失败静默：直播事件不受影响，只是错过存量。
   */
  private async syncBgTasks(): Promise<void> {
    const sid: string = this.store.sid;
    if (sid === '') {
      return;
    }
    try {
      const infos: BgTaskInfo[] = await api.listBgTasks(sid);
      if (this.store.sid === sid) {
        this.store.reconcileBgTasks(infos);
      }
    } catch (e) {
      // 快照失败静默——直播事件仍会到达
    }
  }

  /** 断线重连整页重载：复位由 resetForReload 承担（只清消息/游标，不动 isBusy）。 */
  private async reload(): Promise<void> {
    if (this.store.sid === '') {
      return;
    }
    this.store.resetForReload();
    await hydrateStore(this.store);
    await this.syncBgTasks();
  }
}

/** 全局单例：会话页观察；同一时刻只有一个打开的会话。 */
export const chatModel: ChatModel = new ChatModel();

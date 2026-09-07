/**
 * 单会话 store：可观察状态 + 工具/子代理回填注册表 + 生命周期原语。
 *
 * 过筛自 packages/aide-sdk/src/composables/useChatSession/state.ts
 * （SessionStore / pendingSubagents / getOrCreateAssistant /
 * finishStreaming / resetRuntimeState / stampMessageModel）。
 * 与上游的结构性差异（单例单会话 vs per-sid Map）：
 *  - 鸿蒙端一次只打开一个会话（路由推入），store 无需 per-sid 字典与
 *    disposedSids/aliasMap 生命周期链；切会话 = resetForOpen 整体复位，
 *    在途异步（hydrate/发送）由各处以 sid 比对防串写
 *  - 上游 ⚠️「必须返回响应式 proxy」的陷阱由 @ObservedV2 字段级观察消解：
 *    store/块恒为同一实例，无原始引用绕过通知的路径
 *  - tailAt 为 ohos 专有滚动提示（上游 Vue 靠 watcher 监听数组），非上游状态
 *  - 消息列表结构变更通知（onMessagesStructureChanged）为 ohos 专有：页面
 *    LazyForEach 数据源据此与 messages 对账（虚拟加载，见 ChatMessagesSource）
 * 平台差异：Vue reactive/ref → @ObservedV2 + @Trace。
 */
import { ChatMessage, ContentBlock, PendingJump, PermissionRequest, ThinkingBlock, SubagentBlock, LiveActivity, BgTask } from './ChatBlocks';
import { BgTaskInfo, ModelOption } from '../../sdk/types';
import { uuid, str } from './ChatWire';

/** 流式跟尾节流间隔（毫秒）：text/thinking 增量高频到达，逐 bump 会把
 *  scrollEdge 打成逐帧动画；按此节奏放行，收尾（message_stop）兜底终贴。 */
const STREAM_FOLLOW_THROTTLE_MS: number = 120;

@ObservedV2
export class ChatStore {
  /** 当前打开的会话 id（空串 = 未打开）。 */
  @Trace sid: string = '';
  @Trace sessionName: string = '';
  @Trace messages: ChatMessage[] = [];
  /** 是否已从磁盘加载过历史（hydrate skip 分支闸门；失败回滚——见 ChatPagination）。 */
  @Trace hydrated: boolean = false;
  /** hydrate 失败标记（驱动「加载失败可重试」态；上游 PWA 无此态，回滚后重开才能重试）。 */
  @Trace hydrateFailed: boolean = false;
  @Trace isBusy: boolean = false;
  /**
   * spawn 在途：本地 tempId 作路由键、等 session_init 回执过户真实 id
   * （对照 PWA pendingSids；sidecar 在 init 时 re-key，此后事件全带真实 id）。
   * 期间 session_title 只暂存不落盘（tempId 无元数据），finalize 一次写盘。
   */
  @Trace pendingSpawn: boolean = false;
  /** spawn 定名缓冲（session_title 可能早于 session_init 到达；对照 PWA 暂存标题）。 */
  @Trace pendingSpawnTitle: string = '';
  /** spawn 发起时手机侧浏览的工作区 key：finalize 头插列表的归属核对（防切换竞态）。 */
  @Trace spawnWsKey: string = '';
  /** 挂起的权限请求队列（FIFO，弹层永远显示队头；并行工具会同时发多条）。 */
  @Trace pendingPermissions: PermissionRequest[] = [];
  /** 已派发、等安全边界的排队消息（jump_promoted 时 flush）。 */
  @Trace pendingJumps: PendingJump[] = [];
  /** 上滚取回进行中。 */
  @Trace loadingOlder: boolean = false;
  /**
   * 正在执行的主线程工具调用（V1 瞬态行：tool_use_start 入列、tool_result /
   * 轮次收尾移除；不进 messages，会话历史与内存皆不留痕）。
   */
  @Trace liveActivities: LiveActivity[] = [];
  /**
   * 后台 shell 任务（bg_task_* 累积；跨轮次存活——只有切会话/重载/进程死
   * 才清。结束任务保留至「全部完成」停留期满，由页面触发即焚）。
   */
  @Trace bgTasks: BgTask[] = [];
  /**
   * 分页游标（最老已加载页的页首字节；0 = 无更早页）。@Trace 驱动
   * 「加载更早」入口可见性（上游读普通 Map 需借 messages 变化重估，这里直观察）。
   */
  @Trace tailOffset: number = 0;
  /** 桌面侧执行/发送失败提示（空串 = 无；对照 PWA sysNote）。 */
  @Trace sysNote: string = '';
  /** 尾部追加时刻（页面据此滚到底；loadOlder 头部插入不 bump）。 */
  @Trace tailAt: number = 0;

  // ── 模型 / 思考程度（输入区 chip 域；选项集随激活供应商，当前值会话记忆优先）──

  /** 当前供应商的模型选项集（空 = 未加载；chip 回退占位文案，点击重同步）。 */
  @Trace modelOptions: ModelOption[] = [];
  /** 当前模型选择（协议 value；空 = 未选，语义 = 选项集首位即默认）。 */
  @Trace model: string = '';
  /** 当前思考档（恒为归一后三档 low/high/max；空 = 未同步）。 */
  @Trace effort: string = '';
  /** 模型浮层展开（自绘小面板；与 effortPop 互斥，Index 返回键经 handlePopups 收）。 */
  @Trace modelPop: boolean = false;
  /** 思考程度浮层展开（自绘小面板；与 modelPop 互斥）。 */
  @Trace effortPop: boolean = false;

  /** 上次流式跟尾 bump 时刻（bumpTailThrottled 节流窗）。 */
  private lastStreamBumpAt: number = 0;
  /** 消息列表结构变更回调注册表（页面 LazyForEach 数据源对账用，见 ChatMessagesSource）。 */
  private messagesChangeCallbacks: Array<() => void> = [];

  /**
   * 游标就绪标记（内部）：tailOffset 是否可信。分页模块（ChatPagination）
   * 读写；与 tailOffset 分离以支撑「游标缺失探测」分支。
   */
  cursorReady: boolean = false;
  /** subagent id → SubagentBlock（子代理事件跨回合，pending 期更长）。 */
  private pendingSubagents: Map<string, SubagentBlock> = new Map();

  // ── 子代理回填注册表（对照 state.ts register/lookup/unregister 三件套）──

  registerSubagent(id: string, block: SubagentBlock): void {
    this.pendingSubagents.set(id, block);
  }

  lookupSubagent(id: string): SubagentBlock | undefined {
    return this.pendingSubagents.get(id);
  }

  unregisterSubagent(id: string): void {
    this.pendingSubagents.delete(id);
  }

  // ── 瞬态工具行（V1：入列 bumpTail 供近底跟随；移除不 bump，行消失不打扰阅读位）──

  addLiveActivity(a: LiveActivity): void {
    this.liveActivities = this.liveActivities.concat([a]);
    this.bumpTail();
  }

  removeLiveActivity(id: string): void {
    if (this.liveActivities.length === 0) {
      return;
    }
    this.liveActivities = this.liveActivities.filter((x: LiveActivity) => x.id !== id);
  }

  // ── 后台任务（bg_task_*；按 id upsert，output 增量追加）──

  upsertBgTask(id: string, command: string, description: string, toolUseId: string): void {
    if (id === '') {
      return;
    }
    const exist: BgTask | undefined = this.lookupBgTask(id);
    if (exist !== undefined) {
      if (command !== '') {
        exist.command = command;
      }
      if (description !== '') {
        exist.description = description;
      }
      return;
    }
    const t: BgTask = new BgTask(id);
    t.command = command;
    t.description = description;
    t.toolUseId = toolUseId;
    t.startedAt = Date.now();
    this.bgTasks = this.bgTasks.concat([t]);
  }

  lookupBgTask(id: string): BgTask | undefined {
    for (let i = 0; i < this.bgTasks.length; i++) {
      if (this.bgTasks[i].id === id) {
        return this.bgTasks[i];
      }
    }
    return undefined;
  }

  endBgTask(id: string, status: string, summary: string): void {
    const t: BgTask | undefined = this.lookupBgTask(id);
    if (t === undefined) {
      return;
    }
    t.status = status;
    t.summary = summary;
    t.endedAt = Date.now();
  }

  /** 「全部完成」停留期满后的即焚入口（保留仍在跑的，防与新任务启动竞态）。 */
  clearEndedBgTasks(): void {
    this.bgTasks = this.bgTasks.filter((t: BgTask) => t.status === 'running');
  }

  /**
   * 快照对账（list_bg_tasks 回填，open / 重连 reload 后各一次）：只补 store
   * 里没有的 id——已在 store 的以直播事件为准（快照生成于 RPC 往返之间，可能
   * 更旧）。startedAt 缺失兜底当前时刻，防走表从 0 起跳成天文数字。
   */
  reconcileBgTasks(infos: BgTaskInfo[]): void {
    for (let i = 0; i < infos.length; i++) {
      const info: BgTaskInfo = infos[i];
      if (info.id === '' || this.lookupBgTask(info.id) !== undefined) {
        continue;
      }
      const t: BgTask = new BgTask(info.id);
      t.command = info.command;
      t.description = info.description;
      t.status = info.status === '' ? 'running' : info.status;
      t.summary = info.summary;
      t.startedAt = info.startedAt > 0 ? info.startedAt : Date.now();
      t.endedAt = info.endedAt;
      t.output = info.output;
      t.truncatedBytes = info.truncatedBytes;
      this.bgTasks = this.bgTasks.concat([t]);
    }
  }

  // ── 生命周期原语 ──

  /** 打开会话（路由进入）：整体复位（对照上游重开 = dispose 后 getStore 重建）。 */
  resetForOpen(sid: string, name: string): void {
    this.sid = sid;
    this.sessionName = name;
    this.replaceAllMessages([]);
    this.hydrated = false;
    this.hydrateFailed = false;
    this.isBusy = false;
    this.pendingPermissions = [];
    this.pendingJumps = [];
    this.sysNote = '';
    this.tailOffset = 0;
    this.cursorReady = false;
    this.loadingOlder = false;
    this.liveActivities = [];
    this.bgTasks = [];
    this.pendingSubagents.clear();
    this.pendingSpawn = false;
    this.pendingSpawnTitle = '';
    this.spawnWsKey = '';
    // 模型/effort 域随复位清空（切会话即切供应商上下文），open/newSession 随后重同步
    this.modelOptions = [];
    this.model = '';
    this.effort = '';
    this.modelPop = false;
    this.effortPop = false;
  }

  /** 收 chip 浮层（返回键/遮罩/输入框聚焦共用）：true = 有浮层被收起（消费返回键）。 */
  handlePopups(): boolean {
    const had: boolean = this.modelPop || this.effortPop;
    this.modelPop = false;
    this.effortPop = false;
    return had;
  }

  /**
   * 断线重连整页重载前复位（对照 reloadSessionMessages）：只清消息/游标/
   * hydrate 标记，不动 isBusy——会话仍在跑时，后续流式事件接在重载历史之后。
   */
  resetForReload(): void {
    this.replaceAllMessages([]);
    this.hydrated = false;
    this.hydrateFailed = false;
    this.tailOffset = 0;
    this.cursorReady = false;
    this.liveActivities = [];
    this.bgTasks = [];
  }

  // ── 消息列表结构原语（全部列表变形的唯一出口；变形必通知数据源对账）──
  // ⚠️ 不变式：store.messages 只允许整体替换（新数组引用），永不原地
  // push/splice——ChatMessagesSource 持有同一引用做身份对账，原地变更会
  // 让对账两边完全相等而静默吞掉通知。

  /** 尾部追加一条（流式 assistant / 用户气泡 / 系统提示 / jump flush）。 */
  appendMessage(m: ChatMessage): void {
    this.messages = this.messages.concat([m]);
    this.notifyMessagesStructureChanged();
  }

  /** 整体替换（复位清空 / hydrate / 上滚取回拼装）。 */
  replaceAllMessages(msgs: ChatMessage[]): void {
    this.messages = msgs;
    this.notifyMessagesStructureChanged();
  }

  /** 注册消息结构变更回调（页面 aboutToAppear 挂、aboutToDisappear 摘，配对防泄漏）。 */
  onMessagesStructureChanged(cb: () => void): void {
    this.messagesChangeCallbacks.push(cb);
  }

  offMessagesStructureChanged(cb: () => void): void {
    this.messagesChangeCallbacks = this.messagesChangeCallbacks.filter((c: () => void) => c !== cb);
  }

  private notifyMessagesStructureChanged(): void {
    for (let i = 0; i < this.messagesChangeCallbacks.length; i++) {
      this.messagesChangeCallbacks[i]();
    }
  }

  // ── 思考卡生命周期（流式段：续写合并 → 段收尾自动收起；配合 ThinkingCard）──

  /**
   * 思考增量入列：末位是思考卡则原地续写——V1 工具不入时间线，被工具打断的
   * 相邻思考段合并回同一张卡（推理线本就连续，对照历史映射的合并分支）；
   * 否则新起一张展开的流式卡。续写已收起的卡 = 工具结束后思考恢复：
   * 重新展开（sealed → active）。
   */
  appendThinkingDelta(msg: ChatMessage, chunk: string): void {
    const last: ContentBlock | undefined = msg.blocks[msg.blocks.length - 1];
    if (last instanceof ThinkingBlock) {
      if (!last.active) {
        last.active = true;
        last.collapsed = false;
      }
      last.text += chunk;
      return;
    }
    msg.blocks.push(ThinkingBlock.streaming(uuid(), chunk));
  }

  /**
   * 思考段收尾：末位思考卡自动收起（active → false；完成即折叠，可点开回看）。
   * 幂等：末位不是思考卡（正文/子代理已接棒或无块）不动。
   */
  sealThinking(msg: ChatMessage): void {
    const last: ContentBlock | undefined = msg.blocks[msg.blocks.length - 1];
    if (last instanceof ThinkingBlock) {
      last.active = false;
      last.collapsed = true;
    }
  }

  /** 尾部追加提示（ohos 专有：页面 @Monitor 据此滚到底）。 */
  bumpTail(): void {
    this.tailAt = Date.now();
  }

  /**
   * 流式内容增长跟尾提示（节流版）：delta 高频到达，逐 bump 会把页面
   * scrollEdge 打成逐帧动画；按 STREAM_FOLLOW_THROTTLE_MS 节奏放行。
   * 收尾（message_stop）有无条件 bumpTail 兜底，不丢最后一截。
   */
  bumpTailThrottled(): void {
    const now: number = Date.now();
    if (now - this.lastStreamBumpAt >= STREAM_FOLLOW_THROTTLE_MS) {
      this.lastStreamBumpAt = now;
      this.tailAt = now;
    }
  }

  /** 流式收尾：摘掉 streaming 标记 + 末位思考卡收尾收起（均幂等）。isBusy 由调用方置。 */
  finishStreaming(): void {
    const last: ChatMessage | undefined = this.messages[this.messages.length - 1];
    if (last !== undefined && last.streaming) {
      last.streaming = false;
      this.sealThinking(last);
    }
  }

  /** 取/建流式续写目标的 assistant 消息（新建即置 streaming）。 */
  getOrCreateAssistant(): ChatMessage {
    const last: ChatMessage | undefined = this.messages[this.messages.length - 1];
    if (last !== undefined && last.role === 'assistant') {
      return last;
    }
    const msg: ChatMessage = ChatMessage.assistantStreaming(uuid());
    this.appendMessage(msg);
    this.bumpTail();
    return msg;
  }

  /** sidecar 盖在块事件上的真实模型 → 消息徽标；一轮只有首个块事件带，已盖不覆盖。 */
  stampModel(msg: ChatMessage, p: Record<string, Object>): void {
    if (msg.modelLabel !== '') {
      return;
    }
    const m: string = str(p, 'model');
    if (m === '') {
      return;
    }
    const label: string = str(p, 'modelLabel');
    msg.modelLabel = label !== '' ? label : m;
  }

  /** 运行时状态复位（中断 / 会话死 / 错误兜底共用）——不碰 messages（历史保留）。 */
  resetRuntimeState(): void {
    this.finishStreaming();
    this.isBusy = false;
    this.pendingPermissions = [];
    this.pendingJumps = [];
    this.liveActivities = [];
  }
}

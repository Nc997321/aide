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
 *  - 模型/effort 域（syncModelEffort/pickModel/pickEffort）：下拉口径对照
 *    桌面判定表（docs/session-identity-alignment.md §5）——存活会话锁定会话
 *    自己的供应商（session_alive + session_provider），未存活/新会话随全局
 *    激活（系统默认 get_default_models，第三方配置推导）；当前值会话记忆优先、
 *    不在选项集内回落默认；存活会话切换 = set_model/set_effort 运行时 +
 *    set_session_meta 记忆双写（返回 false = 无活进程走 deferred）；空会话选择
 *    只入 store，随首条消息 initialModel/initialEffort 带出；存活会话跨
 *    供应商选型在 pickModel 拦截（'blocked'，不改 store.model）
 * 未过筛（随 UI 扩容）：evict 字节降级、页级回收 recycle、权限模式选择器、
 * btw 支线、nextMode（「进入自动模式/计划批准」UI
 * 定稿后接入）、「允许并记住」规则推导（sessionRules；deriveSessionFileRules
 * 在桌面 src/utils，ohos 同 PWA 不推导）。图片消息已接入（附件域见
 * ChatAttachments；协议无 attachments 字段，文本类文件按桌面 mention 标记
 * 内联进 prompt）。
 * 本类无可观察状态（全在 ChatStore），是纯服务持有者；页面经 chatModel.store
 * 观察（@ObservedV2 字段级追踪，store 实例终生不变）。
 */
import { AideEvent } from '../sdk/transport';
import { ConnModel, connModel } from '../conn/ConnModel';
import { api, MetaField } from '../sdk/api';
import { BgTaskInfo, ModelOption, ProviderConfigView, SendImage, SendDisplayBlock } from '../sdk/types';
import { ChatStore } from './chat/ChatStore';
import { ChatMessage, PendingJump, PermissionRequest } from './chat/ChatBlocks';
import { ChatAttachments, attachmentsModel } from './chat/ChatAttachments';
import { hydrate as hydrateStore, loadOlder as loadOlderStore } from './chat/ChatPagination';
import { routeChatEvent } from './chat/ChatEvents';
import { ttsModel } from './chat/TtsModel';
import { readerModel } from './chat/ReaderModel';
import { uuid } from './chat/ChatWire';
import { sessionsModel } from './SessionsModel';
import { workspaceModel } from './WorkspaceModel';
import { providerModel } from './ProviderModel';

/** 思考档位（对照原型 EF_FAKE；文案以 design/remote/app.html 为准——桌面
 * effort.ts 的 快速/进阶/极致 是桌面侧文案，ohos 端不沿用）。 */
export interface EffortTier {
  value: string;
  label: string;
  desc: string;
}

/** 三档制（选择器没有「无」档）：low 快速 / high 均衡 / max 极致。 */
export const EFFORT_TIERS: EffortTier[] = [
  { value: 'low', label: '快速', desc: '最快回答，适合简单问答' },
  { value: 'high', label: '均衡', desc: '默认 · 速度与质量兼顾' },
  { value: 'max', label: '极致', desc: '不计成本的最强档' }
];

/**
 * 任意档位值归一到三档（对照桌面 normalizeEffortOption）：medium→high、
 * xhigh→max（历史遗留档位，API 仍可能回 报）；非法/空 → high（默认即均衡）。
 */
export function normalizeEffort(v: string): string {
  const raw: string = v.trim().toLowerCase();
  if (raw === 'low' || raw === 'high' || raw === 'max') {
    return raw;
  }
  if (raw === 'medium') {
    return 'high';
  }
  if (raw === 'xhigh') {
    return 'max';
  }
  return 'high';
}

/** 档位值 → 展示名（store 内恒为归一后三档；未同步的空值回退「均衡」）。 */
export function effortLabel(v: string): string {
  for (let i = 0; i < EFFORT_TIERS.length; i++) {
    if (EFFORT_TIERS[i].value === v) {
      return EFFORT_TIERS[i].label;
    }
  }
  return '均衡';
}

/** 选项集内按 value 找展示名；找不到返回 null（chip 回退占位/默认文案）。 */
export function modelDisplayName(opts: ModelOption[], value: string): string | null {
  for (let i = 0; i < opts.length; i++) {
    if (opts[i].value === value) {
      return opts[i].displayName;
    }
  }
  return null;
}

/** 权限应答的可选载荷（对照上游 respondPermission 的 opts；可空项 null = 不携带）。 */
export interface RespondPermissionOpts {
  /** AskUserQuestion 作答（问题文本 → 答案；语义由 sidecar 解释重组）。 */
  answers: Record<string, string> | null;
  /** 「批准并执行」的目标模式（计划批准 = 'auto'，sidecar 收到后切模式）；null = 不切。 */
  nextMode: string | null;
  /** 拒绝理由（协议参数名 message；sidecar 交给 CLI 当 user feedback，由官方
   *  模板包装后反馈给模型）。 */
  reason: string | null;
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

  /** 打开会话（路由进入）：整体复位 + 立即 hydrate + 后台任务快照对账 + 模型域同步。 */
  open(sid: string, name: string): void {
    ttsModel.stop(); // 切走即停：不念旧会话（对照原型 pickSession）
    readerModel.stop(); // 听书同理：面板播放列表是旧会话快照，切走即收
    this.store.resetForOpen(sid, name);
    attachmentsModel.reset();
    void hydrateStore(this.store);
    void this.syncBgTasks();
    void this.syncModelEffort();
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
   * 新会话（空态）发送 = spawn：本地 uuid 作路由键 + resumeId 缺省由桌面现拉起
   * 进程（对照 PWA sendMessage 空白面板首发），workspaceRoot 取手机侧所选
   * 工作区；真实 id 由 session_init 回执过户（finalizeSpawn，见 ChatEvents）。
   * 附件（att 非空且有项）：发送瞬间同步快照 images/display/组合 prompt 后
   * 立即清条——排队路径载荷随 SendMessageArgs 透传 sidecar 暂存（jumpQueue
   * 重放不丢附件），气泡由 user_message display 回灌渲染，均不依赖输入区
   * 状态。空文本 + 有附件合法（附件-only 消息）；纯空发送拦截。
   */
  send(prompt: string, att: ChatAttachments | null): void {
    const text: string = prompt.trim();
    if (text === '' && (att === null || att.items.length === 0)) {
      return;
    }
    if (connModel.state !== 'authed') {
      return;
    }
    ttsModel.stop(); // 用户发新消息 = 不再念旧回复（排队路径同；对照原型 sendMsg）
    let images: SendImage[] | null = null;
    let display: SendDisplayBlock[] | null = null;
    let full: string = text;
    if (att !== null && att.items.length > 0) {
      images = att.buildImages();
      display = att.buildDisplay(text);
      full = att.composePrompt(text);
      att.reset();
    }
    let sid: string = this.store.sid;
    const spawn: boolean = sid === '';
    if (spawn) {
      sid = uuid();
      this.store.resetForOpen(sid, '新会话');
      this.store.pendingSpawn = true;
      this.store.spawnWsKey = workspaceModel.selectedKey;
      this.store.hydrated = true; // 新会话无历史可拉：跳过 hydrate，避免加载卡常驻
    }
    const wasBusy: boolean = this.store.isBusy;
    this.store.isBusy = true;
    this.store.sysNote = '';
    if (!spawn && wasBusy) {
      // 排队：只登记"待发出"提示条——气泡等 sidecar 真正接入这条消息时广播的
      // user_message 渲染。不 finishStreaming（当前 assistant 仍在流式，提前收尾
      // 会让工具结果/后续文本错位新建）。
      this.store.pendingJumps = this.store.pendingJumps
        .concat([new PendingJump(text !== '' ? text : '附件消息')]);
    }
    // 直发路径同样不落气泡：与桌面端同源，统一由 user_message 事件渲染。本地乐观
    // 渲染意味着只有发起方看得见自己提的问题——手机上发的在桌面端消失，反之亦然。
    this.dispatchSend(sid, full, images, display, wasBusy, spawn);
  }

  /** 真实发送（fire-and-forget；失败兜底复位——对照上游 sendQueued 的 catch）。 */
  private async dispatchSend(sid: string, text: string, images: SendImage[] | null,
    display: SendDisplayBlock[] | null, wasBusy: boolean, spawn: boolean): Promise<void> {
    try {
      await api.sendMessage({
        sessionId: sid,
        prompt: text,
        workspaceRoot: spawn ? workspaceModel.selectedRoot() : null,
        images: images,
        display: display,
        provider: null,
        resumeId: spawn ? null : sid,
        // spawn 才带 chip 选择（空 = 未选，由桌面按供应商默认解析）；存活会话
        // 的切换已由 pickModel 经 set_model/set_session_model 落定，不重复携带
        initialModel: spawn && this.store.model !== '' ? this.store.model : null,
        initialEffort: spawn && this.store.effort !== '' ? this.store.effort : null,
        permissionMode: null,
        jumpQueue: wasBusy
      });
    } catch (e) {
      if (this.store.sid !== sid) {
        return; // 会话已切走：reject 不回写新会话状态
      }
      this.store.isBusy = false;
      this.store.pendingJumps = [];
      if (spawn) {
        // spawn 失败：tempId 无落盘痕迹，原地作废退回空态
        this.store.resetForOpen('', '');
      }
      this.store.sysNote = `发送失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 新会话（抽屉「＋」）：回空态等待首条消息 spawn（对照原型 showEmpty）。 */
  newSession(): void {
    ttsModel.stop(); // 离开当前会话即停（对照原型 showEmpty）
    readerModel.stop(); // 听书同理：不读旧会话
    this.store.resetForOpen('', '新会话');
    attachmentsModel.reset();
    void this.syncModelEffort();
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
        ttsModel.stop(); // 停止会话即停播报（对照原型 stopSession）
        this.store.resetRuntimeState();
        if (this.store.messages.length > 0) {
          // 落系统分隔线（对照原型 m-sys）：残段已冻结，本轮被中断的时间线
          // 痕迹——纯内存不落盘，重载/切换即消
          this.store.appendMessage(ChatMessage.systemNote(uuid(), '已停止会话 · 本轮回复已中断'));
          this.store.bumpTail();
        }
        // 中断不产生 message_stop 事件：列表徽标（回复中/待确认）同步让位，
        // 已启动保留（进程仍存活）。事件面幂等，迟到事件重复到达无害
        sessionsModel.markRoundEnd(sid);
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

  /**
   * 权限应答（出队后 invoke，失败提示不回滚队列——sidecar 会重发）。
   * opts 语义对照上游 respondPermission：answers = AskUserQuestion 选项
   * 作答、reason = 拒绝理由、nextMode = 「批准并执行」的目标模式（计划
   * 批准 = 'auto'）；null = 不携带（Rust Option 缺键即 None）。
   * sessionRules 未过筛：规则草稿推导在桌面 src/utils，ohos 同 PWA「允许」= 仅本次放行。
   */
  async respondPermission(id: string, approved: boolean, opts: RespondPermissionOpts | null): Promise<void> {
    const sid: string = this.store.sid;
    this.store.pendingPermissions = this.store.pendingPermissions
      .filter((p: PermissionRequest) => p.id !== id);
    ttsModel.stopPermission(id); // 已应答：这条的播报（若在播）停
    // 本机已应答：列表「待确认」徽标同步终结（事件面幂等）
    sessionsModel.clearWaitConfirm(sid);
    try {
      await api.permissionResponse({
        sessionId: sid,
        id: id,
        approved: approved,
        answers: opts !== null ? opts.answers : null,
        nextMode: opts !== null ? opts.nextMode : null,
        message: opts !== null ? opts.reason : null,
        sessionRules: null
      });
    } catch (e) {
      if (this.store.sid === sid) {
        this.store.sysNote = `权限应答失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  // ── 模型 / 思考程度（输入区 chip 域；语义对齐见类头）──

  /**
   * 模型/effort 域同步（打开会话 / 新会话 / 切供应商后调用，幂等）：
   *  - **存活只查一次，供应商与模型共用同一口径**：未存活（新会话 / 历史会话 /
   *    查询失败）→ 两者都跟全局激活供应商及其默认模型；存活 → 两者都跟会话。
   *    此前模型无条件套用 session_model 记忆，于是点开一个已停掉的旧会话会出现
   *    「供应商 chip 是全局的、模型 chip 却是这条会话上次用的」口径打架。
   *  - 模型当前值：存活 → 会话记忆（session_model，不在选项集内回落默认——
   *    供应商已切换/模型下架的场景）；未存活 → 默认（选项集首位，store 记 ''）
   *  - effort 当前值：恒读会话记忆（session_effort）→ 供应商 effortLevel → 'high'。
   *    effort 不参与「冷缓存 / respawn」语义，没有跟随全局的必要，不受存活影响。
   *  - 空会话（未 spawn）跳过记忆读取——会话 id 尚不存在，选择随首条消息带出
   */
  async syncModelEffort(): Promise<void> {
    const sid: string = this.store.sid;
    let p: ProviderConfigView | null = providerModel.activeProvider();
    if (p === null) {
      await providerModel.refresh();
      p = providerModel.activeProvider();
    }
    if (p === null) {
      return; // 离线/拉取失败：chip 留占位，点击 chip 重试（onModelChipTap 兜底）
    }
    let alive: boolean = false;
    if (sid !== '') {
      try {
        alive = await api.sessionAlive(sid);
      } catch (e) {
        alive = false; // 查询失败（桌面离线等）：按未存活跟随全局
      }
      if (this.store.sid !== sid) {
        return; // 会话已切走：不回写新会话
      }
      if (alive) {
        // 存活会话锁 spawn 时的供应商：下拉口径换到会话供应商（拿不到回退全局）
        p = await this.aliveSessionProvider(sid, p);
        if (this.store.sid !== sid) {
          return; // 会话已切走：不回写新会话
        }
      }
    }
    try {
      const opts: ModelOption[] = await this.fetchModelOptions(p);
      if (this.store.sid !== sid) {
        return; // 会话已切走：不回写新会话
      }
      this.store.modelOptions = opts;
      let model: string = '';
      if (sid !== '' && alive) {
        try {
          const remembered: string | null = await api.sessionModel(sid);
          if (this.store.sid !== sid) {
            return;
          }
          if (remembered !== null && modelDisplayName(opts, remembered) !== null) {
            model = remembered;
          }
        } catch (e) {
          // 记忆读失败静默——回落默认
        }
      }
      this.store.model = model;
      let effort: string = '';
      if (sid !== '') {
        try {
          const remembered: string | null = await api.sessionEffort(sid);
          if (this.store.sid !== sid) {
            return;
          }
          if (remembered !== null) {
            effort = normalizeEffort(remembered);
          }
        } catch (e) {
          // 记忆读失败静默——回落供应商默认
        }
      }
      this.store.effort = effort !== '' ? effort : normalizeEffort(p.effortLevel);
    } catch (e) {
      // 选项集拉取失败静默——chip 留占位，点击重开浮层即重同步
    }
  }

  /**
   * 存活会话的下拉口径供应商：锁定 spawn 时的供应商（session_provider 元数据
   * → providerModel 查配置），元数据缺失/配置已删 → 全局激活兜底。
   *
   * 前置条件：调用方已确认会话存活——存活查询在 syncModelEffort 里只做一次，
   * 供应商与模型共用同一个结果。未存活会话不进这里，直接跟全局。
   */
  private async aliveSessionProvider(sid: string, fallback: ProviderConfigView): Promise<ProviderConfigView> {
    let spid: string | null = null;
    try {
      spid = await api.sessionProvider(sid);
    } catch (e) {
      return fallback;
    }
    if (spid === null) {
      return fallback; // 会话从没记过供应商
    }
    for (let i = 0; i < providerModel.providers.length; i++) {
      if (providerModel.providers[i].id === spid) {
        return providerModel.providers[i];
      }
    }
    return fallback; // 供应商配置已删除
  }

  /**
   * 供应商的模型选项集（对照桌面 providerModelList + 系统默认特例）：
   * 系统默认走 get_default_models（Rust 从 catalog 预设读，4 个 Anthropic 别名
   * opus/sonnet/haiku/fable；catalog 是单一真源，不再读 agent-sidecar/default-models.json），
   * 第三方从配置推导（model + modelMappings 五字段 + knownModels 去重；displayName = value）。
   */
  private async fetchModelOptions(p: ProviderConfigView): Promise<ModelOption[]> {
    if (p.kind === 'system_default') {
      return await api.getDefaultModels();
    }
    const seen: string[] = [];
    const push = (v: string): void => {
      const t: string = v.trim();
      if (t !== '' && !seen.includes(t)) {
        seen.push(t);
      }
    };
    push(p.model);
    push(p.modelMappings.anthropicModel);
    push(p.modelMappings.defaultOpusModel);
    push(p.modelMappings.defaultSonnetModel);
    push(p.modelMappings.defaultHaikuModel);
    push(p.modelMappings.subagent);
    for (let i = 0; i < p.knownModels.length; i++) {
      push(p.knownModels[i]);
    }
    const opts: ModelOption[] = [];
    for (let i = 0; i < seen.length; i++) {
      const o: ModelOption = { value: seen[i], displayName: seen[i] };
      opts.push(o);
    }
    return opts;
  }

  /** pickModel 返回 'blocked' 时的会话供应商展示名（toast 文案用；非观察态）。 */
  blockedProviderName: string = '';

  /**
   * 选择模型（浮层选项点击）。返回语义：
   *  - 'same'     未变（当前即所选）
   *  - 'spawn'    空会话：只入 store（无真实 id 可写元数据，随首条消息
   *               initialModel 带出）
   *  - 'blocked'  存活会话跨供应商选型被拦（不改 store.model，供应商名见
   *               blockedProviderName——set_model 把模型名直发当前进程，
   *               不属于会话供应商的模型必然 400）
   *  - 'live'     存活进程已切换（set_model true；终态以 model_switch_result 坐实）
   *  - 'deferred' 无活进程（set_model false）：记忆已写，下一条消息生效
   *  - 'error'    RPC 失败（回滚显示）
   */
  async pickModel(value: string): Promise<string> {
    const fallback: string = this.store.modelOptions.length > 0 ? this.store.modelOptions[0].value : '';
    if (value === this.store.model || (this.store.model === '' && value === fallback)) {
      return 'same';
    }
    const sid: string = this.store.sid;
    if (sid === '') {
      this.store.model = value;
      return 'spawn';
    }
    try {
      if (await api.sessionAlive(sid) && await this.isCrossProviderPick(sid, value)) {
        return 'blocked';
      }
    } catch (e) {
      // 存活查询失败按未存活放行——无从判定，由桌面端门控兜底
    }
    const prev: string = this.store.model;
    this.store.model = value; // 乐观更新（失败回滚）
    try {
      const live: boolean = await api.setModel(sid, value);
      await api.setSessionMeta(sid, { model: MetaField.set(value) }); // 记忆恒写（live/deferred 都记住选择）
      return live ? 'live' : 'deferred';
    } catch (e) {
      if (this.store.sid === sid) {
        this.store.model = prev;
      }
      return 'error';
    }
  }

  /**
   * 存活会话上 value 是否跨供应商：不属于会话供应商（session_provider 元
   * 数据）的模型列表 → true。元数据缺失/配置已删/列表拉取失败 → false
   * （无从对照，放行由桌面端门控兜底）。
   */
  private async isCrossProviderPick(sid: string, value: string): Promise<boolean> {
    let spid: string | null = null;
    try {
      spid = await api.sessionProvider(sid);
    } catch (e) {
      return false;
    }
    if (spid === null) {
      return false;
    }
    let p: ProviderConfigView | null = null;
    for (let i = 0; i < providerModel.providers.length; i++) {
      if (providerModel.providers[i].id === spid) {
        p = providerModel.providers[i];
        break;
      }
    }
    if (p === null) {
      return false; // 供应商配置已删除：无从推导模型列表
    }
    try {
      const opts: ModelOption[] = await this.fetchModelOptions(p);
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].value === value) {
          return false;
        }
      }
      this.blockedProviderName = p.name;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 选择思考档（语义同 pickModel；effort 三档制无「无」档，恒有当前值）。 */
  async pickEffort(raw: string): Promise<string> {
    const value: string = normalizeEffort(raw);
    if (value === this.store.effort) {
      return 'same';
    }
    const prev: string = this.store.effort;
    const sid: string = this.store.sid;
    this.store.effort = value;
    if (sid === '') {
      return 'spawn';
    }
    try {
      const live: boolean = await api.setEffort(sid, value);
      await api.setSessionMeta(sid, { effort: MetaField.set(value) });
      return live ? 'live' : 'deferred';
    } catch (e) {
      if (this.store.sid === sid) {
        this.store.effort = prev;
      }
      return 'error';
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

import { computed, ref, watch, type Ref } from "vue";
import { getTransport } from "../transport";
import { api } from "../api";
import { writeSessionMeta } from "./sessionIdentity";
import type {
  ActionBlock,
  ChatMessage,
  UserMessageBlock,
} from "../types/chat";
import type { PermissionRuleDraft } from "../types/permissions";
import { useSessionState } from "./useSessionState";
import {
  useSessionWorkspaces,
  ensureWorkspaceKnown,
  persistWorkspaceIfDirty,
  type SessionWorkspaceInfo,
} from "./useSessionWorkspaces";
import { useProviders } from "./useProviders";
import { useBtwSession } from "./useBtwSession";
import type { FileMentionResolution } from "../utils/fileMentions";
import { maybeEvict } from "./useChatSession/evict";
import { handleChatEvent } from "./useChatSession/events";
import { hydrate, hasMoreOlder, loadOlderPage, resetPaginationForRevert } from "./useChatSession/pagination";
import {
  disposeSession,
  disposedSids,
  finishStreaming,
  getLastDispatchedPrompt,
  getStore,
  identityStore,
  isFinalizedSessionPair,
  isPendingSession,
  lastDispatchedPrompt,
  pendingSids,
  pendingSubagents,
  pendingToolCalls,
  resetAllState,
  resolveSid,
  sessionCreatedCallbacks,
  sessionState,
  sharedModels,
  sharedPermissionModes,
  sharedRateLimit,
  stopSessionById,
  toggleBgDock,
  type SessionStore,
} from "./useChatSession/state";
import { __setEvictThresholdsForTest } from "./useChatSession/evict";

/**
 * 会话状态层宿主：对外 API 门面 + 发送链路 + 事件监听。
 * 模块组织（目录结构即架构层级）：
 *  - state.ts：per-sid store 与生命周期（finalize/dispose/stop）
 *  - evict.ts：P0-3 store 字节阈值降级
 *  - pagination.ts：P1 双向分页（字节游标 + 微博式页折叠释放/恢复）
 *  - events.ts：流式事件总路由（handleChatEvent）
 */

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

/** 一次发送的完整负载——sendMessage 直发与忙碌排队共用同一形状。 */
export interface SendOptions {
  images?: ImageAttachment[];
  resumeId?: string;
  initialModel?: string;
  /** 当前选中的 effort 档位（low/medium/high/xhigh/max 小写），随每条消息
   *  透传（与 initialModel 同语义：spawn 时是初始值，存活会话幂等）。 */
  initialEffort?: string;
  mentions?: FileMentionResolution;
  /** 当前选中的权限模式（不透明字符串，sidecar 解释语义），随每条消息透传 */
  permissionMode?: string;
  /** 工具栏快捷操作（压缩/清空上下文）：存在时用户气泡渲染成动作胶囊（见
   *  ActionBlock），而发给 sidecar 的 prompt 仍是 opts 对应的斜杠命令——显示
   *  与命令解耦。 */
  action?: { id: string; label: string; icon?: string };
  /** 新会话（空白面板首发）的工作区归属——空白 tab 创建时绑定快照或发送时的
   *  当前工作区，由 PaneGroup 注入；仅生成临时 sid 时消费（种进注册表），
   *  已有会话忽略（归属本来就在注册表里）。 */
  workspace?: SessionWorkspaceInfo;
  /** 本会话**已知的附加目录全量**（@目录 授权；不是"本条新增"）。与 `workspace`
   *  语义不同：workspace 是会话归属（1 个），这是本会话的附加授权（N 个，粘性）。
   *  全量语义是有意的：sidecar 侧并集合并幂等，重连/换端重报一遍就自愈。 */
  additionalDirs?: string[];
}

interface QueuedSend {
  prompt: string;
  images?: ImageAttachment[];
  mentions?: FileMentionResolution;
  permissionMode?: string;
  /** 发送时的模型（调用环境透传，invoke 时展开为 initialModel）。
   *  显式走数据流（输入区 → sendMessage opts → item → dispatchSend），不再由
   *  dispatchSend 反过来去读身份层的**视图**状态（那会读到别的面板的会话）。 */
  initialModel?: string | null;
  /** 发送时的 effort 档位（与 permissionMode 同级：调用环境透传，invoke 时展开
   *  为 initialEffort）。与 initialModel 同一条 env 通道（CLAUDE_CODE_EFFORT_LEVEL）。 */
  effort?: string;
  action?: { id: string; label: string; icon?: string };
  /** 本会话已知的附加目录全量（见 SendOptions.additionalDirs）。排队消息必须带上：
   *  插队/promote 走的是同一条 send 链路，不带就等于授权只对直发那条生效。 */
  additionalDirs?: string[];
}

let globalUnlisten: (() => void) | null = null;
/** 注册中/已注册的监听 promise——防重入必须存 promise 而不是存结果：
 *  多个 useChatSession 实例（App.vue + 各分屏组）同一 tick 并发调用时，
 *  只判 globalUnlisten 会在首个 await listen() 完成前全部穿过空检查，
 *  重复注册监听器 → 每条流式事件被处理多遍（消息内容成对重复事故）。 */
let listenerPromise: Promise<() => void> | null = null;

function ensureGlobalListener(): Promise<() => void> {
  if (!listenerPromise) {
    listenerPromise = getTransport().listen<Record<string, unknown>>("chat-event", (event) => {
      handleChatEvent(event.payload);
    }).then((unlisten) => {
      globalUnlisten = unlisten;
      return unlisten;
    });
  }
  return listenerPromise;
}

/** 本地状态就绪：暂存待发模型 / 清压缩提示 / isBusy / 提问标题 / 会话状态 /
 *  软超时。返回 "queued"（发送前已忙碌，气泡走排队暂存）或 "direct"（直发）。 */
function prepareSend(sid: string, item: QueuedSend): "queued" | "direct" {
  const store = getStore(sid);
  const wasBusy = store.isBusy;
  // 模型落盘已移到发送前（ChatPanel.onSendRequest 调 L2 settleOnSend），prepareSend 不再暂存。
  // 新轮次不能继承前一轮的压缩提示；但忙碌时这里仅登记排队消息，当前轮
  // 仍在压缩，不能提前撤掉它的状态条。真正接入下一轮时由 jump_promoted 清理。
  if (!wasBusy) store.contextCompaction = null;
  store.isBusy = true;
  // 记下本次派发的用户提问，供变更面板给轮次做标题（图片消息无文本时兜底占位）。
  // 动作胶囊用 label 做标题更可读，底层 prompt 是 /compact 这种斜杠命令。
  lastDispatchedPrompt[sid] =
    item.action?.label || item.prompt || (item.images?.length ? "[图片]" : "");
  const { setSessionState, setSessionHealth } = useSessionState();
  setSessionState(sid, "running");
  // 新一轮开始：清掉上轮可能残留的 warning（红点）。
  setSessionHealth(sid, "ok");
  return wasBusy ? "queued" : "direct";
}

/**
 * 构造用户气泡的**渲染描述**——随 send 命令下发给 sidecar，由它随 `user_message`
 * 事件原样回灌给所有客户端。**发送方自己不画气泡**（方案 C：单一渲染来源）。
 *
 * 为什么不本地渲染：本地渲染意味着只有发起方能看见自己提的问题——手机上发的
 * 消息在桌面端永远不显示，反之亦然。sidecar 是唯一同时看得见「命令」和「事件」
 * 的地方，由它广播才能让所有端一致，也因此不存在重复渲染、不需要 id 去重。
 *
 * 拆块的理由：@path 引用展开出来的文件内容不混进用户气泡的文本，而是独立的
 * mention 块（桌面端渲染成类 Read 工具的折叠卡片），避免用户自己打的字和引用
 * 内容糊在一起。发给模型的内容仍是完整的 mentions.sendText，只是显示时拆开。
 */
function buildUserDisplay(item: QueuedSend): UserMessageBlock[] {
  return item.action
    ? [
        {
          type: "action",
          actionId: item.action.id,
          label: item.action.label,
          ...(item.action.icon ? { icon: item.action.icon } : {}),
        },
      ]
    : [
        ...(item.images ?? []).map((img) => ({
          type: "image" as const,
          data: img.data,
          mediaType: img.mediaType,
        })),
        ...(item.prompt ? [{ type: "text" as const, text: item.prompt }] : []),
        ...(item.mentions?.resolved ?? []).map((m) => ({
          type: "mention" as const,
          path: m.path,
          content: m.content,
          ...(m.range ? { range: m.range } : {}),
          // 目录引用要把种类带出去，否则接收端只画得出"合成 Read 卡"（见 E 段）
          ...(m.isDir ? { isDir: true } : {}),
        })),
      ];
}

/**
 * 真实发送：invoke("send_message") 不 await 到底——新会话要等 Rust 侧现拉起
 * Node 子进程，等它返回会让首条消息在 UI 上有明显卡顿。这里只做本地状态
 * 就绪，IPC 后台完成，失败走 .catch 兜底（fire-and-forget，无需调用方等待）。
 */
function sendQueued(
  sid: string,
  item: QueuedSend,
  display: UserMessageBlock[],
  opts: { resumeId?: string; jumpQueue?: boolean },
) {
  // 会话已收口：不再向已销毁会话发 send_message（会复活 sidecar 进程）
  if (disposedSids.has(sid)) return;
  // initialModel 由调用方经 item 显式传入（输入区的当前选择）；没传（自动化 /
  // 快捷动作等无 UI 选择来源的调用）时回落到**会话自己的**身份，不再读视图态——
  // 此前读 identity.effectiveModel 会读到别的面板正在看的那条会话的模型。
  const initialModel = item.initialModel || (sid ? identityStore.effectiveModelOf(sid) : "") || null;
  // 混合 tab：会话可能归属别的工作区，sidecar 必须在它自己的项目目录里跑。
  // 注册表没有记录（新会话）时传 null，Rust 侧回落当前活动工作区。
  const sessionWs = useSessionWorkspaces().workspaceOf(sid);
  const sendText = item.mentions?.sendText ?? item.prompt;
  api.sendMessage({
    sessionId: sid,
    prompt: sendText,
    workspaceRoot: sessionWs?.wsPath || null,
    images: item.images?.length ? item.images : null,
    // 渲染描述：sidecar 不解释、原样随 user_message 回灌（见 buildUserDisplay）。
    display,
    // 会话自持的 provider 身份（L2 身份层 resolve/settleOnSend 解析出的绑定）——
    // 传给 Rust 让 runtime env 按它构造，不再只认全局 active。无绑定（新会话
    // 还没解析完）传 null，Rust 回落会话元数据 → 全局 active。
    provider: identityStore.providerOf(sid) || null,
    resumeId: opts.resumeId ?? null,
    // 只在这个 sidecar 进程还没起来时（第一条消息）有意义，Rust 侧只在
    // spawn 分支用它覆盖 provider 默认模型；之后切模型走 setModel()。
    initialModel,
    // effort 选择器当前值（与 initialModel 同一条 env 通道：CLAUDE_CODE_EFFORT_LEVEL）。
    // 存活会话同值幂等；切换走 setEffort() 即时生效，这里是 deferred 兜底。
    initialEffort: item.effort || null,
    // 每条消息都带当前选中的权限模式，sidecar 侧幂等（同值跳过）
    permissionMode: item.permissionMode || null,
    // 排队：不在这里打断，原样透传给 sidecar，由它在安全边界（当前工具调用
    // 跑完）自己决定何时真正 interrupt——见 jumpQueue 分支的调用处。
    jumpQueue: opts.jumpQueue || null,
    // 附加目录授权（D9：客户端已知全量）。Rust 裁定合法性 → sidecar 并集落账。
    additionalDirs: item.additionalDirs?.length ? item.additionalDirs : null,
  }).catch((e) => {
    console.warn("send_message failed:", e);
    const rsid = resolveSid(sid);
    // 会话在 send_message 在途时被关闭：reject 不重建 store、不回写状态
    if (disposedSids.has(rsid)) return;
    const s = getStore(rsid);
    s.isBusy = false;
    s.pendingJumps.length = 0;
    const { setSessionState } = useSessionState();
    setSessionState(rsid, "stopped");
  });
}

/**
 * 发送前的归属对账（cwd 的唯一来源就是注册表，所以这里是对账时机）：
 *  - 未知 → 先读档案补种，**必须 await**：这条消息的 `workspaceRoot` 就取它，
 *    不等就等于带着 null 出门、由 Rust 回落当前活动工作区（串档事故）；
 *  - 真实 id → 顺手把归属落盘对账（fire-and-forget，失败只留痕）；
 *  - 临时号 → 两件都不做：盘上不可能有它，也不许写（孤儿档案会让定名后的正式
 *    档案被误判「已落盘」而跳过写入）。
 */
async function ensureSendWorkspace(sid: string): Promise<void> {
  if (isPendingSession(sid)) return;
  if (!useSessionWorkspaces().workspaceOf(sid)) await ensureWorkspaceKnown(sid);
  void persistWorkspaceIfDirty(sid);
}

// ── useChatSession（App.vue 顶层单例 + 各分屏组各调一次）─────────────────────

export function useChatSession(sessionId: Ref<string | null>) {
  void ensureGlobalListener();

  // disposed 会话不重建 store：卸载期组件读 computed 也会经 getStore 复活僵尸 store，
  // 事件拦截覆盖不到这条同步路径，必须在此守卫
  const current = computed(() =>
    sessionId.value && !disposedSids.has(sessionId.value) ? getStore(sessionId.value) : null,
  );

  watch(
    sessionId,
    (sid) => {
      if (!sid) return;
      void hydrate(sid);
      // 打开/切到这条会话 = 归属对账时机：注册表可能因关 tab / 重载而空
      // （disposeSession 会显式删条目），此时从档案补种，别让 tab 后缀 /
      // 相对路径基准 / 下一条消息的 cwd 落到"当前活动工作区"上。
      // 临时号挡掉：盘上不可能有它。
      if (!pendingSids.has(sid)) void ensureWorkspaceKnown(sid);
    },
    { immediate: true },
  );

  /**
   * 发消息。若当前没有 session id（"新建会话"打开的空白面板），现场生成一个
   * 纯内存临时 key 并返回给调用方——App.vue 用它更新 activeSessionId。真正的
   * "创建会话"（写元数据 / 加侧栏 / 记最近访问）推迟到 SDK 用 session_init 确认
   * 真实 id 之后才发生，见 finalizeSession。
   *
   * 会话忙碌（上一轮还在生成）时一律走排队：带 jumpQueue 标记透传给 sidecar，
   * 由它在安全边界（当前工具调用跑完，没有工具在跑就是立刻）interrupt 当前轮
   * 再发出——不在前端 interrupt_session，那会腰斩还没跑完的工具调用。等待安全
   * 边界期间 sidecar 会发 jump_queued，输入区上方显示"待发出"提示条。
   */
  async function sendMessage(prompt: string, opts: SendOptions = {}): Promise<string | undefined> {
    let sid = sessionId.value;
    if (!sid) {
      sid = crypto.randomUUID();
      pendingSids.add(sid);
      // 空白面板首发：把工作区归属（创建时绑定快照，或发送时当前工作区）当场
      // 种进注册表——dispatchSend 的 workspaceRoot、finalize 后的落盘归属都读它，
      // 不再受「发出后用户切了工作区」影响。
      if (opts.workspace) useSessionWorkspaces().setWorkspace(sid, opts.workspace);
      // 新会话：spawn 将用的 provider 当场坐实到 tempId（定名后由 finalizeSpawn
      // 迁到 realId 并落盘）。此前靠 ChatPanel 的 settleOnSend("") 推进一个全局单值
      // 基线——既会跨会话串（别的面板一切就改基线），又落不了盘。
      // 只记内存、不落盘：此刻 id 还是临时号，写盘只会留下没人读的孤儿元数据，
      // 且会让 finalizeSpawn 误判「已落盘」而跳过正式 id 的写入——正式档案是定名时
      // 新建的空卡，内存里那份快照对它不成立。
      identityStore.prepareSpawn(sid, identityStore.spawnProviderOf(sid));
    }
    await ensureGlobalListener();
    // 等待监听器期间会话可能被关闭：不重建 store、不继续发送
    if (disposedSids.has(sid)) return sid;

    const store = getStore(sid);
    // 上下文兜底：无凭证（SystemDefault apiKey 未配 且 ~/.aide/claude/.credentials.json 不存在）
    // 拦截发送，原地把"还没登录 Claude"提示落到聊天区 + 触发 authRequiredHandler（App 打开 onboarding 登录步）。
    // 不再让首条消息裸奔成 SDK 401。
    // canSendOrPrompt 往返期间会话可能被关闭：同上守卫
    if (disposedSids.has(sid)) return sid;
    if (!(await canSendOrPrompt())) {
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: "还没登录 Claude——发消息需要凭证。请在打开的引导里配置 API key 或登录账号。" }],
        timestamp: Date.now(),
      });
      maybeEvict(sid, store);
      authRequiredHandler?.();
      return sid;
    }
    const item: QueuedSend = {
      prompt,
      images: opts.images,
      initialModel: opts.initialModel ?? null,
      mentions: opts.mentions,
      permissionMode: opts.permissionMode,
      effort: opts.initialEffort,
      action: opts.action,
      additionalDirs: opts.additionalDirs,
    };

    // resume：显式传入 > 已被 SDK 确认的 id 本身（aide id 就是 sdk id，无需查表）
    const resolvedResumeId = opts.resumeId ?? (isPendingSession(sid) ? undefined : sid);

    // provider 绑定由 ChatPanel.onSendRequest 的 settleOnSend 在 emit send 前确保
    // （setProvider + 落盘），到这里 providerOf(sid) 已就绪。不再在此 stampProvider。
    const status = sessionState[sid];

    // 归属对账：cwd 取自注册表，未知时在这里补读档案（见 ensureSendWorkspace）
    await ensureSendWorkspace(sid);

    // 派发三阶段（各自 ≤4 输入，调用点全具名）：prepareSend 本地状态就绪并判定
    // 忙碌（忙碌 → "queued" 排队，直发 → "direct"）；renderSendBubble 渲染气泡；
    // sendQueued 真实发送（fire-and-forget，内部 catch 兜底）。
    const queued = prepareSend(sid, item);
    // 排队：输入区上方立刻显示"待发出"提示条——不等 sidecar 的 jump_queued 回传
    // （有 RTT，手机端尤其明显）。气泡本身不在这里画：sidecar 真正接入这条消息
    // 时会广播 user_message，由 events.ts 统一渲染。
    if (queued === "queued") {
      store.pendingJumps.push({ text: lastDispatchedPrompt[sid] });
    }
    sendQueued(sid, item, buildUserDisplay(item), {
      resumeId: resolvedResumeId,
      jumpQueue: queued === "queued",
    });
    return sid;
  }

  /** answers：仅 AskUserQuestion 场景（问题文本 → 选中答案的不透明映射），
   *  由 PermissionDialog.vue 收集，这里只透传，语义由 sidecar 解释。
   *  reason：拒绝理由（仅 approved=false 时用户输入），Rust 参数名 message
   *  （serde 自动 camelCase 映射），sidecar 交给 CLI 当 user feedback（由官方
   *  模板包装后反馈给模型，不是工具结果正文）。
   *  sessionRules：会话级规则草稿（「允许」文件工具时前端推导，如「本会话内
   *  同文件不再询问」），随放行透传到 sidecar 入库，worker 销毁即消失。 */
  async function respondPermission(
    id: string,
    approved: boolean,
    opts: {
      answers?: Record<string, string>;
      nextMode?: string;
      reason?: string;
      sessionRules?: PermissionRuleDraft[];
    } = {},
  ) {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    store.pendingPermissions = store.pendingPermissions.filter((p) => p.id !== id);
    // 并发权限请求逐条确认：队列还有剩余时保持 attention（弹窗随队头自动切到
    // 下一条），全部清空才回到 running。
    const { setSessionState } = useSessionState();
    if (store.pendingPermissions.length === 0) {
      setSessionState(sid, "running"); // 权限批准后恢复生成（running 恒绿）
    }
    await api.permissionResponse({
      sessionId: sid,
      id,
      approved,
      answers: opts.answers,
      nextMode: opts.nextMode,
      message: opts.reason,
      sessionRules: opts.sessionRules,
    });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await api.interruptSession(sid);
    } finally {
      store.isBusy = false;
      store.contextCompaction = null;
      store.pendingPermissions = [];
      store.pendingJumps.length = 0; // 用户主动打断：待排队消息一并作废（sidecar 同）
      finishStreaming(store);
      const { setSessionState } = useSessionState();
      setSessionState(sid, "waiting"); // sidecar 仍存活
    }
  }

  /** 注册会话落地回调（tempId → realId）。返回解绑函数——组件卸载时必须调用，
   *  否则回调漏进模块级 Set（PWA 每次进 ChatView 都注册一次的场景会泄漏）。 */
  function onSessionCreated(cb: (tempId: string, realId: string) => void): () => void {
    sessionCreatedCallbacks.add(cb);
    return () => sessionCreatedCallbacks.delete(cb);
  }

  /** 切换模型只影响下一条消息，SDK 原生保证；不做本地乐观更新，
   *  显示状态靠 sidecar 主动回发的 models_available 事件同步。回执提示两条路：
   *  进程活着 → sidecar 运行时坐实后发 model_switch_result；进程没起 →
   *  Rust 返回 false，这里本地合成 deferred 回执（选择随下一条消息的
   *  initialModel 生效）——两条路都给用户可见反馈，不允许静默。
   *
   *  ⚠️ 不在此处持久化（set_session_model）：切换是「草稿」，落盘由**进程坐实事件**
   *  驱动（model_committed → commitModelFromRuntime，盘上身份=进程现实；首发前选定
   *  场景由 models_available 对账补位——统见 2026-09-01-model-switch-truth-design.md）。
   *  旧「落盘改到发送时」的 settleOnSend 模型落盘已废除：setModel 被驳回时发送前落盘
   *  会把错模型写进盘。 */
  async function setModel(model: string) {
    const sid = sessionId.value;
    if (!sid) return;
    let delivered = false;
    try {
      delivered = await api.setModel(sid, model);
    } catch {
      // has_session 到 send 之间进程刚好死掉：视同 deferred，下一条消息 respawn
      // 时 initialModel 照样带上，提示语义不变
    }
    if (!delivered) {
      const store = getStore(sid);
      store.modelSwitchResult = {
        ok: true,
        model,
        display: store.models.find((m) => m.value === model)?.displayName ?? model,
        deferred: true,
        seq: (store.modelSwitchResult?.seq ?? 0) + 1,
        at: Date.now(),
      };
    }
  }

  /** 模型切换被用户取消后的本地回滚：把下拉草稿拉回当前坐实模型。draft 优先级
   *  高于 runtime 坐实，回滚广播只改 runtime——不清 draft，deny 后下拉仍卡在新
   *  模型上。由确认对话框的取消分支调用。 */
  function rollbackModelChoice(): void {
    const sid = sessionId.value;
    if (!sid) return;
    identityStore.setUserChoice(sid, current.value?.currentModel ?? "");
  }

  /** 切权限模式：进程活着就即时生效（sidecar 回发事件同步下拉），进程还没
   *  起来时静默失败——模式会随下一条消息的 permission_mode 字段带过去。 */
  async function setPermissionMode(mode: string) {
    const sid = sessionId.value;
    if (!sid) return;
    try {
      await api.setPermissionMode(sid, mode);
    } catch {
      // 无活进程：等 send 携带
    }
  }

  /** 切 effort：存活会话立即走 sidecar applyFlagSettings（SDK 官方中途切换通道，
   *  不重启进程、实测不碰 prompt 缓存），坐实/回滚由 effort_changed 事件同步；
   *  进程没起时静默——选择随下一条消息的 env 通道带上（与 initialModel 同语义）。
   *  用户显式选择立即持久化（重开会话恢复选择器）。 */
  async function setEffort(effort: string) {
    const sid = sessionId.value;
    if (!sid) return;
    if (!isPendingSession(sid)) {
      void writeSessionMeta(sid, { effort: { op: "set", value: effort } }).catch((e) => {
        // effort 持久化失败：重开会话恢复不到该档位（回落上次持久化的值）——
        // 降级提示，本次运行的生效通道（applyFlagSettings）不受影响。
        console.warn("[chat] persist effort failed:", sid, effort, e);
      });
    }
    try {
      await api.setEffort(sid, effort);
    } catch {
      // 无活进程：等 send 携带
    }
  }

  /** 顺便问一下:对当前存活主会话做一次侧问（官方 side_question 通道，进程内完成）。
   *  一次性——发送后由 ChatPanel 负责复位 btw 模式视觉。结论以
   *  ActionBlock(actionId:'btw')回插本会话 store 末尾(前端可见、不进 SDK resume
   *  上下文,见 ChatMessage 渲染)。
   *
   *  不接模型/档位参数：官方通道只收 question/history，跑的是主会话同一 query 的
   *  cache-safe fork（同模型同档位才吃得到缓存），支线一律继承主会话。 */
  async function sendBtw(prompt: string) {
    const sid = sessionId.value;
    if (!sid) {
      // 无主会话可问:ChatPanel 已在 !sessionId 时禁用 btw 切换项,正常走不到这里。
      // 兜底(在已启动会话切了 btw 模式后,又切到空白 tab 发送):静默 no-op——
      // 不弹误导性 toast(乐观 toast 已移除),也不拉单例抽屉污染其它窗口。
      console.warn("sendBtw 需要一个存活的主会话作为侧问对象");
      return;
    }
    const store = getStore(sid);
    const btw = useBtwSession();
    btw.setOnDone((block) => {
      // 结论回插主对话:作为一条只含 ActionBlock 的用户消息(与 /compact /clear 同形),
      // ChatMessage 检测 actionId==='btw' 渲染为页边批注。
      store.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        blocks: [block],
        timestamp: Date.now(),
      });
      maybeEvict(sid, store);
    });
    // startBtw 内部把命令失败(Runtime 不可用)转成 store.status="error",由抽屉展示
    // 原因;答案与错误都走 btw_answer 事件——不抛、不静默。
    await btw.startBtw({ ownerSid: sid, question: prompt });
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    /** 弹窗只显示队头一条；确认后队列前移，下一条自动顶上。 */
    pendingPermission: computed(() => current.value?.pendingPermissions[0] ?? null),
    /** 挂起的权限请求总数（含队头）——弹窗用它提示"后面还排着 N 条"。 */
    pendingPermissionCount: computed(() => current.value?.pendingPermissions.length ?? 0),
    // 这个会话自己学到的列表优先；还没连上真实 SDK 时借用别的会话学到的缓存。
    models: computed(() => {
      const own = current.value?.models;
      return own?.length ? own : sharedModels.value;
    }),
    currentModel: computed(() => current.value?.currentModel ?? ""),
    /** 模型切换坐实回执（含 seq），面板据此弹成功/失败提示；null 表示没切过。 */
    modelSwitchResult: computed(() => current.value?.modelSwitchResult ?? null),
    /** 模型切换成本确认（PreModelSwitch hook 挂起）：非 null 即弹确认框；可写——
     *  决定回传后由弹窗置回 null 关闭（决定已发出，等待属超时兜底不再展示）。 */
    modelSwitchConfirm: computed({
      get: () => current.value?.modelSwitchConfirm ?? null,
      set: (v) => {
        const s = current.value;
        if (s) s.modelSwitchConfirm = v;
      },
    }),
    /** sidecar 坐实的当前 effort（空串 = 还没学到，选择器以本地值为准）。 */
    currentEffort: computed(() => current.value?.currentEffort ?? ""),
    /** effort 切换失败回执（含 seq），面板据此弹失败提示。 */
    effortSwitchError: computed(() => current.value?.effortSwitchError ?? null),
    contextUsage: computed(() => current.value?.contextUsage ?? null),
    /** 只驱动会话尾部的压缩状态条，不属于消息历史。 */
    contextCompaction: computed(() => current.value?.contextCompaction ?? null),
    tasks: computed(() => current.value?.tasks ?? []),
    permissionModes: computed(() => {
      const own = current.value?.permissionModes;
      return own?.length ? own : sharedPermissionModes.value;
    }),
    currentPermissionMode: computed(() => current.value?.currentPermissionMode ?? ""),
    /** null 表示本会话还没收到过 SDK 权威清单——不做跨会话共享兜底
     *  （跟 models/permissionModes 不同：这里的兜底走 ChatPanel 里的
     *  useSlashCommands 本地扫描，而不是借用别的会话学到的列表）。 */
    slashCommands: computed(() => current.value?.slashCommands ?? null),
    /** 账号级订阅额度/速率——跨会话共享，null 时 UI 隐藏。 */
    rateLimit: computed(() => sharedRateLimit.value),
    pendingJumps: computed(() => current.value?.pendingJumps ?? []),
    bgTasks: computed(() => current.value?.bgTasks ?? []),
    bgDockOpen: computed(() => current.value?.bgDockOpen ?? false),
    bgDockSelectedId: computed({
      get: () => current.value?.bgDockSelectedId ?? null,
      set: (v) => {
        const s = current.value;
        if (s) s.bgDockSelectedId = v;
      },
    }),
    sendMessage,
    sendBtw,
    respondPermission,
    interrupt,
    onSessionCreated,
    setModel,
    rollbackModelChoice,
    setEffort,
    setPermissionMode,
    /** 图片 400 回滚后待放回输入框的文本（空串 = 无待回填）。 */
    rollbackText: computed(() => current.value?.rollbackText ?? ""),
    /** ChatPanel 把 rollbackText 回填进输入框后调用，清空待回填标记。 */
    consumeRollbackText: () => {
      const s = current.value;
      if (s) s.rollbackText = "";
    },
    // ── P1 双向分页（最简单形态：上滚取更早页，不回收）──
    /** 取回更早一页 unshift，返回实际条数（0 = 无更早页）。 */
    loadOlderMessages: loadOlderPage,
    /** 磁盘上还有更早页（tailOffset > 0）。 */
    hasMoreOlder,
  };
}

// ── 上下文兜底：无凭证发消息拦截 ──
// useChatSession 不直接 import useOnboarding——那会拉 useSettings 的 watch(document, immediate)，
// 破坏 node-env 的 listener 测试。App.vue 通过 setAuthRequiredHandler 注册回调，无凭证时
// sendMessage 拦截 + 调 handler → App 打开 onboarding 登录步。解耦 + 可测。
let authRequiredHandler: (() => void) | null = null;
export function setAuthRequiredHandler(cb: (() => void) | null): void {
  authRequiredHandler = cb;
}

/** 是否有凭证可发消息。
 *  - 当前激活供应商非 SystemDefault（ollama/cpa_gpt/custom 等）→ 放行。它们在设置里配
 *    baseUrl+token，缺配置时由 runtime 报真实错误，不走 Claude 登录门、不冒充"登录 Claude"。
 *  - SystemDefault（Anthropic 直连）：apiKey 已配 或 ~/.aide/claude/.credentials.json 存在 才放行。
 *  只在「明确无凭证」时拦截（apiKeyConfigured=false 且 credentialsExist===false）；检测不确定
 *  （命令失败 / 测试 invoke 返回 undefined）时放行，避免误拦真实可用场景。 */
export async function canSendOrPrompt(): Promise<boolean> {
  const { systemDefault, activeProviderId, SYSTEM_DEFAULT_ID } = useProviders();
  if (activeProviderId.value !== SYSTEM_DEFAULT_ID) return true;
  if (systemDefault.value.apiKeyConfigured) return true;
  try {
    const exist = await api.claudeCredentialsExist();
    if (exist === false) return false; // 明确无凭证 → 拦截
    return true; // exist === true 或 undefined（命令失败/测试）→ 放行，避免误拦
  } catch {
    return true; // 检测失败不拦截——留给后续真实错误暴露
  }
}

// ── 对外 re-export（子模块门面：外部只从宿主 import，目录结构即架构层级）──
export { toggleBgDock, stopSessionById, disposeSession, getLastDispatchedPrompt, isPendingSession, isFinalizedSessionPair };
export { __setEvictThresholdsForTest };
export { loadOlderPage, hasMoreOlder, resetPaginationForRevert };
export { messagesOf } from "./useChatSession/state";
export { liveMessageCount } from "./useChatSession/recycle";

/** 远程重连后整页重载：清消息 + 分页状态后重新 hydrate。
 *  桌面靠 Tauri 事件不断流从不需要；远端断线期间有事件缺口，重连后以此对齐。
 *  只清消息/游标，不动 isBusy——若会话仍在跑，后续流式事件会接在重载的历史之后。 */
export async function reloadSessionMessages(sid: string): Promise<void> {
  const store = getStore(sid);
  store.messages.length = 0;
  store.hydrated = false;
  resetPaginationForRevert(sid);
  await hydrate(sid);
}

/** 测试钩子：重置全部模块级状态（含全局监听器——listenerPromise 在宿主模块级）。 */
export function __resetForTest(): void {
  resetAllState();
  globalUnlisten?.();
  globalUnlisten = null;
  listenerPromise = null;
}

/** 测试钩子：某会话还有未回填的 pending 块。 */
export function __pendingEmptyForTest(sid: string): boolean {
  const tc = pendingToolCalls.get(sid);
  const sa = pendingSubagents.get(sid);
  return (!tc || tc.size === 0) && (!sa || sa.size === 0);
}

export type { SessionStore } from "./useChatSession/state";
export type { PendingJump } from "./useChatSession/state";

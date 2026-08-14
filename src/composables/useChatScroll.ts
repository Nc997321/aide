import { computed, getCurrentInstance, getCurrentScope, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch } from "vue";
import type { ComputedRef } from "vue";
import { useMessageWindow } from "./useMessageWindow";
import { trail } from "../utils/diagnostics/scrollTrail";
import type { ChatMessage, TextBlock } from "@/types/chat";

/**
 * 从 target 向上找第一个用户手势可滚的祖先（overflow-y: auto|scroll）。
 * 用于 wheel 接管判断：若最近可滚祖先就是对话滚动容器本身，说明滚轮该滚
 * 对话区、光标下没有需要原生滚动的嵌套块——此时接管（见 useChatScroll 的
 * onWheel），让滚轮走 JS 赋值路径（实时布局），旁路掉合成器滚轮缓存的焊死
 * 病根（见 [[nested-scroller-wheel-trap]]）。返回 null = 一路到顶无可滚祖先。
 */
export function nearestScrollableAncestor(target: EventTarget | null): Element | null {
  let el = target as Element | null;
  for (let hop = 0; el && hop < 12; hop++) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}

/**
 * 聊天滚动区的主控：把 ChatPanel 里散落的滚动/窗口逻辑收拢成一层，并在
 * useMessageWindow 的"数据窗口"之上叠一层"渲染预算"做分帧挂载。
 *
 * 为什么要有这一层（根因见 warm-sniffing-balloon.md）：切会话时 v-for 的 key 整批
 * 换新，旧 15 条全卸载 + 新 15 条在**同一个同步渲染补丁**里挂完——每条同步跑缓存
 * 未命中的 marked.parse+hljs，加上 Edit/Write/NotebookEdit 默认展开的 CodeMirror
 * DiffViewer，长任务占满主线程，输入框彗星流光（每帧主线程重绘）掉帧几秒。
 * useMessageWindow 已把 v-for 限在尾部 15 条（不是全量挂载），残留问题就是
 * "15 条挤在一个 patch"。
 *
 * 分帧挂载：切会话先只挂尾部 ~6 条（首屏可见的最新消息，含流式那条），每帧
 * requestAnimationFrame 加几条长到 15，帧间让出主线程给流光绘制。窗口是尾部的，
 * 可见底不动、旧消息在上方填入——与原 expandOlderAnchored 锚定一致。显示最终
 * 仍 15 条可见，~50ms 内补齐，用户基本无感。
 *
 * 两层分离：
 *  - useMessageWindow 的"窗口"（initialSize=15，可向上扩）= 数据边界，原样复用、
 *    既有单测零改动；它照旧在 key 变时把 window 重置回 15（正是我们要的稳态窗口）。
 *  - 本层的 mountedCount（6→15 ramp）= 实际挂载数（渲染预算）。visibleMessages
 *    = 窗口尾部切片的尾部 mountedCount 条，随 ramp 逐帧增长。
 *
 * hydrate 时序：未加载的会话 messages 为空，切过去时窗口虽是 30 但实际 0 条——
 * 此时不能 ramp（target=0 会立刻停且把渲染预算卡住），改为 rampPending 等
 * messages 到齐（store.messages.unshift 那一下 0→N）再 startRamp；length watcher
 * 是 pre-flush，在那一帧渲染补丁前就把 mountedCount 重置回 6，避免 hydrate 完成
 * 时一次性挂 30。
 */
export interface ChatScrollOptions {
  /** 渲染预算起点：切会话首帧只挂这么多条。默认 6。 */
  rampInitial?: number;
  /** 每帧扩窗追加的条数。默认 3。 */
  rampChunk?: number;
  /** 数据窗口大小（透传 useMessageWindow 的 initialSize）。默认 15。 */
  windowInitial?: number;
  /** 上滚扩窗步长（透传 useMessageWindow 的 step）。默认 15。 */
  windowStep?: number;
  /**
   * 可注入的帧调度器：返回一个 cancel 函数。默认 requestAnimationFrame；
   * 测试传同步调度器（vitest 是 node 环境，无 rAF）。scrollToBottom 与 ramp
   * 共用同一调度器，保证测试里 neither 会因缺 rAF 抛错。
   */
  scheduleFrame?: (cb: () => void) => () => void;
}

const DEFAULT_RAMP_INITIAL = 6;
const DEFAULT_RAMP_CHUNK = 3;
const DEFAULT_WINDOW_INITIAL = 15;
const DEFAULT_WINDOW_STEP = 15;

/** rAF 不可用时（如极简运行时）退到 setTimeout，保证不崩。 */
function defaultScheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame !== "undefined") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16) as unknown as number;
  return () => clearTimeout(id);
}

export function useChatScroll(
  messages: () => readonly ChatMessage[],
  sessionId: () => string | null,
  options: ChatScrollOptions = {},
) {
  const rampInitial = options.rampInitial ?? DEFAULT_RAMP_INITIAL;
  const rampChunk = options.rampChunk ?? DEFAULT_RAMP_CHUNK;
  const windowInitial = options.windowInitial ?? DEFAULT_WINDOW_INITIAL;
  const windowStep = options.windowStep ?? DEFAULT_WINDOW_STEP;
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;

  // ── 数据窗口（useMessageWindow，原样复用）─────────────────────────────────
  // key 变时 useMessageWindow 自己把 window 重置回 windowInitial（稳态窗口）；
  // 本层只额外控制渲染预算 mountedCount。两 watcher 都 pre-flush，注册序：
  // useMessageWindow 的在前（先重置 window），本层 sessionId watcher 在后
  // （读到重置后的 windowed）。
  const { visible: windowed, hiddenCount, expandOlder } = useMessageWindow(
    messages,
    sessionId,
    { initialSize: windowInitial, step: windowStep },
  );

  // ── 渲染预算（分帧）───────────────────────────────────────────────────────
  const mountedCount = ref(rampInitial);
  /** 进 v-for 的实际列表：数据窗口尾部 mountedCount 条。mountedCount≥窗口长度
   *  时透传原数组引用（与 useMessageWindow 同款 cache 友好惯用）。 */
  const visibleMessages: ComputedRef<readonly ChatMessage[]> = computed(() => {
    const w = windowed.value;
    return w.length <= mountedCount.value ? w : w.slice(-mountedCount.value);
  });

  const ramping = ref(false);
  /** 切过去时会话还没 hydrate（messages 为空）→ 挂起等 messages 到齐再 ramp。 */
  let rampPending = false;
  /** ramp 在途帧句柄（cancel 函数；null=空闲）。 */
  let rafHandle: (() => void) | null = null;

  // ── 滚动状态 ────────────────────────────────────────────────────────────────
  const scrollEl = ref<HTMLDivElement | undefined>();
  const contentEl = ref<HTMLDivElement | undefined>();
  const autoScroll = ref(true);
  // 「回到底部」悬浮按钮：离底超过 JUMP_SHOW_THRESHOLD 才显示（比 autoScroll 的 48px
  // 阈值宽得多——刚离底几十 px 就浮按钮太吵）；上翻期间来新消息/流式增量时点亮铜色小点
  const JUMP_SHOW_THRESHOLD = 200;
  const farFromBottom = ref(false);
  const newWhileAway = ref(false);

  // ── 扩窗 + 滚动锚定 ────────────────────────────────────────────────────────
  let expandingOlder = false;
  /** 向上扩窗一步 + 滚动锚定（保持视觉位置不跳）。强制布局（读 scrollHeight）只
   *  发生在用户主动翻旧消息时，不在流式/ramp 热路径上。
   *
   *  扩窗后渲染预算 mountedCount 一并到顶（= 新窗口长度）：上滚加载的 30 条是
   *  一次性同步挂载（与今日行为一致——上滚的卡是后续议题，本次不碰锚定逻辑，
   *  仅保证功能不退步）。setWindowSize 必须在 nextTick 之前，锚定才能量到新内容
   *  带来的真实高度差。 */
  async function expandOlderAnchored() {
    const el = scrollEl.value;
    if (!el || expandingOlder || hiddenCount.value === 0) return;
    expandingOlder = true;
    try {
      cancelRamp(); // 用户接管，停掉自动 ramp
      const prevHeight = el.scrollHeight;
      const prevTop = el.scrollTop;
      expandOlder();
      mountedCount.value = windowed.value.length;
      await nextTick();
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      trail("expand", `${Math.round(prevTop)}→${Math.round(el.scrollTop)} hid=${hiddenCount.value}`);
    } finally {
      expandingOlder = false;
    }
  }

  // ── 滚轮接管 ──────────────────────────────────────────────────────────────
  // 根因（见 [[nested-scroller-wheel-trap]]，两份 scroll-trail 现场 + 探针复活定案）：
  // 合成器滚轮路径把 maxScrollOffset 焊死在内容首次溢出视口那一刻的值，之后内容
  // 增长不刷新；JS 的 scrollTop 赋值走主线程布局读实时 scrollHeight，畅通。所以把
  // 滚轮也赶到 JS 赋值路径：光标下最近可滚祖先就是本容器时（该滚对话区、无嵌套块
  // 需要原生滚），preventDefault + 手动 scrollTop += deltaY，彻底旁路缓存。
  // 取舍：失去 Chromium 合成器滚轮惯性/平滑——聊天滚动不需要。嵌套可滚块（思考块
  // reading 态、工具卡结果、xterm、DiffViewer 的 cm-scroller）的滚轮 nearestScrollableAncestor
  // 返回它们而非本容器，放行原生链式，不受影响。deltaMode 非 pixel（触控板 line/page
  // 模式）暂放行原生——鼠标 wheel 是 pixel 模式，覆盖最常见情况；触控板如复现再加换算。
  function onWheel(e: WheelEvent) {
    const el = scrollEl.value;
    if (!el || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
    if (nearestScrollableAncestor(e.target) !== el) return;
    e.preventDefault();
    el.scrollTop += e.deltaY;
    trail("wheelTakeover", `dy=${Math.round(e.deltaY)}→top=${Math.round(el.scrollTop)}`);
  }

  // ── 滚动事件 ──────────────────────────────────────────────────────────────
  // trail 埋点（滚动诊断环）：间歇性滚轮定格的活体采集——每个 scroll 事件留一行
  // 位置+门控状态，定格时与 wheel/write 记录互证。高频但纯内存推送，无布局读取。
  function onScroll() {
    const el = scrollEl.value;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    trail(
      "scroll",
      `top=${Math.round(el.scrollTop)} sh=${el.scrollHeight} ch=${el.clientHeight} auto=${autoScroll.value ? 1 : 0}`,
    );
    autoScroll.value = dist < 48;
    farFromBottom.value = dist > JUMP_SHOW_THRESHOLD;
    if (autoScroll.value) newWhileAway.value = false;
    // 滚到接近顶部 = 想看更早的消息:扩窗(带锚定)。ramp 期间不触发——短内容时
    // scrollTop≈0 会误把同步 expandOlder 点起来，毁掉分帧（且顶部入口此时也不显示）。
    if (el.scrollTop < 80 && hiddenCount.value > 0 && !ramping.value) void expandOlderAnchored();
  }

  // ── 置底 ──────────────────────────────────────────────────────────────────
  // 按帧节流：读 scrollHeight 会强制整个消息容器同步布局（成本 ∝ 已挂 DOM 体积），
  // 流式/ramp 期间每个增量都触发的话会压垮 UI 线程。合并到每帧至多一次；rAF 回调
  // 晚于 Vue 的微任务渲染批次，天然拿到更新后的 DOM。
  let scrollQueued = false;
  function scrollToBottom() {
    if (!autoScroll.value || scrollQueued) return;
    scrollQueued = true;
    scheduleFrame(() => {
      scrollQueued = false;
      const el = scrollEl.value;
      if (el) {
        trail("write", `toBottom ${Math.round(el.scrollTop)}→${el.scrollHeight}`);
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  // 新消息/流式增量到达：上翻阅读中则点亮「回到底部」的新消息小点；
  // 置底本身仍交给 scrollToBottom（autoScroll=false 时它自己 no-op）
  function onNewContent() {
    if (!autoScroll.value) newWhileAway.value = true;
    scrollToBottom();
  }

  watch(() => messages().length, onNewContent);
  watch(
    () => {
      const list = messages();
      const last = list[list.length - 1];
      const block = last?.blocks[last.blocks.length - 1];
      return block?.type === "text" ? (block as TextBlock).text.length : 0;
    },
    onNewContent,
  );

  // 点「回到底部」：平滑滚到底并恢复自动置底。先收按钮再滚——平滑滚动途中用户
  // 滚轮打断时 scroll 事件会把按钮按真实距离重新点亮，不会丢状态。
  function jumpToBottom() {
    const el = scrollEl.value;
    if (!el) return;
    trail("write", `jump smooth from=${Math.round(el.scrollTop)}`);
    newWhileAway.value = false;
    farFromBottom.value = false;
    autoScroll.value = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // ── 置底的统一触发器：数据层 watcher 只能枚举「新消息 / 文本增量」，但让滚动条
  //    搁浅的来源远不止这些——内容增高（变更卡 DiffViewer 到达、图片异步加载、历史
  //    扩窗……）与视口变化（权限对话框出现/消失、Pane 拖拽、窗口缩放）。枚举数据必然
  //    挂一漏万，改为在 DOM 层观察这两个症状本身。RO 通知按帧合并，频率与现有 watcher
  //    同级；autoScroll=false 时 scrollToBottom 自身 no-op，不打扰翻历史的用户；
  //    置底只写 scrollTop 不改两者尺寸，无反馈循环。
  let contentObserver: ResizeObserver | null = null;
  // 仅在组件实例内注册生命周期（测试在 effect scope 外直接调 composable 时不注册，
  // 避免 onMounted 无 active instance 警告；RO 本就依赖 DOM，node 测试无 ResizeObserver）。
  if (getCurrentInstance()) {
    onMounted(() => {
      // 滚轮接管（见 onWheel）：独立于 RO——RO 在无 ResizeObserver 环境（jsdom）会
      // 提前 return，但 wheel 监听不依赖 RO，必须无条件挂。
      scrollEl.value?.addEventListener("wheel", onWheel, { passive: false });
      if (typeof ResizeObserver === "undefined") return;
      contentObserver = new ResizeObserver(() => {
        // 不读尺寸（RO 回调里读 scrollHeight 是热路径强制布局）——只记触发与门控态，
        // 尺寸变化由随后的 scroll/write 记录体现。
        trail("ro", `auto=${autoScroll.value ? 1 : 0}`);
        scrollToBottom();
      });
      if (contentEl.value) contentObserver.observe(contentEl.value);
      if (scrollEl.value) contentObserver.observe(scrollEl.value);
    });
    onUnmounted(() => {
      contentObserver?.disconnect();
      contentObserver = null;
      scrollEl.value?.removeEventListener("wheel", onWheel);
    });
  }

  // ── 分帧 ramp ──────────────────────────────────────────────────────────────
  function cancelRamp() {
    if (rafHandle) {
      rafHandle();
      rafHandle = null;
    }
    ramping.value = false;
  }

  function startRamp() {
    cancelRamp();
    ramping.value = true;
    mountedCount.value = rampInitial;
    // 首帧同步置底：ramp 每帧加内容后，RO 触发的 scrollToBottom 落在下一帧 rAF，
    // 本帧会用旧 scrollTop 渲染造成一帧抖动；这里在调度下一 tick 前同步把 scrollTop
    // 钉到底，覆盖上一帧残留。成本是一次强制布局（∝ 已挂 DOM 6→30，仅 ~130ms ramp 期）。
    if (scrollEl.value && autoScroll.value) {
      trail("write", "ramp pin0");
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
    function tick() {
      if (!ramping.value) return; // 被切走 / 用户上滚接管取消
      const target = windowed.value.length;
      const next = Math.min(target, mountedCount.value + rampChunk);
      // 到稳态 / 短表全可见 / 空表：next 追不上 mountedCount 即停。天然防短/空会话死循环。
      if (next <= mountedCount.value) {
        ramping.value = false;
        return;
      }
      mountedCount.value = next;
      if (scrollEl.value && autoScroll.value) {
        trail("write", `ramp pin m=${mountedCount.value}`);
        scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
      }
      rafHandle = scheduleFrame(tick);
    }
    rafHandle = scheduleFrame(tick);
  }

  // 切会话：取消旧 ramp、复位滚动态、按需 ramp。immediate——首次打开（app 启动恢复
  // 末次会话）也走分帧，不止"切回"。pre-flush 在渲染补丁前触发，首帧渲染读到 mountedCount
  // 已是 rampInitial（6），不会一次性挂 30。
  watch(
    sessionId,
    (newId) => {
      trail("session", newId ?? "null"); // 切会话标记：定格「自愈」的分界线
      cancelRamp();
      rampPending = false;
      autoScroll.value = true;
      farFromBottom.value = false;
      newWhileAway.value = false;
      scrollToBottom();
      if (!newId) return; // hero（零会话）：不 ramp
      if (windowed.value.length > 0) startRamp();
      else rampPending = true; // 未 hydrate：等 messages 到齐
    },
    { immediate: true },
  );

  // hydrate 补交：切到未加载会话时挂起的 ramp，在 messages 0→N 那一下触发。pre-flush
  // 保证那一帧渲染前 mountedCount 已重置回 6，hydrate 不会一次性挂 30。rampPending
  // 仅 0→N 触发一次，流式逐条追加（n 持续增）不重复 ramp。
  watch(
    () => messages().length,
    (n) => {
      if (rampPending && n > 0) {
        rampPending = false;
        startRamp();
      }
    },
  );

  // ── 清理 ──────────────────────────────────────────────────────────────────
  // 仓库首次用 onScopeDispose：测试在 effect scope 外直接调 composable 时不注册，
  // 避免无 active scope 时抛错。组件场景下随实例卸载回收 rAF + RO。
  function cleanup() {
    cancelRamp();
    contentObserver?.disconnect();
    contentObserver = null;
  }
  if (getCurrentScope()) onScopeDispose(cleanup);

  return {
    scrollEl,
    contentEl,
    visibleMessages,
    hiddenCount,
    ramping,
    onScroll,
    jumpToBottom,
    farFromBottom,
    newWhileAway,
    expandOlderAnchored,
  };
}
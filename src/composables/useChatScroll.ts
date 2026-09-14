import { computed, getCurrentInstance, getCurrentScope, nextTick, onMounted, onScopeDispose, onUnmounted, reactive, ref, watch } from "vue";
import type { ComputedRef } from "vue";
import { trail } from "../utils/diagnostics/scrollTrail";
import type { ChatMessage, TextBlock } from "@/types/chat";
import {
  buildCumulative,
  buildRows,
  findRestorableSkeleton,
  findViewportPageIndex,
  isRecycleMutating,
  liveMessageCount,
  liveSkeletonInBand,
  loadedPagesBytes,
  ESTIMATE_MESSAGE_HEIGHT_PX,
  LIVE_TAIL_ROWS,
  RECYCLE_BYTES_BUDGET,
  releaseFarthestPages,
  restorePage,
  setViewportHot,
  computeRestoreScrollTop,
  type LiveWindowState,
  type Row,
} from "./useChatSession/recycle";

/**
 * 聊天滚动区主控（行模型 + 页级回收，2026-08-28 重构）：
 * - 行模型：渲染单元从「消息」升级为「行」（page=已加载页消息组 / skeleton=已释放
 *   页占位 / live=流式段单条），rows 由 recycle.buildRows 从页台账构建；
 * - 页级回收：已加载页总字节超 RECYCLE_BYTES_BUDGET 时，热区（视口页 ±1）外的
 *   远端页释放成骨架（实测高度撑住 → 总高不变、滚动零跳变）；滚动停驻 200ms 时
 *   结算（释放 + prefetch 骨架取回），取回带视口补偿；
 * - 上滚到顶部触发带 → loadOlder 取更早一页 unshift 头部 + 视口补偿
 *   （scrollTop += 高度差，看到的旧内容不跳）；
 * - 加载在途时顶部停留 → topPending → 完成后自动续取（连翻不中断）；
 * - 切会话统一走同一条分帧挂载通道（首帧 mountedCount 6 行 → 全量），防主线程
 *   秒级 jam（切回长会话一次性全量挂数万个节点 = 输入框流光掉帧的元凶）：
 *   - 首开/未 hydrate：钉底跟随（bottom）；
 *   - 切回有位置记忆：按「离底距离不变」逐帧锚定（anchor）——挂载只发生在已挂
 *     尾部之上（尾行=live 段=列表底），离底距离全程不变；锚点上方没挂齐前钳在
 *     底部（先看到 live 尾），挂齐后视口自然停在离开时的内容位置，ramp 收尾
 *     双帧校准 + 近底恢复跟随（沿用原 restore 语义）；
 *   - 挂载量按帧耗时自适应（AIMD：帧贴不进 vsync 就收缩、健康就渐进放大），
 *     重消息行不再按固定 40 行/帧爆帧。
 *
 * 内存双保险：recycle 管「页级驻留上限」（字节区间可从 jsonl 确定性重取），
 * evict 管「页内大 block 降级」——2026-08-26 的「只加载不回收」定稿被
 * freeze-1787901573714（渲染进程 1.08GB GC 螺旋 87s 未恢复）证伪推翻。
 * 第三层（2026-09-07）：live 段窗口化——live 段此前全量挂载且永不回收，切长
 * 会话瞬峰 1.4-1.55GB 实测定案在其上（memory/long-session-switch-renderer-spike）。
 * live 窗口 = liveskel（隐藏前缀占位，显示层状态）+ LIVE_TAIL_ROWS 常驻尾窗，
 * 数据层零改动：收拢在切走时实测（collapseAndTightenForSwitchAway），展开走
 * store 内存（无 IO），钉底流式滑动在 onNewContent。
 */

export interface ChatScrollOptions {
  /** 每次取回更早页的字节预算（loadOlder 的 limit）。默认 256KB。 */
  pageBytes?: number;
  /** 首帧渲染预算起点：切会话首帧只挂这么多行。默认 6。 */
  rampInitial?: number;
  /** 自适应挂载量的初始值（帧预算控制器会继续放大/收缩）。默认 40。 */
  rampChunk?: number;
  /** P1 双向分页：由上层（ChatPanel）绑定当前会话注入。缺省 = 无后端取回。 */
  pagination?: ChatScrollPagination;
  /** 按会话取消息数组——切走收拢/释放操作「离开会话」，而 watcher 时刻
   *  props.messages 已是新会话的，必须经此取旧会话数据。缺省回落当前会话
   *  （单会话测试场景够用）。 */
  messagesOf?: (sid: string) => readonly ChatMessage[];
  /** 可注入的帧调度器：返回一个 cancel 函数。默认 requestAnimationFrame；
   * 测试传同步调度器（vitest 是 node 环境，无 rAF）。scrollToBottom 与 ramp
   * 共用同一调度器。 */
  scheduleFrame?: (cb: () => void) => () => void;
}

/** P1 双向分页接口：上滚到顶部触发带 → loadOlder 取更早一页。
 *  页级回收由 recycle.ts 管（滚动停驻时释放/取回），对本接口透明。 */
export interface ChatScrollPagination {
  /** 磁盘上还有更早页可取。 */
  hasMore: () => boolean;
  /** 取回更早一页（limit 为字节预算，见 load_messages），返回实际条数。 */
  loadOlder: (limit: number) => Promise<number>;
}

const DEFAULT_PAGE_BYTES = 256 * 1024;
const DEFAULT_RAMP_INITIAL = 6;
const DEFAULT_RAMP_CHUNK = 40;
/** 帧预算控制器的目标挂载耗时（略小于一帧，给流光等同帧主线程动画留余量）：
 *  帧耗时超过 SHRINK_MS 才收缩（带宽吸收抖动，不逐帧振荡），否则按 +1/8 渐进
 *  放大——挂载帧整体收敛在 60fps 边缘，切回长会话的挂载总量不变但每帧流畅。 */
const RAMP_FRAME_TARGET_MS = 12;
const RAMP_FRAME_SHRINK_MS = 20;
const RAMP_CHUNK_MIN = 1;
/** 自适应上限（轻行很快冲顶；重行由 SHRINK 判定接管收缩）。 */
const RAMP_CHUNK_MAX = 400;
/** 锚定 ramp 的接管判定：落点写入前后 scrollTop 偏差超过容差 = 用户（滚条拖动等，
 *  wheel 接管另有通道）自己动了 → 取消 ramp 全量挂载。容差只吸收亚像素/取整。 */
const RAMP_ANCHOR_TOLERANCE_PX = 4;
/** 滚动停驻判定：距最后一次 scroll 事件这么久才结算回收/取回（滚动途中不动结构，
 *  避免快速翻页时页在脚下被抽走）。 */
const SCROLL_SETTLE_MS = 200;
/** 骨架取回预取边距：骨架进入视口 ±1.5 屏就取回（不必等它滚进视口才加载）。 */
const SKELETON_PREFETCH_MARGIN = 1.5;

/** rAF 不可用时（如极简运行时）退到 setTimeout，保证不崩。 */
function defaultScheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame !== "undefined") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id: ReturnType<typeof setTimeout> = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

/** 从 target 向上找第一个用户手势可滚的祖先（overflow-y: auto|scroll）。
 *  用于 wheel 接管判断：若最近可滚祖先就是对话滚动容器本身，说明滚轮该滚
 *  对话区、光标下没有需要原生滚动的嵌套块——此时接管（见 onWheel），
 *  让滚轮走 JS 赋值路径（实时布局），旁路掉合成器滚轮缓存的焊死
 *  病根（见 [[nested-scroller-wheel-trap]]）。返回 null = 一路到顶无可滚祖先。 */
export function nearestScrollableAncestor(target: EventTarget | null): Element | null {
  let el = target as Element | null;
  for (let hop = 0; el && hop < 12; hop++) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === "auto" || oy === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}

/** 嵌套可滚块是否已在 deltaY 方向的边界（顶/底）。onWheel 用它判断嵌套块滚到边界后
 *  是否该把滚轮链式移交给对话区走 JS 赋值（旁路合成器链式失同步，见
 *  [[nested-scroller-wheel-trap]]）。deltaY<0=上滚到顶，deltaY>0=下滚到底；
 *  内容未溢出（含 jsdom 零几何）直接判否——无可滚范围谈不上边界，放行原生交给浏览器。
 *  -1px 容差吸收亚像素/缩放。 */
function atScrollEdge(el: Element, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  if (deltaY < 0) return el.scrollTop <= 0;
  if (deltaY > 0) return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  return false;
}

export function useChatScroll(
  messages: () => readonly ChatMessage[],
  sessionId: () => string | null,
  options: ChatScrollOptions = {},
) {
  const pageBytes = options.pageBytes ?? DEFAULT_PAGE_BYTES;
  const rampInitial = options.rampInitial ?? DEFAULT_RAMP_INITIAL;
  const rampChunk = options.rampChunk ?? DEFAULT_RAMP_CHUNK;
  const scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
  const pagination = options.pagination;

  /** 行列表：页台账驱动的渲染模型（无台账 = 全 live 兼容路径）；live 窗口把
   *  live 段切成「liveskel 隐藏前缀 + 常驻尾窗」（显示层窗口化，store/台账不动）。 */
  const rows: ComputedRef<readonly Row[]> = computed(() => {
    const sid = sessionId() ?? "";
    return buildRows(sid, messages(), liveWindows.get(sid));
  });

  /** live 段窗口状态（per-instance，sid → { topIdx, perRowPx }）：隐藏前缀由一条
   *  liveskel 行代表，尾窗 LIVE_TAIL_ROWS 行常驻。切长会话尖峰修复的显示层
   *  状态（见 plans/2026-09-07-live-window-recycle）——收拢在切走时实测，
   *  展开来自 store 内存（无 IO），钉底流式滑动在 onNewContent。 */
  const liveWindows = reactive(new Map<string, LiveWindowState>());

  // ── 首帧渲染预算（唯一一层窗口化：防切会话一次性挂载 jam）──────────────
  // 数据层窗口化由页级回收负责（骨架）；这里只控制「首帧挂多少行」再逐帧补到全量。
  const mountedCount = ref(rampInitial);
  /** 会话滚动位置记忆（sid → ScrollMemory）：切走记录、切回恢复。切回钉底
   *  只用于首次打开（无记忆）；组件级 Map——会话切换组件常驻，位置随会话保留，
   *  组件重建（关 tab 重开）后自然为空，回落首帧钉底行为。distBottom = 离开时刻
   *  的离底距离（distBottom 锚定的兜底基准，见 RampPin.anchor 注释）；anchor =
   *  内容锚点（优先落点，见 ScrollMemory.anchor）。 */
  interface ScrollMemory {
    top: number;
    distBottom: number;
    /** 内容锚点（2026-09-01 根因修复）：distBottom 是像素度量，切走后视口
     *  下方内容一旦被后台 evict 改写（大 block 降级变矮 / 页释放成估算骨架，
     *  events.ts 的 maybeEvict 对后台会话照常触发），切回落点 = H_new -
     *  distBottom 会系统性偏上并被正反馈锁定——「每次切回固定在上方某处」
     *  （useChatScroll.geometry.test.ts 坐实）。锚点改记「视口顶所在行 id +
     *  行内偏移」：行身份跨降级/释放/取回稳定，落点对齐离开时刻看的内容。
     *  仅带 data-row-id 的行（page/skeleton）可锚；live 行无 id（测高成本
     *  设计）→ 无锚回退 distBottom（尾部场景后台收缩小、失真有限）。 */
    anchor?: { rowId: string; offsetInRow: number };
  }
  const scrollPositions = new Map<string, ScrollMemory>();
  /** 进 v-for 的实际列表：rows 尾部 mountedCount 行（首帧 ramp 渐进，之后全量）。
   *  liveskel 例外：它是隐藏前缀的唯一高度代表，必须始终挂载（否则总高失真、
   *  锚定落点漂移）——尾切片未含它时前置补入；已含（liveskel 落在切片内，
   *  如过藏态）直接返回，绝不重复输出（Vue 重复 key + 高度翻倍）。 */
  const visibleRows: ComputedRef<readonly Row[]> = computed(() => {
    const list = rows.value;
    if (list.length <= mountedCount.value) return list;
    const lsIdx = list.findIndex((r) => r.kind === "liveskel");
    if (lsIdx < 0) return list.slice(-mountedCount.value);
    const tail = list.slice(-mountedCount.value);
    if (lsIdx >= list.length - mountedCount.value) return tail;
    return [list[lsIdx], ...tail];
  });

  const ramping = ref(false);
  /** 切过去时会话还没 hydrate（messages 为空）→ 挂起等 messages 到齐再 ramp。 */
  let rampPending = false;
  /** 挂起的 ramp 落点策略（rampPending 对应）：无记忆=bottom，切回=anchor。 */
  let rampPendingPin: RampPin | null = null;
  /** ramp 在途帧句柄（cancel 函数；null=空闲）。 */
  let rafHandle: (() => void) | null = null;

  function cancelRamp() {
    if (rafHandle) {
      rafHandle();
      rafHandle = null;
    }
    ramping.value = false;
  }

  /**
   * 分帧挂载的每帧落点策略——切会话渲染只有这一条通道，入口差异只收在
   * 「怎么落 scrollTop」上：
   *  - bottom：钉底跟随（首开/未 hydrate），含 live 段逐帧长高的追底；
   *  - anchor：优先「内容锚点」（ScrollMemory.anchor：视口顶对齐锚行文档位置 +
   *    行内偏移，锚行身份跨后台 evict 收缩稳定）；无锚/锚行已消失回退「离底距离
   *    不变」（distBottom）。分帧挂载只发生在已挂尾部之上（尾行=live 段=列表底）：
   *    锚行未挂载（窗口之外）时钳在底部——先看到 live 尾，行从上方不断挂入，
   *    锚行挂入后视口逐帧跟随锚行（其文档位置随上方挂入下移），挂齐后停在
   *    离开时刻看的内容行上；distBottom 兜底路径保持原语义（锚点上方未挂齐
   *    落负值 / 锚点在最后一屏内统一钳底）。
   */
  type RampPin =
    | { kind: "bottom" }
    | { kind: "anchor"; distBottom: number; anchor?: ScrollMemory["anchor"] };
  let rampPin: RampPin = { kind: "bottom" };
  /** anchor 模式最近一次写入的落点（接管判定基准，见 rampPin 内偏差检查）。 */
  let lastAnchorTop: number | null = null;
  /** 帧预算控制器的当前挂载量（每次 startRamp 重置回 rampChunk 起步）。 */
  let rampChunkCur = rampChunk;

  /** 锚行元素当前文档位置（相对滚动内容顶，含行上方已挂内容）；null = 锚行
   *  未挂载（尾部窗口之外）或无几何可读（jsdom/未布局）。遍历 children 比对
   *  data-row-id 而非 querySelector：不依赖 id 的 CSS 选择器安全性。 */
  function anchorRowTop(
    el: HTMLDivElement,
    anchor: NonNullable<ScrollMemory["anchor"]>,
  ): number | null {
    const root = contentEl.value;
    if (!root) return null;
    const elRect = el.getBoundingClientRect();
    if (elRect.height <= 0) return null;
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i] as HTMLElement;
      if (child.dataset?.rowId !== anchor.rowId) continue;
      const rect = child.getBoundingClientRect();
      if (rect.height <= 0) return null;
      return el.scrollTop + (rect.top - elRect.top);
    }
    return null;
  }

  /** anchor 落点统一函数（rampLand 每帧 / finishRamp 双帧校准共用）：
   *  锚行优先（对齐内容身份），锚行已不在 rows（页被丢等结构变化）或无锚
   *  记忆回退 distBottom 公式；锚行在 rows 但未挂载钳底（等挂载）。返回值
   *  已 clamp 到 [0, max]，可直接写入（接管判定的「写入值不被浏览器钳位」
   *  前提因此保持）。 */
  function landAnchored(el: HTMLDivElement, pin: Extract<RampPin, { kind: "anchor" }>): number {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const clamp = (v: number) => (v < 0 ? 0 : v > max ? max : v);
    if (pin.anchor && rows.value.some((r) => r.id === pin.anchor!.rowId)) {
      const top = anchorRowTop(el, pin.anchor);
      if (top !== null) return clamp(top + pin.anchor.offsetInRow);
      return max; // 锚行在 rows 但未挂载：钳底，挂入后自然跟到锚行
    }
    return clamp(el.scrollHeight - pin.distBottom);
  }

  function rampLand() {
    const el = scrollEl.value;
    if (rampPin.kind === "bottom") {
      if (el && autoScroll.value) {
        trail("write", `ramp pin m=${mountedCount.value}`);
        el.scrollTop = el.scrollHeight;
      }
      return;
    }
    if (!el) return;
    const target = landAnchored(el, rampPin);
    // 接管判定：两次锚定写入之间 scrollTop 被第三方移走（滚条拖动）→ 视为用户
    // 接管。wheel 接管走 onWheel/userTookScroll；此处覆盖滚条分支。程序化写入
    // 前后必然相等（landAnchored 返回值已 clamp 到 [0, max]，浏览器不会再钳位），
    // 亚像素差在容差内。
    if (lastAnchorTop !== null && Math.abs(el.scrollTop - lastAnchorTop) > RAMP_ANCHOR_TOLERANCE_PX) {
      trail("wheelTakeover", `anchor deviate ${Math.round(el.scrollTop)}≠${lastAnchorTop}`);
      userTookScroll();
      return;
    }
    trail("write", `ramp anchor m=${mountedCount.value} top=${Math.round(target)}`);
    el.scrollTop = target;
    lastAnchorTop = target;
  }

  /** ramp 收尾：bottom 无动作；anchor 沿用原切回 restore 的双帧校准（第一帧设一次、
   *  第二帧重校准，统一走 landAnchored——锚行优先、distBottom 兜底）+ 落点近底才
   *  恢复跟随——防止残留 scroll 回波把跟随误刷新后又被 toBottom 拉走
   *  （2026-08-26 trail 实锤的时序）。 */
  function finishRamp() {
    ramping.value = false;
    const pin = rampPin;
    if (pin.kind !== "anchor") return;
    scheduleFrame(() => {
      const el = scrollEl.value;
      if (!el) return;
      el.scrollTop = landAnchored(el, pin);
      scheduleFrame(() => {
        const el2 = scrollEl.value;
        if (!el2) return;
        el2.scrollTop = landAnchored(el2, pin);
        trail("write", `anchor restore ${Math.round(el2.scrollTop)}`);
        if (el2.scrollHeight - el2.scrollTop - el2.clientHeight < 48) autoScroll.value = true;
      });
    });
  }

  /** 用户滚动接管：ramp 即停、已加载数据全量挂载（防中间段缺失）、脱离自动跟随。
   *  滚轮接管（onWheel）与原生上滚（onScroll 上滚分支）共用。根因：ramp 每帧
   *  pin 到底 + pin 的 scroll 回波把 autoScroll 刷回 true，用户的滚轮增量被逐帧
   *  吞掉——切回会话（autoScroll=true + startRamp）后滚轮一直钉在底部，live 会话
   *  （target 持续增长）ramp 永不结束则永远钉底（2026-08-26 用户实锤）。 */
  function userTookScroll() {
    cancelRamp();
    autoScroll.value = false;
    mountedCount.value = Math.max(mountedCount.value, rows.value.length);
  }

  function startRamp(pin: RampPin = { kind: "bottom" }) {
    cancelRamp();
    ramping.value = true;
    rampPin = pin;
    rampChunkCur = rampChunk;
    lastAnchorTop = null;
    mountedCount.value = rampInitial;
    // 首帧同步落位：ramp 每帧加内容后，RO 触发的 scrollToBottom 落在下一帧 rAF，
    // 本帧会用上一帧的 scrollTop 渲染造成一帧抖动；这里在调度下一 tick 前同步
    // 落位，覆盖上一帧残留（bottom=钉底 / anchor=离底锚定）。
    // ——anchor（切回）例外：startRamp 在 watch(sessionId) 的 pre-flush 里执行，
    // 此刻 DOM 还是【上一个会话】的——在旧 DOM 上读 scrollHeight 算出的 target
    // 是错的，写入无意义；更糟的是它把接管判定基线（lastAnchorTop）锚到旧 DOM
    // 的值上——patch 内容替换后 scrollTop 的任何变化（布局期钳位/挂载期写入）
    // 都会被 tick 帧误判成「滚条拖动」取消 ramp（2026-09-01 trail 实锤：首帧
    // 写 0 → patch 后 scrollTop 被置到新 DOM 的 max → anchor deviate 误判 →
    // 位置钉死在误判点）。anchor 的首帧落位交给 tick 第一帧（新 DOM）完成，
    // lastAnchorTop 从新 DOM 建立——首帧天然跳过偏差判定（null 基线），中途
    // 的跳变会被首帧直接覆盖为正确落点。
    if (pin.kind === "bottom") rampLand();
    rafHandle = scheduleFrame(tick); // 首帧只渲染 rampInitial 行，下一帧才开始递增

    function tick() {
      if (!ramping.value) return; // 被切走 / 用户接管取消
      const target = rows.value.length;
      if (mountedCount.value >= target) {
        finishRamp();
        return;
      }
      const t0 = performance.now();
      mountedCount.value = Math.min(target, mountedCount.value + rampChunkCur);
      rafHandle = scheduleFrame(() => {
        if (!ramping.value) return; // 本帧间被取消：不落位、不再续帧
        // 帧预算控制器：t0→rAF 回调的耗时 ≈ 本 chunk 的 patch + 布局 + 绘制。
        const dt = performance.now() - t0;
        rampChunkCur = dt > RAMP_FRAME_SHRINK_MS
          ? Math.max(RAMP_CHUNK_MIN, Math.round(rampChunkCur * (RAMP_FRAME_TARGET_MS / dt)))
          : Math.min(RAMP_CHUNK_MAX, rampChunkCur + Math.max(2, rampChunkCur >> 3));
        rampLand();
        rafHandle = scheduleFrame(tick);
      });
    }
  }

  // ── 滚动状态 ────────────────────────────────────────────────────────────────
  const scrollEl = ref<HTMLDivElement | undefined>();
  const contentEl = ref<HTMLDivElement | undefined>();
  const autoScroll = ref(true);
  // 「回到底部」悬浮按钮：离底超过 JUMP_SHOW_THRESHOLD 才显示（比 autoScroll 的 48px
  // 阈值宽得多——刚离底几十 px 就浮按钮太吵）；上翻期间来新消息/流式增量时点亮铜色小点
  const JUMP_SHOW_THRESHOLD = 200;
  const farFromBottom = ref(false);
  const newWhileAway = ref(false);

  /** 上滚取回触发带：距顶 max(80, 一屏高 × 0.6) 内即预加载——不必精确滚到顶。 */
  function expandThreshold(el: HTMLDivElement): number {
    return Math.max(80, el.clientHeight * 0.6);
  }

  /** 加载更早一页在途（防重入 + 顶部停留续取的门控）。 */
  const loadingOlder = ref(false);
  /** 加载在途时用户滚到顶部触发带 → 完成后自动续取（连翻不中断）。 */
  let topPending = false;
  /** 骨架取回在途（与 loadingOlder 互斥——两者都 splice messages/台账）。 */
  const restoring = ref(false);

  // ── 页级回收：测量/结算/取回 ────────────────────────────────────────────────

  /** 实测当前已挂载行的高度表（rowId → px）。零高度（jsdom/未布局）视为未测，
   *  不入表——调用方 cum 会回退到骨架记账高/默认估算。 */
  function measureRowHeights(): Map<string, number> {
    const heights = new Map<string, number>();
    const root = contentEl.value;
    if (!root) return heights;
    for (const el of root.querySelectorAll<HTMLElement>("[data-row-id]")) {
      const h = el.getBoundingClientRect().height;
      if (h > 0 && el.dataset.rowId) heights.set(el.dataset.rowId, h);
    }
    return heights;
  }

  /** 切走时测内容锚点：视口顶所在的带 data-row-id 行 + 行内偏移（px）。
   *  在 watch(sessionId)（pre-flush）里调用，children/scrollTop 都是离开会话的
   *  现场值。返回 null = 视口顶落在无 id 行（live 段 / 顶部 gate 区）或无 DOM
   *  几何（jsdom/未布局）→ 调用方只记 distBottom，切回走兜底锚定。 */
  function measureViewportAnchor(): ScrollMemory["anchor"] | null {
    const el = scrollEl.value;
    const root = contentEl.value;
    if (!el || !root) return null;
    const elRect = el.getBoundingClientRect();
    if (elRect.height <= 0) return null;
    const vpTopDoc = el.scrollTop;
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i] as HTMLElement;
      const rect = child.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const topDoc = el.scrollTop + (rect.top - elRect.top);
      if (topDoc + rect.height <= vpTopDoc) continue; // 整行在视口顶上方
      // 第一个底超过视口顶的行 = 视口顶所在行
      const rowId = child.dataset?.rowId;
      if (!rowId) return null; // live 段行/门按钮：无行身份，不可锚
      return { rowId, offsetInRow: Math.max(0, vpTopDoc - topDoc) };
    }
    return null;
  }

  // ── live 段窗口：收拢 / 滑动 / 展开 ────────────────────────────────────────
  // 切长会话尖峰的显示层修复：live 段 = liveskel（隐藏前缀，一条占位行）+
  // LIVE_TAIL_ROWS 常驻尾窗。数据层（store/台账）零改动——隐藏前缀的行本就在
  // store 里，展开不产生 IO；总高由实测/估算的 liveskel 高度守恒，滚动零跳变。

  /** 收拢 live 窗口（视口锚定）：保留「视口上方 4 屏 + 视口以下全部」的 live 行，
   *  其余（更早的前缀）收进一条 liveskel。视口整体在 live 区上方（在页区阅读）
   *  时整段收拢到底部窗。在旧 DOM 还在时调用（切走 watcher pre-flush）：隐藏区
   *  实测总高直接记账（总高守恒 → distBottom 落点在收拢后仍诚实）。无几何
   *  （jsdom/未布局）回退条数 × 估算。已展开更宽的窗口不回退。 */
  function collapseLiveWindow(sid: string, msgs: readonly ChatMessage[]): void {
    const len = msgs.length;
    const liveSeg = liveMessageCount(sid, len);
    if (liveSeg <= LIVE_TAIL_ROWS) {
      liveWindows.delete(sid);
      return;
    }
    const root = contentEl.value;
    const el = scrollEl.value;
    const liveEls = root?.querySelectorAll<HTMLElement>(".chat-row-live");
    let hiddenCount = -1;
    let hiddenPx = -1;
    if (root && el && liveEls && liveEls.length > 0) {
      const contentTop = root.getBoundingClientRect().top;
      const docTopOf = (node: Element) => node.getBoundingClientRect().top - contentTop;
      const mountedTail = liveEls.length; // 挂载 live 行数（= [liveStart+已藏, len) 区）
      const baseRel = liveSeg - mountedTail; // 挂载首行的 live 段相对下标
      const lsEl = root.querySelector<HTMLElement>(`[data-row-id="liveskel:${sid}"]`);
      const regionStart = lsEl ?? liveEls[0]; // live 区（含隐藏前缀）的第一个元素
      let kept = -1;
      if (docTopOf(regionStart) > el.scrollTop + el.clientHeight) {
        // 视口整体在 live 区上方：整段收拢到底部窗（live 区全在视口下方，随便藏）
        hiddenCount = liveSeg - LIVE_TAIL_ROWS;
      } else {
        // 视口锚定：保留视口上方 4 屏起的行，视口以下全保——distBottom/锚行
        // 落点所依赖的「视口处内容」原样挂载，切回精确恢复
        const keepAbove = el.scrollTop - el.clientHeight * 4;
        for (let i = 0; i < mountedTail; i++) {
          if (docTopOf(liveEls[i]) >= keepAbove) {
            kept = i;
            break;
          }
        }
        hiddenCount = kept >= 0 ? baseRel + kept : baseRel;
      }
      // 隐藏区实测总高 = 首个保留行 docTop − 区域顶（含已有 liveskel 的记账高）
      const bottomIdx = hiddenCount === liveSeg - LIVE_TAIL_ROWS
        ? Math.max(0, mountedTail - LIVE_TAIL_ROWS)
        : kept;
      const bottomEl = bottomIdx >= 0 ? liveEls[bottomIdx] : undefined;
      if (regionStart && bottomEl) {
        const measured = bottomEl.getBoundingClientRect().top - regionStart.getBoundingClientRect().top;
        if (measured > 0) hiddenPx = Math.round(measured);
      }
    }
    if (hiddenCount < 0) hiddenCount = liveSeg - LIVE_TAIL_ROWS;
    const existing = liveWindows.get(sid);
    if (existing && existing.hiddenCount > hiddenCount) return; // 已展开更宽：收拢不回退
    if (hiddenPx < 0) {
      hiddenPx =
        existing && existing.hiddenCount === hiddenCount
          ? existing.hiddenPx
          : hiddenCount * ESTIMATE_MESSAGE_HEIGHT_PX;
    }
    liveWindows.set(sid, { hiddenCount, hiddenPx: Math.max(1, hiddenPx) });
    trail("recycle", `liveCollapse ${sid.slice(0, 8)} hidden=${hiddenCount} hiddenPx=${hiddenPx}`);
  }

  /** 切入会话时的窗口保障：live 段超窗而未收拢（重开/后台增长）→ 滑到尾窗，
   *  新增隐藏行按估算累加（真实行高在下次收拢/展开实测收敛）；live 段缩到
   *  窗内（revert 等）→ 清窗口。只增隐藏、不展开。 */
  function slideLiveWindowToTail(sid: string): void {
    const len = messages().length;
    const liveSeg = liveMessageCount(sid, len);
    if (liveSeg <= LIVE_TAIL_ROWS) {
      liveWindows.delete(sid);
      return;
    }
    const targetHidden = liveSeg - LIVE_TAIL_ROWS;
    const existing = liveWindows.get(sid);
    if (!existing) {
      // 无实测来源（旧 DOM 已不在）：条数 × 估算兜底
      liveWindows.set(sid, { hiddenCount: targetHidden, hiddenPx: targetHidden * ESTIMATE_MESSAGE_HEIGHT_PX });
      return;
    }
    if (existing.hiddenCount >= liveSeg) {
      // 过藏（dispose 后同 sid 重开，内容已换，旧窗口大于现存 live 段）：
      // 按 px/条比例折算重建到尾窗，防 stale 大窗口把 live 段整段吞掉
      trail(
        "recycle",
        `liveOverHidden ${sid.slice(0, 8)} ${existing.hiddenCount}→${targetHidden} px${Math.round(existing.hiddenPx)}`,
      );
      liveWindows.set(sid, {
        hiddenCount: targetHidden,
        hiddenPx: Math.max(1, Math.round((existing.hiddenPx * targetHidden) / existing.hiddenCount)),
      });
      return;
    }
    if (existing.hiddenCount < targetHidden) {
      const added = targetHidden - existing.hiddenCount;
      liveWindows.set(sid, { hiddenCount: targetHidden, hiddenPx: existing.hiddenPx + added * ESTIMATE_MESSAGE_HEIGHT_PX });
    }
  }

  /** 展开 liveskel 一个 chunk：新行来自 store 内存（无 IO）。视口补偿复用
   *  sh-delta 公式（新行插在视口上方/骑跨统一）；展开后实测新行总高扣减
   *  隐藏区记账——liveskel 剩余高度随之自校正。 */
  const expandingLive = ref(false);
  async function expandLiveAnchored(): Promise<void> {
    const el = scrollEl.value;
    const sid = sessionId();
    const win = sid ? liveWindows.get(sid) : undefined;
    if (!el || !sid || !win || expandingLive.value || restoring.value || loadingOlder.value) return;
    const liveSeg = liveMessageCount(sid, messages().length);
    const hidden = Math.min(win.hiddenCount, liveSeg);
    if (hidden <= 0) return;
    if (ramping.value) userTookScroll();
    expandingLive.value = true;
    try {
      const chunk = Math.min(hidden, LIVE_TAIL_ROWS);
      const newHidden = hidden - chunk;
      const prevTop = el.scrollTop;
      const prevHeight = el.scrollHeight;
      liveWindows.set(sid, { ...win, hiddenCount: newHidden });
      await nextTick();
      if (el.scrollTop !== prevTop) return; // 展开期间用户滚动：放弃补偿
      // 实测新行总高 → 扣减隐藏区总高（liveskel 高度随之自校正）
      const liveEls = contentEl.value?.querySelectorAll<HTMLElement>(".chat-row-live");
      if (liveEls && liveEls.length >= chunk) {
        let measured = 0;
        for (let i = 0; i < chunk; i++) measured += liveEls[i].getBoundingClientRect().height;
        measured = Math.round(measured);
        if (newHidden <= 0) {
          liveWindows.delete(sid); // 全量展开：liveskel 退役
        } else {
          const corrected = measured > 0 ? Math.max(1, win.hiddenPx - measured) : win.hiddenPx;
          liveWindows.set(sid, { hiddenCount: newHidden, hiddenPx: corrected });
        }
        await nextTick(); // 修正后的 liveskel 高度进 DOM，再读几何补偿
      }
      if (el.scrollTop !== prevTop) return; // 校正期间用户滚动：放弃补偿
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      mountedCount.value = Math.max(mountedCount.value, rows.value.length);
      trail("expand", `live ${Math.round(prevTop)}→${Math.round(el.scrollTop)} hidden=${newHidden}`);
      scheduleSettle(); // 展开后复查：另一侧的骨架/窗口可能进入预取带
    } finally {
      expandingLive.value = false;
    }
  }

  /** 滚动停驻结算：量高 → 定位视口页 → 上报热区 → 超预算释放热区外页 →
   *  prefetch 边距内 liveskel 展开 / 骨架取回。ramp/mutate 在途不动结构。 */
  function settleRecycle() {
    const el = scrollEl.value;
    const sid = sessionId();
    if (!el || !sid || ramping.value || loadingOlder.value || restoring.value || expandingLive.value || isRecycleMutating(sid)) return;
    const heights = measureRowHeights();
    const cum = buildCumulative(rows.value, heights);
    const pageIdx = findViewportPageIndex(el.scrollTop, rows.value, cum);
    if (pageIdx >= 0) setViewportHot(sid, pageIdx);
    if (loadedPagesBytes(sid) > RECYCLE_BYTES_BUDGET) {
      releaseFarthestPages(
        sid,
        { budget: RECYCLE_BYTES_BUDGET, hotPageIndex: pageIdx >= 0 ? pageIdx : undefined },
        (i) => {
          // 待释放页若仍挂着：实测行高作骨架高（总高不变 → 滚动零跳变）；
          // 未挂载（ramp 切走/后台）返回 undefined → recycle 内估算
          const ledger_row = rows.value.find((r) => r.kind === "page" && r.pageIndex === i);
          return ledger_row ? heights.get(ledger_row.id) : undefined;
        },
      );
    }
    // prefetch：liveskel 优先（进入 live 段的必经门），其次页骨架——两者都带视口补偿
    if (liveSkeletonInBand(el.scrollTop, el.clientHeight, rows.value, cum, SKELETON_PREFETCH_MARGIN)) {
      void expandLiveAnchored();
    } else {
      const skelIdx = findRestorableSkeleton(el.scrollTop, el.clientHeight, rows.value, cum, SKELETON_PREFETCH_MARGIN);
      if (skelIdx >= 0) void restoreAnchored(skelIdx);
    }
  }

  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settleRecycle();
    }, SCROLL_SETTLE_MS);
  }

  /** 切走收尾：收拢 live 窗口（旧 DOM 实测）+ 收紧已加载页（热区 ±1 豁免）。
   *  在 watch(sessionId) pre-flush 里调用——此刻 scrollEl/children 还是离开
   *  会话的，props.messages 已是新会话的（旧会话数据经 messagesOf 取）。
   *  目的：切走后该会话的 DOM = 骨架 div + liveskel + 尾窗，切回零尖峰。 */
  function collapseAndTightenForSwitchAway(oldId: string): void {
    const msgs = options.messagesOf?.(oldId) ?? messages();
    const heights = measureRowHeights();
    collapseLiveWindow(oldId, msgs);
    if (isRecycleMutating(oldId)) return; // 取回在途：本次不收紧，下次切走重试
    const oldRows = buildRows(oldId, msgs, liveWindows.get(oldId) ?? null);
    const el = scrollEl.value;
    const cum = buildCumulative(oldRows, heights);
    const pageIdx = el ? findViewportPageIndex(el.scrollTop, oldRows, cum) : -1;
    const released = releaseFarthestPages(
      oldId,
      { budget: 0, hotPageIndex: pageIdx >= 0 ? pageIdx : undefined },
      (i) => {
        // 待释放页若挂着：实测行高作骨架高（总高不变）；未挂载 → recycle 内估算
        const row = oldRows.find((r) => r.kind === "page" && r.pageIndex === i);
        return row ? heights.get(row.id) : undefined;
      },
    );
    if (released > 0) trail("recycle", `switchAway ${oldId.slice(0, 8)} released=${released} hot=${pageIdx}`);
  }

  /** 取回骨架页 + 视口补偿：骨架/真实内容的高度差按「页顶相对视口位置不变」
   *  补偿（computeRestoreScrollTop 纯函数），骨架在视口上方/骑跨两情形统一。 */
  async function restoreAnchored(pageIndex: number) {
    const el = scrollEl.value;
    const sid = sessionId();
    if (!el || !sid || restoring.value || loadingOlder.value || expandingLive.value) return;
    // 结构性操作（页级取回 splice messages）不与 ramp 并行：先按接管语义落定
    // （ramp 停 + 全量挂载），再取回——否则行模型在分帧挂载中途变化，锚定/窗口都失真
    if (ramping.value) userTookScroll();
    const rowIndex = rows.value.findIndex((r) => r.kind === "skeleton" && r.pageIndex === pageIndex);
    if (rowIndex < 0) return;
    restoring.value = true;
    try {
      const cumBefore = buildCumulative(rows.value, measureRowHeights());
      const prevTop = el.scrollTop;
      const count = await restorePage(sid, pageIndex);
      if (count === 0) return; // 取回失败/骨架被丢（截断 clamp）——结构已变，不补偿
      if (el.scrollTop !== prevTop) return; // 取回期间用户滚动，放弃补偿
      await nextTick();
      const cumAfter = buildCumulative(rows.value, measureRowHeights());
      el.scrollTop = computeRestoreScrollTop(cumBefore, cumAfter, rowIndex, prevTop);
      mountedCount.value = Math.max(mountedCount.value, rows.value.length);
      trail("restore", `p=${pageIndex} ${Math.round(prevTop)}→${Math.round(el.scrollTop)}`);
    } finally {
      restoring.value = false;
      scheduleSettle(); // 取回后复查：滚过的另一侧可能已可释放
    }
  }

  /** 向上加载更早一页 + 视口补偿（scrollTop 保持旧内容位置不跳）。
   *  mountedCount 一并到顶（= 新 rows 长度）：新页立即全部挂载
   *  （一页几十条，一次性挂载可接受；首帧 ramp 只服务于切会话首帧）。 */
  async function expandOlderAnchored() {
    const el = scrollEl.value;
    if (!el || loadingOlder.value || restoring.value || expandingLive.value || !(pagination?.hasMore() ?? false)) return;
    loadingOlder.value = true;
    try {
      cancelRamp(); // 用户接管，停掉自动 ramp
      const prevHeight = el.scrollHeight;
      const prevTop = el.scrollTop;
      const count = await pagination!.loadOlder(pageBytes);
      if (count > 0) {
        // live 窗口不动：loadOlderPage 必建台账页（prepend 只移动 liveStart），
        // hiddenCount 是 live 段相对量、锚定同一内容——页释放/取回/插入均不改它
        //（recycle.ts LiveWindowState 不变量）。
        if (el.scrollTop !== prevTop) return; // 加载期间用户滚动，放弃补偿
        await nextTick();
        // 视口补偿：新页插在顶部，scrollTop 同步下移 = 看到的旧内容位置不变
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
        mountedCount.value = Math.max(mountedCount.value, rows.value.length);
        trail("expand", `${Math.round(prevTop)}→${Math.round(el.scrollTop)} n=${rows.value.length}`);
      }
    } finally {
      loadingOlder.value = false;
      scheduleSettle(); // 翻页后复查：远端页可能已超预算该释放
      // 加载在途时用户已在顶部滚过（topPending）且完成后仍停留触发带：
      // 自动续取（连翻），直到用户离开顶部 / 磁盘取完。
      const e = scrollEl.value;
      if (e && topPending && e.scrollTop < expandThreshold(e)) {
        topPending = false;
        void expandOlderAnchored();
      }
    }
  }

  // ── 滚轮接管 ──────────────────────────────────────────────────────────────
  // 根因（见 [[nested-scroller-wheel-trap]]，两份 scroll-trail 现场 + 探针复活定案）：
  // 合成器滚轮路径把 maxScrollOffset 焊死在内容首次溢出视口那一刻的值，之后内容
  // 增长不刷新；JS 的 scrollTop 赋值走主线程布局读实时 scrollHeight，畅通。所以把
  // 滚轮也赶到 JS 赋值路径：光标下最近可滚祖先就是本容器时（该滚对话区、无嵌套块
  // 需要原生滚），preventDefault + 手动 scrollTop += deltaY，彻底旁路缓存。
  // 取舍：失去 Chromium 合成器滚轮惯性/平滑——聊天滚动不需要。
  //
  // 嵌套可滚块分支（思考块 reading 态、工具卡结果、xterm、DiffViewer 的 cm-scroller）：
  // nearestScrollableAncestor 返回嵌套块而非本容器。原实现直接放行原生、指望链式冒泡
  // 给对话区——但合成器焊死会让链式失同步，嵌套块滚到顶/底后对话区仍滚不动，长会话里
  // 光标落在工具卡/代码块上时表现为"滚不到顶、只看得到尾部、上滚加载更多不触发"。
  // 修正：嵌套块已到该方向边界（atScrollEdge）时接管对话区走 JS 赋值，补上这条漏掉的
  // 链式分支；未到边界则放行原生滚嵌套块本身。
  // deltaMode 非 pixel（触控板 line/page 模式）暂放行原生——鼠标 wheel 是 pixel 模式，覆盖最常见情况。
  function onWheel(e: WheelEvent) {
    const el = scrollEl.value;
    if (!el || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
    const nearest = nearestScrollableAncestor(e.target);
    if (nearest === el) {
      e.preventDefault();
      userTookScroll();
      el.scrollTop += e.deltaY;
      trail("wheelTakeover", `dy=${Math.round(e.deltaY)}→top=${Math.round(el.scrollTop)}`);
      return;
    }
    if (nearest && atScrollEdge(nearest, e.deltaY)) {
      e.preventDefault();
      userTookScroll();
      el.scrollTop += e.deltaY;
      trail("wheelTakeover", `chained dy=${Math.round(e.deltaY)}→top=${Math.round(el.scrollTop)}`);
    }
  }

  // ── 滚动事件 ──────────────────────────────────────────────────────────────
  // 「用户离开底部」唯一可靠的信号是 scrollTop 减小——不能按事件到达时的活几何
  // dist≥48 判定：程序化置底（scrollToBottom / ramp pin / jumpToBottom）的 scroll
  // 事件是异步派发的，写入与事件到达之间内容会继续增高（Write/Edit 变更卡落定一帧
  // +400px），事件里算出的 dist≥48 只是「置底回波」而非用户手势。按 dist 误判会把
  // 跟随打死且 sticky——此后 scrollToBottom 对 autoScroll=false 一律 no-op、再无
  // 置底救回。位置不变/增大 = 增长回波或下滚，跟随态原样保留；位置减小才按 dist 重判。
  let prevScrollTop = -1;
  function onScroll() {
    const el = scrollEl.value;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const prev = prevScrollTop;
    prevScrollTop = el.scrollTop;
    trail(
      "scroll",
      `top=${Math.round(el.scrollTop)} sh=${el.scrollHeight} ch=${el.clientHeight} auto=${autoScroll.value ? 1 : 0}`,
    );
    // 锚定 ramp 期间跳过两个自动分支：锚定写入在帧间会让 scrollTop 回落（底部钳制
    // → 锚点落位）——按「用户上滚」处理会让 ramp 第一帧就自毁成全量挂载；钳底帧的
    // dist<48 也会把 autoScroll 误刷成 true 让 RO 置底与锚定互相打架。接管保留两条
    // 独立通道：onWheel（userTookScroll 直调）与 rampPin 的落点偏差检测（滚条拖动）。
    const anchoring = ramping.value && rampPin.kind === "anchor";
    if (prev >= 0 && el.scrollTop < prev - 1 && !anchoring) {
      // 向上滚动：用户接管（ramp 停 + 数据全量 + 脱离跟随），再按实时离底距离重判跟随态
      userTookScroll();
      autoScroll.value = dist < 48;
    } else if (prev >= 0 && dist < 48 && !anchoring) {
      // 到达/停在底部：恢复跟随（下滚到底、jump 落定、钳位回底都走这里）。
      // prev >= 0 挡掉切会话后首个残留 scroll 事件（基线未建立时的旧位置回波）——
      // 它会把恢复分支刚置 false 的 autoScroll 误刷成 true，位置随即被 toBottom 拉走。
      autoScroll.value = true;
    }
    farFromBottom.value = dist > JUMP_SHOW_THRESHOLD;
    if (autoScroll.value) newWhileAway.value = false;
    // 上滚到触发带 = 想看更早的内容：取回一页（带视口补偿）。ramp 期间不触发。
    const canFetch = !ramping.value && !restoring.value && (pagination?.hasMore() ?? false);
    if (el.scrollTop < expandThreshold(el) && canFetch) {
      trail("tryExpand", `hit top=${Math.round(el.scrollTop)} hm=${pagination?.hasMore() ?? false} ramp=${ramping.value ? 1 : 0}`);
      if (loadingOlder.value) {
        // 加载在途：用户已在顶部滚过——记 pending，完成后自动续取（连翻）
        topPending = true;
      } else {
        void expandOlderAnchored();
      }
    } else if (el.scrollTop < expandThreshold(el) && !canFetch) {
      trail("tryExpand", `blocked top=${Math.round(el.scrollTop)} hm=${pagination?.hasMore() ?? false} ramp=${ramping.value ? 1 : 0}`);
    } else {
      topPending = false; // 离开顶部触发带：取消待续
    }
    scheduleSettle(); // 滚动停驻后结算回收/取回
  }

  // ── 置底 ──────────────────────────────────────────────────────────────────
  // 按帧节流：读 scrollHeight 会强制整个消息容器同步布局（成本 ∝ 已挂 DOM 体积），
  // 流式/ramp 期间每个增量都触发的话会压垮 UI 线程。合并到每帧至多一次；rAF 回调
  // 晚于 Vue 的微任务渲染批次，天然拿到更新后的 DOM。
  let scrollQueued = false;
  // 置底帧代际：每次切会话 +1，为上一状态排队的置底帧作废——不仅防跨会话污染
  // （旧会话的置底落在新会话上），也防同会话切回后冲掉锚定 ramp 刚写好的位置。
  let toBottomGeneration = 0;
  function scrollToBottom() {
    if (!autoScroll.value || scrollQueued) return;
    scrollQueued = true;
    const gen = toBottomGeneration;
    scheduleFrame(() => {
      scrollQueued = false;
      if (gen !== toBottomGeneration) return;
      const el = scrollEl.value;
      if (el) {
        trail("write", `toBottom ${Math.round(el.scrollTop)}→${el.scrollHeight}`);
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  // 新消息/流式增量到达：钉底时 live 窗口滑到尾窗（挂载 live 行数恒 ≤ K，DOM
  // 有界）。滑动量以 DOM 实测为准（挂载尾 − K）：真 append 时挂载尾 +1 → 滑 1；
  // 无台账 prepend（上翻把更早消息并进 live 段头部）不触发——那批行的平移由
  // expandOlderAnchored 显式 +count 负责，两套机制对同一事件只走一条。滑出行
  // 此刻仍挂载（watcher 在渲染前跑），实测其高折入隐藏区总高，总高守恒；
  // 非钉底=用户在 live 区阅读，不滑动、不偷位置。上翻阅读中点亮「回到底部」
  // 圆点；置底交给 scrollToBottom（autoScroll=false 时 no-op）。
  function onNewContent() {
    const sid = sessionId();
    if (sid && autoScroll.value) {
      const win = liveWindows.get(sid);
      const els = contentEl.value?.querySelectorAll<HTMLElement>(".chat-row-live") ?? [];
      const overflow = els.length - LIVE_TAIL_ROWS;
      if (win && overflow > 0) {
        let add = 0;
        for (let i = 0; i < overflow; i++) {
          // 零高（面板隐藏/未布局）回退估算，防 hiddenPx 漏记（同 measureRowHeights 惯例）
          const h = Math.round(els[i].getBoundingClientRect().height);
          add += h > 0 ? h : ESTIMATE_MESSAGE_HEIGHT_PX;
        }
        liveWindows.set(sid, { hiddenCount: win.hiddenCount + overflow, hiddenPx: win.hiddenPx + add });
      }
    }
    if (!autoScroll.value) newWhileAway.value = true;
    scrollToBottom();
  }

  // ⚠️ 必须 watch live 段长度而非 messages.length：页级回收的释放（变少）与
  // 骨架取回（变多）都动 messages.length，watch 它会把「骨架取回」误报成
  // 「新消息到达」点亮圆点、把「释放」误报成内容变化。live 段（流式追加区）
  // 的长度只被真实新内容推动。
  watch(() => liveMessageCount(sessionId() ?? "", messages().length), onNewContent);
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
  // 点击即接管：ramp 在途时先落定（停 ramp + 全量挂载），否则后续每帧锚定写入
  // 会与平滑滚动互相扯。
  function jumpToBottom() {
    const el = scrollEl.value;
    if (!el) return;
    if (ramping.value) userTookScroll();
    trail("write", `jump smooth from=${Math.round(el.scrollTop)}`);
    newWhileAway.value = false;
    farFromBottom.value = false;
    autoScroll.value = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // ── 置底的统一触发器：数据层 watcher 只能枚举「新消息 / 文本增量」，但让滚动条
  //    搁浅的来源远不止这些——内容增高（变更卡 DiffViewer 到达、图片异步加载、历史
  //    扩窗……）与视口变化（权限对话框出现/消失、Pane 拖拽、窗口缩放）。枚举数据必然
  //    挂一漏万，改为在 DOM 层观察这两个症状本身。RO 通知按帧合并；autoScroll=false
  //    时 scrollToBottom 自身 no-op；置底只写 scrollTop 不改两者尺寸，无反馈循环。
  //    骨架与真实页同高（释放时实测撑住），骨架替换不触发净高度变化、不扰钉底。
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

  // 切会话：取消旧 ramp、复位滚动态、按需 ramp。immediate——首次打开也走分帧。
  watch(
    sessionId,
    (newId, oldId) => {
      trail("session", newId ?? "null"); // 切会话标记：定格「自愈」的分界线
      // 离开的会话：记录位置 + 离底距离（watch 在渲染前执行，scrollEl 还是旧 DOM，
      // 读数准确）+ 内容锚点（视口顶所在行，见 ScrollMemory.anchor——后台 evict 收缩
      // 下 distBottom 会系统性偏上，锚点是修复）。切回时锚定恢复——否则每次切回都被
      // 强制钉底（2026-08-26 用户实锤「一下从切换前的位置被拖回底部」）。
      if (oldId && scrollEl.value) {
        scrollPositions.set(oldId, {
          top: scrollEl.value.scrollTop,
          distBottom: scrollEl.value.scrollHeight - scrollEl.value.scrollTop,
          anchor: measureViewportAnchor() ?? undefined,
        });
        // 切走收尾（读旧 DOM，必须在本 watcher 里、渲染前）：live 窗口收拢 +
        // 已加载页收紧——切走后会话 DOM 只剩骨架 + liveskel + 尾窗（见
        // collapseAndTightenForSwitchAway）。
        collapseAndTightenForSwitchAway(oldId);
      }
      cancelRamp();
      rampPending = false;
      rampPendingPin = null;
      toBottomGeneration++; // 旧会话排队中的置底帧全部作废
      topPending = false; // 旧会话的「顶部待续」不带进新会话
      if (settleTimer) {
        clearTimeout(settleTimer); // 旧会话的待结算不带进新会话
        settleTimer = null;
      }
      // 方向判定基线一并重置：旧会话残留的大 scrollTop 会把新会话首个
      // scroll 事件误判成「上跳」而脱扣
      prevScrollTop = -1;
      farFromBottom.value = false;
      newWhileAway.value = false;
      if (!newId) return; // hero（零会话）：不 ramp
      // 切入保障：live 段超窗而未收拢（重开/后台增长）→ 滑到尾窗，切回零尖峰
      slideLiveWindowToTail(newId);
      const saved = scrollPositions.get(newId);
      if (saved === undefined) {
        // 首次打开（无位置记忆）：钉底看最新 + 分帧挂载
        autoScroll.value = true;
        scrollToBottom();
        if (messages().length > 0) startRamp();
        else {
          rampPending = true; // 未 hydrate：等 messages 到齐
          rampPendingPin = null;
        }
        return;
      }
      // 切回已有记忆：同一条分帧通道，落点策略「锚行优先、distBottom 兜底」。首帧
      // 只挂 rampInitial 行（不再一次性全量挂载——切回长会话的巨型同步 patch 是
      // 输入框流光掉帧的元凶），锚行挂入前钳底，挂入后视口跟随锚行，收尾
      // finishRamp 双帧校准 + 近底恢复跟随（原 restore 语义原样收编）。
      autoScroll.value = false;
      if (messages().length > 0) {
        startRamp({ kind: "anchor", distBottom: saved.distBottom, anchor: saved.anchor });
      } else {
        rampPending = true; // 切回时会话还没 hydrate：等 messages 到齐再锚定 ramp
        rampPendingPin = { kind: "anchor", distBottom: saved.distBottom, anchor: saved.anchor };
      }
    },
    { immediate: true },
  );

  // hydrate 补交：切到未加载会话时挂起的 ramp，在 messages 0→N 那一下触发。
  // pre-flush 保证那一帧渲染前 mountedCount 已重置回首帧预算。rampPending 仅 0→N
  // 触发一次，流式逐条追加（n 持续增）不重复 ramp。落点策略随挂起时的入口
  // （首开=bottom / 切回=anchor）。live 窗口在此补收拢：切入时消息未到（窗口被
  // 清）→ 到齐后按尾窗重收拢，distBottom 落点在总高守恒下恢复精确。
  watch(
    () => messages().length,
    (n) => {
      if (rampPending && n > 0) {
        rampPending = false;
        const pin = rampPendingPin ?? { kind: "bottom" as const };
        rampPendingPin = null;
        const sid = sessionId();
        if (sid) slideLiveWindowToTail(sid);
        startRamp(pin);
      }
    },
  );

  // ── 清理 ──────────────────────────────────────────────────────────────────
  // 仓库首次用 onScopeDispose：测试在 effect scope 外直接调 composable 时不注册，
  // 避免无 active scope 时抛错。组件场景下随实例卸载回收 rAF + RO。
  function cleanup() {
    cancelRamp();
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    contentObserver?.disconnect();
    contentObserver = null;
  }
  if (getCurrentScope()) onScopeDispose(cleanup);

  return {
    scrollEl,
    contentEl,
    visibleRows,
    ramping,
    restoring,
    onScroll,
    jumpToBottom,
    farFromBottom,
    newWhileAway,
    expandOlderAnchored,
    restoreAnchored,
    expandLiveAnchored,
  };
}

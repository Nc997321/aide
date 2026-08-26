import { computed, getCurrentInstance, getCurrentScope, nextTick, onMounted, onScopeDispose, onUnmounted, ref, watch } from "vue";
import type { ComputedRef } from "vue";
import { trail } from "../utils/diagnostics/scrollTrail";
import type { ChatMessage, TextBlock } from "@/types/chat";

/**
 * 聊天滚动区主控（微信式无限滚动，2026-08-26 重构）：
 * - 数据层：已加载消息全部渲染（messages 即 DOM），不窗口化、不回收——
 *   内存/DOM = 用户实际翻的量，超出由 store 的 maybeEvict（大 block 降级）兜底；
 * - 上滚到顶部触发带 → loadOlder 取更早一页 unshift 头部 + 视口补偿
 *   （scrollTop += 高度差，看到的旧内容不跳）；
 * - 加载在途时顶部停留 → topPending → 完成后自动续取（连翻不中断）；
 * - 切会话首帧渲染预算（mountedCount 6 → 全量，每帧 +40）防首帧 jam。
 *
 * 为什么删掉窗口层：tailWindow/字节预算/页折叠/释放恢复都是「微博式滚走释放」
 * 的复杂度——聊天要随时回滚看旧内容，微博式不适用；「按页加载」本身已经
 * 保证打开不全量（hydrate 一页），窗口化再无必要。
 */

export interface ChatScrollOptions {
  /** 每次取回更早页的字节预算（loadOlder 的 limit）。默认 256KB。 */
  pageBytes?: number;
  /** 首帧渲染预算起点：切会话首帧只挂这么多条。默认 6。 */
  rampInitial?: number;
  /** 每帧追加条数。默认 40。 */
  rampChunk?: number;
  /** P1 双向分页：由上层（ChatPanel）绑定当前会话注入。缺省 = 无后端取回。 */
  pagination?: ChatScrollPagination;
  /** 可注入的帧调度器：返回一个 cancel 函数。默认 requestAnimationFrame；
   * 测试传同步调度器（vitest 是 node 环境，无 rAF）。scrollToBottom 与 ramp
   * 共用同一调度器。 */
  scheduleFrame?: (cb: () => void) => () => void;
}

/** P1 双向分页接口（最简单形态）：上滚到顶部触发带 → loadOlder 取更早一页。
 *  不回收、无恢复——内存由 store 的 maybeEvict（大 block 降级）兜底。 */
export interface ChatScrollPagination {
  /** 磁盘上还有更早页可取。 */
  hasMore: () => boolean;
  /** 取回更早一页（limit 为字节预算，见 load_messages），返回实际条数。 */
  loadOlder: (limit: number) => Promise<number>;
}

const DEFAULT_PAGE_BYTES = 256 * 1024;
const DEFAULT_RAMP_INITIAL = 6;
const DEFAULT_RAMP_CHUNK = 40;

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

  // ── 首帧渲染预算（唯一一层窗口化：防切会话一次性挂载 jam）──────────────
  // 数据层不窗口化（已加载全部渲染）；这里只控制「首帧挂多少」再逐帧补到全量。
  const mountedCount = ref(rampInitial);
  /** 会话滚动位置记忆（sid → scrollTop）：切走记录、切回恢复。切回钉底只用于
   *  首次打开（无记忆）；组件级 Map——会话切换组件常驻，位置随会话保留，
   *  组件重建（关 tab 重开）后自然为空，回落首帧钉底行为。 */
  const scrollPositions = new Map<string, number>();
  /** 进 v-for 的实际列表：messages 尾部 mountedCount 条（首帧 ramp 渐进，之后全量）。 */
  const visibleMessages: ComputedRef<readonly ChatMessage[]> = computed(() => {
    const list = messages();
    return list.length <= mountedCount.value ? list : list.slice(-mountedCount.value);
  });

  const ramping = ref(false);
  /** 切过去时会话还没 hydrate（messages 为空）→ 挂起等 messages 到齐再 ramp。 */
  let rampPending = false;
  /** ramp 在途帧句柄（cancel 函数；null=空闲）。 */
  let rafHandle: (() => void) | null = null;

  function cancelRamp() {
    if (rafHandle) {
      rafHandle();
      rafHandle = null;
    }
    ramping.value = false;
  }

  /** 用户滚动接管：ramp 即停、已加载数据全量挂载（防中间段缺失）、脱离自动跟随。
   *  滚轮接管（onWheel）与原生上滚（onScroll 上滚分支）共用。根因：ramp 每帧
   *  pin 到底 + pin 的 scroll 回波把 autoScroll 刷回 true，用户的滚轮增量被逐帧
   *  吞掉——切回会话（autoScroll=true + startRamp）后滚轮一直钉在底部，live 会话
   *  （target 持续增长）ramp 永不结束则永远钉底（2026-08-26 用户实锤）。 */
  function userTookScroll() {
    cancelRamp();
    autoScroll.value = false;
    mountedCount.value = Math.max(mountedCount.value, messages().length);
  }

  function startRamp() {
    cancelRamp();
    ramping.value = true;
    mountedCount.value = rampInitial;
    // 首帧同步置底：ramp 每帧加内容后，RO 触发的 scrollToBottom 落在下一帧 rAF，
    // 本帧会用上一帧的 scrollTop 渲染造成一帧抖动；这里在调度下一 tick 前同步把
    // scrollTop 钉到底，覆盖上一帧残留。
    if (scrollEl.value && autoScroll.value) {
      trail("write", "ramp pin0");
      scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
    function tick() {
      if (!ramping.value) return; // 被切走 / 用户上滚接管取消
      const target = messages().length;
      const next = Math.min(target, mountedCount.value + rampChunk);
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

  /** 向上加载更早一页 + 视口补偿（scrollTop 保持旧内容位置不跳）。
   *  mountedCount 一并到顶（= 新 messages 长度）：新页立即全部挂载
   *  （一页几十条，一次性挂载可接受；首帧 ramp 只服务于切会话首帧）。 */
  async function expandOlderAnchored() {
    const el = scrollEl.value;
    if (!el || loadingOlder.value || !(pagination?.hasMore() ?? false)) return;
    loadingOlder.value = true;
    try {
      cancelRamp(); // 用户接管，停掉自动 ramp
      const prevHeight = el.scrollHeight;
      const prevTop = el.scrollTop;
      const count = await pagination!.loadOlder(pageBytes);
      if (count > 0) {
        if (el.scrollTop !== prevTop) return; // 加载期间用户滚动，放弃补偿
        await nextTick();
        // 视口补偿：新页插在顶部，scrollTop 同步下移 = 看到的旧内容位置不变
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
        mountedCount.value = Math.max(mountedCount.value, messages().length);
        trail("expand", `${Math.round(prevTop)}→${Math.round(el.scrollTop)} n=${messages().length}`);
      }
    } finally {
      loadingOlder.value = false;
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
    if (prev >= 0 && el.scrollTop < prev - 1) {
      // 向上滚动：用户接管（ramp 停 + 数据全量 + 脱离跟随），再按实时离底距离重判跟随态
      userTookScroll();
      autoScroll.value = dist < 48;
    } else if (prev >= 0 && dist < 48) {
      // 到达/停在底部：恢复跟随（下滚到底、jump 落定、钳位回底都走这里）。
      // prev >= 0 挡掉切会话后首个残留 scroll 事件（基线未建立时的旧位置回波）——
      // 它会把恢复分支刚置 false 的 autoScroll 误刷回 true，位置随即被 toBottom 拉走。
      autoScroll.value = true;
    }
    farFromBottom.value = dist > JUMP_SHOW_THRESHOLD;
    if (autoScroll.value) newWhileAway.value = false;
    // 上滚到触发带 = 想看更早的内容：取回一页（带视口补偿）。ramp 期间不触发。
    const canFetch = !ramping.value && (pagination?.hasMore() ?? false);
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
  //    挂一漏万，改为在 DOM 层观察这两个症状本身。RO 通知按帧合并；autoScroll=false
  //    时 scrollToBottom 自身 no-op；置底只写 scrollTop 不改两者尺寸，无反馈循环。
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
      // 离开的会话：记录当前位置（watch 在渲染前执行，scrollEl 还是旧 DOM，读数准确）。
      // 切回时恢复——否则每次切回都被强制钉底（2026-08-26 用户实锤「一下从切换
      // 前的位置被拖回底部」）。
      if (oldId && scrollEl.value) scrollPositions.set(oldId, scrollEl.value.scrollTop);
      cancelRamp();
      rampPending = false;
      topPending = false; // 旧会话的「顶部待续」不带进新会话
      // 方向判定基线一并重置：旧会话残留的大 scrollTop 会把新会话首个
      // scroll 事件误判成「上跳」而脱扣
      prevScrollTop = -1;
      farFromBottom.value = false;
      newWhileAway.value = false;
      if (!newId) return; // hero（零会话）：不 ramp
      const saved = scrollPositions.get(newId);
      if (saved === undefined) {
        // 首次打开（无位置记忆）：钉底看最新 + 分帧挂载
        autoScroll.value = true;
        scrollToBottom();
        if (messages().length > 0) startRamp();
        else rampPending = true; // 未 hydrate：等 messages 到齐
        return;
      }
      // 切回已有记忆：全量挂载（ramp 逐帧 pin 底会破坏位置）+ 恢复离开时的滚动位置。
      // 双帧恢复：第一帧设 scrollTop（内容可能尚未渲染完，scrollHeight 未就绪时会被
      // clamp/误判）；第二帧（内容渲染完成、布局就绪）重新校准位置，恢复点在底部
      // 附近（≤48px）才重新进入跟随——否则残留 scroll 事件把 autoScroll 误刷成 true
      // 后，随后的 toBottom 会把位置拉回底部（2026-08-26 trail 实锤
      // `restore 1437 → scroll auto=1 → toBottom 2854`）。
      autoScroll.value = false;
      mountedCount.value = Math.max(mountedCount.value, messages().length);
      scheduleFrame(() => {
        const el = scrollEl.value;
        if (!el) return;
        el.scrollTop = saved;
        scheduleFrame(() => {
          const el2 = scrollEl.value;
          if (!el2) return;
          el2.scrollTop = saved;
          trail("write", `restore ${saved}`);
          if (el2.scrollHeight - el2.scrollTop - el2.clientHeight < 48) autoScroll.value = true;
        });
      });
    },
    { immediate: true },
  );

  // hydrate 补交：切到未加载会话时挂起的 ramp，在 messages 0→N 那一下触发。
  // pre-flush 保证那一帧渲染前 mountedCount 已重置回首帧预算。rampPending 仅 0→N
  // 触发一次，流式逐条追加（n 持续增）不重复 ramp。
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
    ramping,
    onScroll,
    jumpToBottom,
    farFromBottom,
    newWhileAway,
    expandOlderAnchored,
  };
}

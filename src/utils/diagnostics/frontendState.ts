/**
 * 冻结现场状态读数：报告里「那 8 秒在渲染什么」的答案。
 *
 * 为什么要有它（2026-09-17 取证复盘）：此前所有前端探针都是**计量表**——longtask
 * 给时长、LoAF 给归因、面包屑给用户动作，但没有一个数说得出定格那一刻**挂了多少
 * 东西**：渲染行数、store 消息数、内容区 DOM 节点数、隐藏了多少 live 行。于是
 * 「8 秒卡死」只能靠 CPU 采样和推理，缺一块最直接的现场。
 *
 * 注册表按 sid 挂（一个窗口可以同时开着多个聊天面板）：冻结的肇事者是**挂得最多
 * 的那个**，所以 `readGauges` 取 domNodes 最大者，`panels` 记注册数——「一个面板
 * 都没注册」与「注册了但读数是 0」是两种完全不同的结论，报告必须分得开。
 *
 * 采集成本是硬约束：这些读数在心跳（500ms）里采，**采样本身不能成为被测对象**
 * （黑匣子的老毛病：探针把被测对象改变）。所以这里只做长度读取与一次受控的 DOM
 * 计数——绝不读几何（rect/scrollHeight 会强制布局）。
 */

/** 一块面板自报的现场读数。 */
export interface FrontendGauges {
  /** 活动会话 id（切会话后报告要对得上号） */
  sessionId: string;
  /** 渲染行数（行模型的长度，≠ 消息数：页骨架/占位行也算行） */
  rows: number;
  /** store 消息数 */
  messages: number;
  /** 内容区节点数：`contentEl.getElementsByTagName("*").length`。
   *  **采样值**：每 4 拍真读一次，其余拍返回上次读数（见 countDomNodes 的实测）。 */
  domNodes: number;
  /** JS 堆占用（MB）：Chromium 专有的 `performance.memory`，取不到给 0 */
  jsHeapMb: number;
  /** 切入落点写入中（原 ramping）：期间结构操作让路、DOM 正在被重排 */
  landing: boolean;
  /** liveskel 隐藏条数 >0 = live 段被窗口化的长会话（冻结的常见背景） */
  liveHidden: number;
  /** 注册中的聊天面板数（读数为 0 时用它区分「没挂面板」与「挂了没量到」） */
  panels: number;
}

/** 面板自报的部分（`panels` 由注册表算出，不由面板自报）。 */
export type PanelGauges = Omit<FrontendGauges, "panels">;

/** 无面板注册时的安全默认值。字段一个不少——读报告的人不该按「字段缺不缺」分支。 */
const EMPTY_GAUGES: PanelGauges = {
  sessionId: "",
  rows: 0,
  messages: 0,
  domNodes: 0,
  jsHeapMb: 0,
  landing: false,
  liveHidden: 0,
};

/** 每 N 拍真读一次 DOM 节点数。 */
const DOM_COUNT_EVERY = 4;

const providers = new Map<string, () => PanelGauges>();
/** 每个元素一份计数节拍（WeakMap：元素没了就随之回收，不留引用）。 */
const domCounts = new WeakMap<Element, { tick: number; count: number }>();

/** 注册一块面板的读数（由 useChatScroll 在挂载时调用；同 sid 重复注册即覆盖）。 */
export function setGaugeProvider(sid: string, fn: () => PanelGauges): void {
  providers.set(sid, fn);
}

/** 注销（面板卸载 / 该面板切走了会话）。 */
export function clearGaugeProvider(sid: string): void {
  providers.delete(sid);
}

/** 内容区节点数。**不能每拍都数**：真机实测（headless Edge 153）变更后的首次读取
 *  40000 节点 3.1ms / 120000 节点 13.8ms / 300000 节点 27.5ms（DOM 没动时 Blink 命中
 *  计数缓存 → 0ms，但流式/回收期间的 DOM 每拍都在变，缓存必失效）。心跳本身就在被
 *  测的渲染主线程上发，每拍 10ms 级的采样会把探针变成被测对象的一部分——故 4 拍
 *  （≈2s）真读一次，其余拍复用上次读数：量级指标，陈旧 2s 无妨。 */
export function countDomNodes(el: Element | null | undefined): number {
  if (!el) return 0;
  const prev = domCounts.get(el);
  const tick = (prev?.tick ?? 0) + 1;
  if (prev && tick % DOM_COUNT_EVERY !== 0) {
    domCounts.set(el, { tick, count: prev.count });
    return prev.count;
  }
  const count = el.getElementsByTagName("*").length;
  domCounts.set(el, { tick, count });
  return count;
}

/** JS 堆占用（MB）。`performance.memory` 是 Chromium 专有、lib.dom 无类型 →
 *  按 unknown 收窄；取不到（非 Chromium / 未开精确内存）一律给 0。 */
export function readJsHeapMb(): number {
  if (typeof performance === "undefined") return 0;
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: unknown } };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" && Number.isFinite(used) ? Math.round(used / (1024 * 1024)) : 0;
}

/** 一块面板读数抛错不能连坐整个现场：跳过坏的，其余照常比较。 */
function safeRead(fn: () => PanelGauges): PanelGauges | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** 取本次现场读数：**domNodes 最大的那块面板**（冻结的肇事者是挂得最多的那个），
 *  `panels` 始终是注册数。一个面板都没有时返回全 0 的安全默认值。 */
export function readGauges(): FrontendGauges {
  let worst: PanelGauges | null = null;
  for (const fn of providers.values()) {
    const g = safeRead(fn);
    if (g && (!worst || g.domNodes > worst.domNodes)) worst = g;
  }
  return { ...(worst ?? EMPTY_GAUGES), panels: providers.size };
}

/** 测试辅助：清空注册表与计数缓存（模块状态跨用例残留会让「谁最大」难判）。 */
export function resetGaugeProvidersForTest(): void {
  providers.clear();
}

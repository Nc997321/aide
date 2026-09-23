/**
 * `browser_tab` 的编排：**tab 级**动作（开 / 关 / 导航 / 前进后退 / 推到前台）。
 *
 * # 为什么要有这一层
 *
 * 在这之前 agent 拿不到自己的 tab：面板上的视图全由用户手工开，三个 tab 挂同一个 dev server 时
 * URL 与标题一模一样，agent 只能靠"用户恰好把它切到了前台"来对号。`open` 把这件事变成确定的——
 * 它返回 `view_id`，agent 自己记着，之后每个调用都显式带上。
 *
 * # 两条纪律
 *
 * 1. **缺必填参数在本地就失败**（`buildTabCall` 抛）：桥对面是桌面 Rust，发出去才发现参数不对
 *    要等 15s 超时，而超时文案会把"你少给了 url"伪装成"浏览器卡了"。
 * 2. **不静默降级**：桥怎么答就怎么说。`focus` 尤其要说清它是**请求**——面板收到事件才切，
 *    这里只保证请求发出去了。
 * 3. **navigate 回报观测到的落点**：命令回包里的 `nav.url` 由 `begin_nav` 写成**请求值**，
 *    拿它当事实就是本模块要消灭的那类假成功（hash 被路由守卫弹回时会说"已到新地址"）。
 *    所以多花一次求值把 `location.href` 读回来，两者不一致时**两边都给出来**。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser, type BrowserCall } from "../browserClient.js";
import { runEval } from "./runEval.js";
import { formatBridgeFailure, str } from "./format.js";

export type TabAction = "open" | "close" | "navigate" | "back" | "forward" | "focus";

export interface TabArgs {
  /** `open` / `navigate` 必填。 */
  url?: string;
  /** 仅 `open`：标签页上的短名（页面标题出来之前用它）。 */
  label?: string;
  /** 目标视图；缺省由 Rust 侧按"全库恰好一个视图"解析，多视图时它明确报错。 */
  viewId?: string;
}

/** action → 桥载荷（**纯函数**，可单测）。 */
export function buildTabCall(action: TabAction, args: TabArgs): BrowserCall {
  switch (action) {
    case "open": {
      if (!args.url) throw new Error('action="open" needs a url');
      return args.label
        ? { op: "open", url: args.url, label: args.label }
        : { op: "open", url: args.url };
    }
    case "navigate": {
      if (!args.url) throw new Error('action="navigate" needs a url');
      return args.viewId
        ? { op: "navigate", view_id: args.viewId, url: args.url }
        : { op: "navigate", url: args.url };
    }
    case "close":
      return withView({ op: "close" }, args);
    case "back":
      return withView({ op: "back" }, args);
    case "forward":
      return withView({ op: "forward" }, args);
    case "focus":
      return withView({ op: "focus" }, args);
  }
}

/** `view_id` 只在给了的时候出现——载荷里带个 `undefined` 会让 Rust 侧解析多一层判断。 */
function withView(
  base: { op: "close" | "back" | "forward" | "focus" },
  args: TabArgs,
): BrowserCall {
  return args.viewId ? { ...base, view_id: args.viewId } : base;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 视图的一句话描述：`browser-3 "dev" http://… — Vite App`。 */
function describeView(view: Record<string, unknown>): string {
  const id = String(view["id"] ?? "?");
  const label = typeof view["label"] === "string" ? ` "${view["label"]}"` : "";
  const nav = asRecord(view["nav"]) ?? {};
  const url = typeof nav["url"] === "string" ? ` ${nav["url"]}` : "";
  const title = typeof nav["title"] === "string" && nav["title"] ? ` — ${nav["title"]}` : "";
  return `${id}${label}${url}${title}`;
}

/**
 * navigate 的三种结局：观测值与请求值**一致** / **不一致** / **读不到**。
 *
 * 这一支承载着反馈第 1 条的教训：`begin_nav` 写进回包的 `nav.url` 是**请求值**，因此
 * "已导航到 X"这句在回包单独存在时**无从核实**；`observed` 才是事实。
 */
function renderNavigate(
  d: Record<string, unknown>,
  view: Record<string, unknown> | null,
  observed?: { url?: string; error?: string },
): string {
  const where = view ? describeView(view) : String(d["view_id"] ?? "?");
  const want = view ? str(asRecord(view["nav"])?.["url"]) : "";
  // 没观测到 = 没确认：**不许用完成时断言导航已经发生**（那正是本任务要消灭的形态），
  // 退回请求值 + 明说读不到 + 给出核实手段。
  if (!observed?.url) {
    return (
      `Asked view ${where} to navigate to ${want || "(unknown url)"}; the landing URL could not be read` +
      `${observed?.error ? `: ${observed.error}` : ""}. ` +
      `Use browser_eval \`location.href\` to confirm where the page actually ended up.`
    );
  }
  if (observed.url === want) {
    return `Navigated view ${where} — the document confirms it is at ${observed.url}.`;
  }
  return (
    `Requested ${want || "(unknown url)"} for view ${String(d["view_id"] ?? "?")}, but the document reports ` +
    `${observed.url} instead. Two causes look the same here: the navigation had not committed yet, or the page ` +
    `redirected / a router guard bounced it back. Re-read with browser_eval \`location.href\`, or wait for the ` +
    `content you expect with browser_wait \`until:"condition"\`.`
  );
}

/** 回包 → 面向模型的文本。**如实说清"这是什么状态 + 下一步做什么"**。 */
export function renderTabResult(
  action: TabAction,
  data: unknown,
  observed?: { url?: string; error?: string },
): string {
  const d = asRecord(data) ?? {};
  const view = asRecord(d["view"]);
  switch (action) {
    case "open": {
      const id = String(d["view_id"] ?? "?");
      const where = view ? describeView(view) : id;
      return (
        `Opened view ${where}.\n\n` +
        `It is PARKED: the page runs in the background (rendering, timers and screenshots all ` +
        `work) and the user's panel was not disturbed. Pass view_id "${id}" to the other browser ` +
        `tools — with several views open they require it.`
      );
    }
    case "close":
      return `Closed view ${String(d["view_id"] ?? "?")}.`;
    case "navigate":
      return renderNavigate(d, view, observed);
    case "back":
    case "forward":
      if (!view) return `View ${String(d["view_id"] ?? "?")} moved ${action}.`;
      return (
        `View ${describeView(view)} is now at the ${action === "back" ? "previous" : "next"} ` +
        `history entry (can-go-back: ${view["can_go_back"] === true}, ` +
        `can-go-forward: ${view["can_go_forward"] === true}).`
      );
    case "focus":
      return (
        `Asked the panel to show view ${String(d["view_id"] ?? "?")}. ` +
        `The UI performs the switch — this is a request, not a guarantee.`
      );
  }
}

/**
 * 导航后让页面起跳（或让守卫把 hash 弹回）的一小段固定等待。
 *
 * ⚠️ **不能省**：WebView2 的 `Navigate()` 是**异步投递**，命令一返回立刻读 `location.href`
 * 多半读到**旧文档**——那会让每一次正常的跨文档导航都报"落点不符"，把真信号淹掉。
 * 取值依据见实现计划 Task 2 Step 5 的实测（spec 修法 (b) 的往返代价）。
 */
export const NAV_SETTLE_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 读一次页面**实际**所在的位置。**永不抛**：失败折成 `{error}` 由渲染层如实带出。
 * `viewId` 用 navigate 回包里的**已解析 id**（不是调用方给的原始参数），多视图下才指得准。
 */
async function readLandingUrl(
  viewId: string | undefined,
  emit: (e: ChatEvent) => void,
): Promise<{ url?: string; error?: string }> {
  const r = await runEval("location.href", { viewId }, emit);
  if (!r.ok) return { error: r.error };
  const url = typeof r.value === "string" ? r.value : undefined;
  return url ? { url } : { error: "the page returned no location.href" };
}

/**
 * 导航：发命令 → 让出 `NAV_SETTLE_MS` → 读**观测到的**落点 → 两者一起回报。
 *
 * 反馈里那条"报成功但没生效"的根因就是**只回报请求值**：hash 导航被路由守卫弹回时，
 * 工具说"已导航到新地址"，页面还在原处。**观测值才是事实**。
 */
async function performNavigate(args: TabArgs, emit: (e: ChatEvent) => void): Promise<string> {
  const call = buildTabCall("navigate", args);
  const resp = await queryBrowser(call, emit);
  if (!resp.ok) return formatBridgeFailure(resp);

  const resolved = asRecord(resp.data)?.["view_id"];
  await sleep(NAV_SETTLE_MS);
  const observed = await readLandingUrl(typeof resolved === "string" ? resolved : args.viewId, emit);
  return renderTabResult("navigate", resp.data, observed);
}

/** 非 navigate 的 tab 动作：一条直路（发桥 → 渲染）。 */
async function performSimpleTabAction(
  action: TabAction,
  args: TabArgs,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  const resp = await queryBrowser(buildTabCall(action, args), emit);
  if (!resp.ok) return formatBridgeFailure(resp);
  return renderTabResult(action, resp.data);
}

/**
 * 发桥 + 渲染。失败一律走 `formatBridgeFailure`（面向模型的文本，含下一步），
 * **不静默降级**、**永不抛**（调用方 `browserTools.ts` 的 call 壳另有兜底）。
 *
 * navigate 多一步落点回读，故走它自己那条路（见 `performNavigate`）。
 */
export async function performTabAction(
  action: TabAction,
  args: TabArgs,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  return action === "navigate"
    ? performNavigate(args, emit)
    : performSimpleTabAction(action, args, emit);
}

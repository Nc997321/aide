// 内嵌浏览器 IPC 封装。
//
// 桌面壳专属能力（remote-pwa 本身就跑在真浏览器里、ohos 另走 relay，无远程对应），
// 与 useWindowControls/useNotification 同类——已在 scripts/check-tauri-imports.mjs
// 登记为门面例外，直接 invoke 不经 @aide/sdk 共享门面（避免给 RemoteTransport 加无意义空能力）。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** 逻辑像素矩形。CSS px == Tauri logical px（devicePixelRatio == scale_factor），直接传不换算。 */
export interface BoundsDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** NavState 的序列化形态（serde tag="state", rename_all="snake_case"）。 */
export type NavStateDto =
  | { state: "idle" }
  | { state: "loading"; url: string }
  | { state: "ready"; url: string; title: string }
  | { state: "failed"; url: string; reason: string };

export interface BrowserViewDto {
  id: string;
  nav: NavStateDto;
  can_go_back: boolean;
  can_go_forward: boolean;
  bounds: BoundsDto;
  displayed: boolean;
  /** 创建时给的名字（页面标题为空时标签条用它）。 */
  label: string | null;
  /** 谁开的：面板路径恒为 "user"，agent 建的后台视图是 "agent"。 */
  origin: "user" | "agent";
}

/** 视图生命周期事件载荷（Rust `ViewEventDto`）。 */
export interface ViewEventDto {
  id: string;
  kind: "created" | "closed";
  label: string | null;
  origin: "user" | "agent";
  displayed: boolean;
}

/**
 * 导航事件载荷：Rust `NavEventDto`（`#[serde(flatten)]` 拍平）——`id` 是视图 id、`can_go_*` 是
 * 随页面内点击变化的前进后退能力位，其余是 `NavStateDto`（按 `state` 判别：idle/loading/ready/failed）。
 */
export type NavEventDto = {
  id: string;
  can_go_back: boolean;
  can_go_forward: boolean;
} & NavStateDto;

/**
 * 窗口作用域订阅。内嵌浏览器的视图属于创建它的窗口（一个窗口 = 一个 Host），后端对
 * `browser-*` 事件一律 `emit_to(属主窗口)`；Tauri 的默认（Any）监听会收到发给**任何**窗口的
 * 事件，别的 Host 窗口的 tab 就会长到本窗口的面板上——与 @aide/sdk TauriTransport.listen
 * 同一条纪律。拿不到当前窗口（测试 / 非 Tauri 环境）退回原调用形状。
 */
function listenHere<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  let target: { kind: "WebviewWindow"; label: string } | undefined;
  try {
    target = { kind: "WebviewWindow", label: getCurrentWebviewWindow().label };
  } catch {
    target = undefined;
  }
  const handler = (ev: { payload: T }) => cb(ev.payload);
  return target ? listen<T>(event, handler, { target }) : listen<T>(event, handler);
}

/**
 * 订阅导航事件（Rust `browser-nav` 广播）。
 *
 * 这是**多驱动者共用的真相通道**：无论页面是被用户点出来的、还是将来 agent 工具驱动的，
 * 状态变化都从这里到达 UI——面板因此能"跟着 agent 走"，不需要额外的通知机制。
 * 返回取消订阅函数。
 */
export function onBrowserNav(cb: (e: NavEventDto) => void): Promise<UnlistenFn> {
  return listenHere<NavEventDto>("browser-nav", cb);
}

/**
 * 订阅视图生命周期（Rust `browser-view` 广播：created / closed）。
 *
 * 面板靠它把 **agent 开的 tab** 长出来——标签页集合是 UI 状态，而视图可能由别的驱动者创建
 * （`runtime/browser_agent.rs` 的 open op），所以只能走事件通道（CLAUDE.md 红线）。
 *
 * ⚠️ 面板**不要**直接用它：`useBrowserViews` 是唯一的常驻订阅点（它带缓冲，保证面板挂载前的
 * 事件不丢、也不会被 live 与缓冲各应用一次）。这里只提供通道。
 */
export function onBrowserView(cb: (e: ViewEventDto) => void): Promise<UnlistenFn> {
  return listenHere<ViewEventDto>("browser-view", cb);
}

/**
 * 订阅 focus 请求（Rust `browser-focus` 广播）。**是请求不是命令**：显示权在面板，
 * 消费方（`useBrowserViews`）负责幂等展开 + 交给面板切标签。
 */
export function onBrowserFocus(cb: (e: { id: string }) => void): Promise<UnlistenFn> {
  return listenHere<{ id: string }>("browser-focus", cb);
}

/**
 * 内嵌浏览器命令封装。命令名/参数与 src-tauri/src/commands/browser.rs 一一对应。
 *
 * 无状态：视图 id **由 Rust 注册表发**（`create` 的返回值里取），前端不造 id——这样面板、
 * 未来的 agent 工具拿到的是同一个可寻址 id。
 */
export function useEmbeddedBrowser() {
  return {
    create(url: string, bounds: BoundsDto): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_create", { dto: { url, bounds } });
    },
    navigate(id: string, url: string): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_navigate", { id, url });
    },
    setBounds(id: string, bounds: BoundsDto): Promise<void> {
      return invoke("browser_set_bounds", { id, bounds });
    },
    setDisplayed(id: string, displayed: boolean): Promise<void> {
      return invoke("browser_set_displayed", { id, displayed });
    },
    /**
     * 列出全部视图（面板挂载时的对账来源）。视图可能**先于面板**被创建——
     * agent 先开 tab、用户还没点开面板，那条 `browser-view` 事件就没人接。
     */
    listViews(): Promise<BrowserViewDto[]> {
      return invoke<BrowserViewDto[]>("browser_views_list");
    },
    /**
     * 当前画面快照（JPEG data URI）。**必须在视图还显示着时调用**（隐藏的视图不合成帧，拍不出来）。
     * 面板用它在 HTML 浮层盖上来的那段时间填住原生视图让出的洞。
     */
    snapshot(id: string): Promise<string> {
      return invoke<string>("browser_snapshot", { id });
    },
    goBack(id: string): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_go_back", { id });
    },
    goForward(id: string): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_go_forward", { id });
    },
    close(id: string): Promise<void> {
      return invoke("browser_close", { id });
    },
  };
}

// 内嵌浏览器 IPC 封装。
//
// 桌面壳专属能力（remote-pwa 本身就跑在真浏览器里、ohos 另走 relay，无远程对应），
// 与 useWindowControls/useNotification 同类——已在 scripts/check-tauri-imports.mjs
// 登记为门面例外，直接 invoke 不经 @aide/sdk 共享门面（避免给 RemoteTransport 加无意义空能力）。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
 * 订阅导航事件（Rust `browser-nav` 广播）。
 *
 * 这是**多驱动者共用的真相通道**：无论页面是被用户点出来的、还是将来 agent 工具驱动的，
 * 状态变化都从这里到达 UI——面板因此能"跟着 agent 走"，不需要额外的通知机制。
 * 返回取消订阅函数。
 */
export function onBrowserNav(cb: (e: NavEventDto) => void): Promise<UnlistenFn> {
  return listen<NavEventDto>("browser-nav", (ev) => cb(ev.payload));
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

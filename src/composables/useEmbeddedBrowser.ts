// 内嵌浏览器 IPC 封装。
//
// 桌面壳专属能力（remote-pwa 本身就跑在真浏览器里、ohos 另走 relay，无远程对应），
// 与 useWindowControls/useNotification 同类——已在 scripts/check-tauri-imports.mjs
// 登记为门面例外，直接 invoke 不经 @aide/sdk 共享门面（避免给 RemoteTransport 加无意义空能力）。
import { invoke } from "@tauri-apps/api/core";

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
  visible: boolean;
}

/**
 * 内嵌浏览器命令封装。命令名/参数与 src-tauri/src/commands/browser.rs 一一对应。
 * 无状态——视图标识 id 由调用方（BrowserPanel）持有。
 */
export function useEmbeddedBrowser() {
  return {
    create(id: string, url: string, bounds: BoundsDto): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_create", { dto: { id, url, bounds } });
    },
    navigate(id: string, url: string): Promise<BrowserViewDto> {
      return invoke<BrowserViewDto>("browser_navigate", { id, url });
    },
    setBounds(id: string, bounds: BoundsDto): Promise<void> {
      return invoke("browser_set_bounds", { id, bounds });
    },
    setVisible(id: string, visible: boolean): Promise<void> {
      return invoke("browser_set_visible", { id, visible });
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

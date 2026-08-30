/**
 * 传输层——api 门面与后端之间的唯一通道。
 * 桌面 = Tauri IPC；远端 PWA = WebSocket RPC（RemoteTransport，见 remote.ts）。
 * listen 形状与 @tauri-apps/api/event 对齐（回调收 { payload }），调用点零改。
 *
 * 模块级单例是有意的服务定位：传输是进程级环境绑定，由应用入口注入一次后
 * 只读（桌面走默认 TauriTransport；PWA 在 main.ts 顶部 setTransport）。
 * 测试经 setTransport 替换桩件，或 vi.mock @tauri-apps/api/* 拦截默认实现。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

export interface AideTransport {
  invoke<T>(command: string, params?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void>;
  /** 环境绑定的外链打开：桌面 = 系统默认浏览器（plugin-shell）；远端 = 本地浏览器新开 tab。
   *  可选方法：桩件/旧实现可不带，openExternal() 兜底回落 window.open。 */
  openExternal?(url: string): Promise<void>;
}

/** 默认传输：直转 Tauri IPC。不导出——经 getTransport() 惰性取得。 */
class TauriTransport implements AideTransport {
  invoke<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    // 保持调用形状精确：无参数命令不带第二参（vitest toHaveBeenCalledWith 按实 arity 匹配）。
    return params === undefined ? invoke<T>(command) : invoke<T>(command, params);
  }
  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
    // Tauri Event<T> 含 { event, id, payload }，结构上满足 { payload: T }，直传。
    return tauriListen<T>(event, cb);
  }
  openExternal(url: string): Promise<void> {
    return shellOpen(url);
  }
}

let current: AideTransport | null = null;

export function setTransport(t: AideTransport): void {
  current = t;
}

export function getTransport(): AideTransport {
  current ??= new TauriTransport();
  return current;
}

/** 门面级事件订阅：桌面直转 Tauri event，远端走 RemoteTransport（仅 chat-event）。
 *  形状与 @tauri-apps/api/event 的 listen 对齐，迁移调用点只需换 import 源。 */
export function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
  return getTransport().listen(event, cb);
}

/** 门面级外链打开：桌面 = 系统默认浏览器，远端/浏览器环境 = window.open 新 tab。 */
export function openExternal(url: string): Promise<void> {
  const t = getTransport();
  if (t.openExternal) return t.openExternal(url);
  // 桩件/自定义传输未实现的兜底（浏览器语义；node 测试环境无 window 则静默）
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve();
}

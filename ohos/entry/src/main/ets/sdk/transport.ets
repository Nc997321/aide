/**
 * 传输层——api 门面与后端之间的唯一通道。
 *
 * 过筛自 packages/aide-sdk/src/transport.ts（ArkTS 化），同步时对照上游。
 * 与上游的差异：
 *  - 无 TauriTransport 默认实现——鸿蒙端没有本地后端，getTransport() 未注入即抛错；
 *    启动时必须 setTransport(new RemoteTransport(...))（连接管理页负责）
 *  - unknown → Object（ArkTS JSON 值域）
 * 协议/接口形状与上游零偏差。
 */

export interface AideEvent<T> {
  payload: T;
}

export interface AideTransport {
  invoke<T>(command: string, params?: Record<string, Object>): Promise<T>;
  listen<T>(event: string, cb: (e: AideEvent<T>) => void): Promise<() => void>;
  /** 可选方法：环境绑定的外链打开。 */
  openExternal?(url: string): Promise<void>;
}

let current: AideTransport | null = null;

export function setTransport(t: AideTransport): void {
  current = t;
}

export function getTransport(): AideTransport {
  if (!current) {
    throw new Error('transport 未注入：鸿蒙端启动时须 setTransport(new RemoteTransport(...))');
  }
  return current;
}

/** 门面级事件订阅：远端仅 chat-event（RemoteTransport 对其他事件名 no-op + warn）。 */
export function listen<T>(event: string, cb: (e: AideEvent<T>) => void): Promise<() => void> {
  return getTransport().listen(event, cb);
}

/** 门面级外链打开：未实现 openExternal 的传输静默降级。 */
export function openExternal(url: string): Promise<void> {
  const t = getTransport();
  if (t.openExternal) {
    return t.openExternal(url);
  }
  console.warn(`[sdk] 当前 transport 未实现 openExternal，忽略：${url}`);
  return Promise.resolve();
}

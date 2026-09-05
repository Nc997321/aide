/**
 * 远程传输：WebSocket 经中继桥接到桌面 remote 网关（协议 v2 通用 RPC + 事件流）。
 *
 * 过筛自 packages/aide-sdk/src/remote.ts（ArkTS 化）。协议语义零改动：
 * 与 src-tauri/src/remote/protocol.rs、上游 remote.ts 互为镜像，三端同步演进。
 * ArkTS 化改动点（同步脚本须遵守同一规则）：
 *  - DOM 事件类型（Event/MessageEvent/CloseEvent）→ 最小事件 interface
 *  - 对象字面量 → 显式具名 interface 实例
 *  - "code" in creds 判别 → as 成员收窄 + 字段探测（ArkTS 无 in 操作符）
 *  - for-of Map → forEach；无参 catch → catch (e)
 *  - unknown → Object；ReturnType<typeof setTimeout> → number
 *  - 默认 wsFactory 从浏览器 WebSocket → createOhosWs（ws-ohos.ets）
 */
import type { AideTransport, AideEvent } from './transport';
import { createOhosWs } from './ws-ohos';

export type ConnState =
  'idle' | // 未连接（用户主动断开）
  'connecting' | // 正在连中继
  'bridged' | // 已桥接（中继路由到桌面），未认证
  'authed' | // 已认证，可收发
  'needsPairing' | // 需要配对（无 token / token 无效 / 被吊销）
  'offline'; // 设备离线（中继不可达或桌面不在线），自动重试中

export interface PairOk {
  device_id: string;
  token: string;
}

export interface ConnectByCode {
  code: string;
}

export interface ConnectByToken {
  deviceId: string;
  token: string;
}

export type ConnectCreds = ConnectByCode | ConnectByToken;

// ── 最小事件形状（ArkTS 无 DOM lib；字段按上游实际使用面）──

export interface WsOpenEvent {}

export interface WsMessageEvent {
  data: string | ArrayBuffer;
}

export interface WsCloseEvent {
  code: number;
  reason: string;
}

export interface WsErrorEvent {
  message: string;
}

/** 客户端实际用到的 WebSocket 子集（结构化类型，测试可注入假实现）。 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: WsOpenEvent) => void) | null;
  onmessage: ((ev: WsMessageEvent) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
  onerror: ((ev: WsErrorEvent) => void) | null;
}

// ── 协议消息（镜像 src-tauri/src/remote/protocol.rs 的 DesktopToPhone）──

interface PairOkMsg {
  type: 'pair_ok';
  device_id: string;
  token: string;
}

interface AuthOkMsg {
  type: 'auth_ok';
}

interface AuthErrorMsg {
  type: 'auth_error';
  message: string;
}

interface EventMsg {
  type: 'event';
  event: Record<string, Object>;
}

interface InvokeOkMsg {
  type: 'invoke_ok';
  id: number;
  payload: Object | null;
}

interface InvokeErrMsg {
  type: 'invoke_err';
  id: number;
  error: string;
}

type DesktopToPhone = PairOkMsg | AuthOkMsg | AuthErrorMsg | EventMsg | InvokeOkMsg | InvokeErrMsg;

// ── 上行消息（fresh 字面量须有显式类型）──

interface ConnectByCodeMsg {
  type: 'connect';
  code: string;
}

interface ConnectByTokenMsg {
  type: 'connect';
  device_id: string;
  token: string;
}

interface PairMsg {
  type: 'pair';
  code: string;
}

interface AuthMsg {
  type: 'auth';
  token: string;
}

interface InvokeMsg {
  type: 'invoke';
  id: number;
  command: string;
  params: Record<string, Object>;
}

interface PendingInvoke {
  resolve: (v: Object | null) => void;
  reject: (e: Error) => void;
}

interface PairWaiter {
  resolve: (v: PairOk) => void;
  reject: (e: Error) => void;
}

interface AuthWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

/** 外链打开注入点（平台绑定：ohos 由 ws-ohos.ets 的 makeOpenUrl 提供）。 */
export type OpenUrlFn = (url: string) => void;

const WS_OPEN = 1;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
/** 远程网关只透传 chat-event 这一种事件；其他事件名 listen 了也收不到。 */
const CHAT_EVENT = 'chat-event';

type StateCb = (s: ConnState) => void;
type EventCb = (e: AideEvent<Object>) => void;
type ReconnectedCb = () => void;
type ErrorCb = (msg: string) => void;

export class RemoteTransport implements AideTransport {
  private ws: WsLike | null = null;
  private wsFactory: (url: string) => WsLike;
  private openUrlImpl: OpenUrlFn | null;
  private relayUrl: string;
  private _state: ConnState = 'idle';
  private stateCbs: StateCb[] = [];
  private eventCbs: Map<string, Set<EventCb>> = new Map();
  private reconnectedCbs: ReconnectedCb[] = [];
  private errorCbs: ErrorCb[] = [];
  private creds: ConnectCreds | null = null;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private reconnecting = false;
  private pending: Map<number, PendingInvoke> = new Map();
  private nextInvokeId = 0;
  /** 配对码请求挂起（ws 未打开时 pair() 先行调用）；onopen 补发，重连自动续配。 */
  private pendingPair: string | null = null;
  private pairWaiter: PairWaiter | null = null;
  private authWaiter: AuthWaiter | null = null;

  constructor(relayUrl: string, wsFactory?: (url: string) => WsLike, openUrl?: OpenUrlFn) {
    this.relayUrl = relayUrl;
    this.wsFactory = wsFactory ?? ((url: string) => createOhosWs(url));
    this.openUrlImpl = openUrl ?? null;
  }

  // ── AideTransport ──

  invoke<T>(command: string, params?: Record<string, Object>): Promise<T> {
    return new Promise<T>((resolve: (v: T) => void, reject: (e: Error) => void) => {
      const id = ++this.nextInvokeId;
      // JSON 边界：payload 是动态值，T 是调用方声明的期望形状（收窄责任在 api 门面）。
      this.pending.set(id, { resolve: (v: Object | null) => resolve(v as T), reject: reject });
      try {
        // 协议要求 params 恒存在（Rust 端必填字段；无参命令传 {}）
        const msg: InvokeMsg = { type: 'invoke', id: id, command: command, params: params ?? {} };
        this.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  listen<T>(event: string, cb: (e: AideEvent<T>) => void): Promise<() => void> {
    if (event !== CHAT_EVENT) {
      // 远程只转发 chat-event；其他事件（lsp-* 等）是桌面专属——
      // 显式降级为 no-op 而不是静默挂起，让误用在开发期可见。
      console.warn(`[sdk] RemoteTransport: 事件 "${event}" 远程不可用，按 no-op 处理`);
      return Promise.resolve(() => {});
    }
    let set = this.eventCbs.get(event);
    if (!set) {
      set = new Set<EventCb>();
      this.eventCbs.set(event, set);
    }
    const target = set;
    // cb 的 payload 泛型在边界处擦除——事件生产端（桌面网关）与消费端共享同一形状约定。
    const wrapped = cb as EventCb;
    target.add(wrapped);
    return Promise.resolve(() => {
      target.delete(wrapped);
    });
  }

  /** 远端语义：外链在手机本地打开（不是桌面宿主机的浏览器）。 */
  openExternal(url: string): Promise<void> {
    if (this.openUrlImpl) {
      this.openUrlImpl(url);
    } else {
      console.warn(`[sdk] openUrl 未注入，忽略外链：${url}`);
    }
    return Promise.resolve();
  }

  // ── 连接管理（连接管理页消费）──

  get state(): ConnState {
    return this._state;
  }

  onStateChange(cb: StateCb): void {
    this.stateCbs.push(cb);
  }

  offStateChange(cb: StateCb): void {
    this.stateCbs = this.stateCbs.filter((c: StateCb) => c !== cb);
  }

  /** 重连 + re-auth 成功后触发（UI 据此重新 load_messages 补齐事件缺口）。 */
  onReconnected(cb: ReconnectedCb): void {
    this.reconnectedCbs.push(cb);
  }

  offReconnected(cb: ReconnectedCb): void {
    this.reconnectedCbs = this.reconnectedCbs.filter((c: ReconnectedCb) => c !== cb);
  }

  onError(cb: ErrorCb): void {
    this.errorCbs.push(cb);
  }

  /**
   * 发起连接（幂等：会先关掉旧连接）。
   * - {code}：桥接后停在 bridged，等 UI 调 pair()
   * - {deviceId, token}：桥接后自动 auth，成功到 authed
   * - relayUrl：换中继地址时传入更新（重配对场景复用同一实例——
   *   事件监听挂在实例上，换新实例会让已注册的 listen 挂在死连接上）。
   */
  connect(creds: ConnectCreds, relayUrl?: string): void {
    if (relayUrl) {
      this.relayUrl = relayUrl;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.closedByUser = true; // 旧连接关闭不触发重连
      this.ws.close();
      this.ws = null;
    }
    this.closedByUser = false;
    this.reconnecting = false;
    this.creds = creds;
    this.pendingPair = null; // 新一轮连接，旧配对挂起作废
    this.backoffMs = BACKOFF_BASE_MS;
    this.openOnce();
  }

  /**
   * 配对：发送 pair 消息，等 pair_ok / auth_error。成功返回 token 凭据。
   * 可能在 ws 打开前调用（connect 后立即 pair）——此时挂起，onopen 补发。
   */
  pair(code: string): Promise<PairOk> {
    return new Promise<PairOk>((resolve: (v: PairOk) => void, reject: (e: Error) => void) => {
      this.pairWaiter = { resolve: resolve, reject: reject };
      this.pendingPair = code;
      if (this.ws && this.ws.readyState === WS_OPEN) {
        const msg: PairMsg = { type: 'pair', code: code };
        this.send(JSON.stringify(msg));
      }
    });
  }

  /** 主动断开：停止重连，回 idle。 */
  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.failPending('已断开');
    this.setState('idle');
  }

  // ── 内部 ──

  private wsUrl(): string {
    return `${this.relayUrl.replace(/\/+$/, '')}/ws`;
  }

  private openOnce(): void {
    this.setState('connecting');
    const ws = this.wsFactory(this.wsUrl());
    this.ws = ws;

    ws.onopen = (ev: WsOpenEvent) => {
      const creds = this.creds;
      // 不可达：connect() 恒先设 creds 再 openOnce（防御性守卫，避免静默发出无凭据首包）
      if (!creds) {
        return;
      }
      // 中继层首条消息（路由用）：配对码或已配对凭据（ArkTS 无 in 操作符，as 探测判别）
      const byCode = creds as ConnectByCode;
      if (byCode.code !== undefined) {
        const m: ConnectByCodeMsg = { type: 'connect', code: byCode.code };
        ws.send(JSON.stringify(m));
        this.setState('bridged');
        // pair 在 ws 打开前调用过则补发；断线重连后同样重发（自动续配）
        if (this.pendingPair != null) {
          const p: PairMsg = { type: 'pair', code: this.pendingPair };
          ws.send(JSON.stringify(p));
        }
      } else {
        const byToken = creds as ConnectByToken;
        const m: ConnectByTokenMsg = { type: 'connect', device_id: byToken.deviceId, token: byToken.token };
        ws.send(JSON.stringify(m));
        // 自动 re-auth。reject 不动状态：needsPairing 只由显式 auth_error 落
        // （handleMessage）；断线导致的 auth 中断是可重试的，onclose 走 offline。
        const a: AuthMsg = { type: 'auth', token: byToken.token };
        this.send(JSON.stringify(a));
        this.authWaiter = {
          resolve: () => this.setState('authed'),
          reject: () => {}
        };
      }
    };

    ws.onmessage = (ev: WsMessageEvent) => {
      this.handleMessage(String(ev.data));
    };

    ws.onclose = (ev: WsCloseEvent) => {
      if (this.ws !== ws) {
        return; // 已被新连接替换
      }
      this.ws = null;
      if (this.closedByUser) {
        this.setState('idle');
        return;
      }
      this.failPending('连接断开');
      if (this.pairWaiter) {
        this.pairWaiter.reject(new Error('连接断开'));
        this.pairWaiter = null;
      }
      if (this.authWaiter) {
        this.authWaiter.reject(new Error('连接断开'));
        this.authWaiter = null;
      }
      // needsPairing 时不自动重连（token 无效，重试无意义，等用户重新配对）
      if (this.state === 'needsPairing') {
        this.setState('idle');
        return;
      }
      this.setState('offline');
      this.scheduleReconnect();
    };

    ws.onerror = (_ev: WsErrorEvent) => {
      // onclose 会跟随
    };
  }

  private scheduleReconnect(): void {
    // 不可达：onclose 里 closedByUser 已提前 return——本守卫是防御竞态的兜底。
    if (this.closedByUser || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 不可达：disconnect() 会 clearTimeout 拦下回调；仅竞态（计时器已触发不可撤）兜底
      if (this.closedByUser) {
        return;
      }
      this.reconnecting = true;
      this.openOnce();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private handleMessage(raw: string): void {
    let msg: DesktopToPhone;
    try {
      // JSON 边界：解析后只信 type 判别字段分发；各臂字段在使用处经 serde 对账过
      // （Rust 侧协议枚举与这里互为镜像，两端同步演进）。
      msg = JSON.parse(raw) as DesktopToPhone;
    } catch (e) {
      return; // 坏帧：哑管道中间产物或截断，丢弃即可（无状态损坏）
    }
    switch (msg.type) {
      case 'pair_ok': {
        const m = msg as PairOkMsg;
        this.creds = { deviceId: m.device_id, token: m.token };
        this.pendingPair = null;
        this.setState('authed');
        if (this.pairWaiter) {
          this.pairWaiter.resolve({ device_id: m.device_id, token: m.token });
          this.pairWaiter = null;
        }
        break;
      }
      case 'auth_ok': {
        this.setState('authed');
        if (this.authWaiter) {
          this.authWaiter.resolve();
          this.authWaiter = null;
        }
        if (this.reconnecting) {
          this.reconnecting = false;
          this.reconnectedCbs.forEach((cb: ReconnectedCb) => cb());
        }
        break;
      }
      case 'auth_error': {
        const m = msg as AuthErrorMsg;
        this.pendingPair = null;
        this.setState('needsPairing');
        if (this.authWaiter) {
          this.authWaiter.reject(new Error(m.message));
          this.authWaiter = null;
        }
        if (this.pairWaiter) {
          this.pairWaiter.reject(new Error(m.message));
          this.pairWaiter = null;
        }
        break;
      }
      case 'event': {
        const m = msg as EventMsg;
        const set = this.eventCbs.get(CHAT_EVENT);
        if (set) {
          set.forEach((cb: EventCb) => cb({ payload: m.event }));
        }
        break;
      }
      case 'invoke_ok': {
        const m = msg as InvokeOkMsg;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.resolve(m.payload);
        }
        break;
      }
      case 'invoke_err': {
        const m = msg as InvokeErrMsg;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.reject(new Error(m.error));
        } else {
          this.errorCbs.forEach((cb: ErrorCb) => cb(m.error));
        }
        break;
      }
    }
  }

  private failPending(reason: string): void {
    this.pending.forEach((p: PendingInvoke) => p.reject(new Error(reason)));
    this.pending.clear();
  }

  private send(data: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error('未连接');
    }
    this.ws.send(data);
  }

  private setState(s: ConnState): void {
    if (this._state === s) {
      return;
    }
    this._state = s;
    this.stateCbs.forEach((cb: StateCb) => cb(s));
  }
}

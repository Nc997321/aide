/**
 * 远程传输：WebSocket 经中继桥接到桌面 remote 网关（协议 v2 通用 RPC + 事件流）。
 *
 * 连接状态机 / 指数退避 / 自动续配 移植自原 remote-pwa protocol.ts（实战验证过）；
 * 与旧 RemoteClient 的差异：
 *  - 请求/应答从「kind FIFO 队列」改为「id 对号 Map」——通用 invoke 取代手写消息；
 *  - 事件经 listen("chat-event") 适配成 Tauri 形状（{ payload }），与桌面同源；
 *  - 类同时实现 AideTransport（setTransport 注入）与连接管理接口（ConnectView 用）。
 *
 * 中继是哑管道：register/connect 首条消息之外的字节原样转发，不理解本协议。
 */
import type { AideTransport } from "./transport";

export type ConnState =
  | "idle" // 未连接（用户主动断开）
  | "connecting" // 正在连中继
  | "bridged" // 已桥接（中继路由到桌面），未认证
  | "authed" // 已认证，可收发
  | "needsPairing" // 需要配对（无 token / token 无效 / 被吊销）
  | "offline"; // 设备离线（中继不可达或桌面不在线），自动重试中

export interface PairOk {
  device_id: string;
  token: string;
}

export type ConnectCreds =
  | { code: string }
  | { deviceId: string; token: string };

/** 客户端实际用到的 WebSocket 子集（结构化类型，测试可注入假实现）。 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

/** relay connect_error 原因：封闭三值 + `(string & {})` 逃逸臂——已知值可类型收窄、
 *  新增 reason 前向兼容（落「忽略」语义），与 relay ConnectErrorReason 枚举对账。 */
type ConnectErrorReason = "unknown_code" | "device_offline" | "superseded" | (string & {});

/** 桌面 → 手机消息（镜像 src-tauri/src/remote/protocol.rs 的 DesktopToPhone）。
 *  connect_error 是 relay 源帧（非桌面），首消息/桥接顶替阶段由中继下发，
 *  与桌面帧同流到达。 */
type DesktopToPhone =
  | { type: "pair_ok"; device_id: string; token: string }
  | { type: "auth_ok" }
  | { type: "auth_error"; message: string }
  | { type: "connect_error"; reason: ConnectErrorReason }
  | { type: "event"; event: Record<string, unknown> }
  | { type: "invoke_ok"; id: number; payload: unknown }
  | { type: "invoke_err"; id: number; error: string };

interface PendingInvoke {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const WS_OPEN = 1;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
/** 手机腿活体帧间隔：relay 据此武装 60s 静默超时（首帧 keepalive 才武装，
 *  老客户端不发 = 保持旧行为）。 */
const KEEPALIVE_INTERVAL_MS = 20000;
/** 远程网关只透传 chat-event 这一种事件；其他事件名 listen 了也收不到。 */
const CHAT_EVENT = "chat-event";

export class RemoteTransport implements AideTransport {
  private ws: WsLike | null = null;
  private wsFactory: (url: string) => WsLike;
  private relayUrl: string;
  private _state: ConnState = "idle";
  private stateCbs: Array<(s: ConnState) => void> = [];
  private eventCbs = new Map<string, Set<(e: { payload: unknown }) => void>>();
  private reconnectedCbs: Array<() => void> = [];
  private errorCbs: Array<(msg: string) => void> = [];
  private creds: ConnectCreds | null = null;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private reconnecting = false;
  private pending = new Map<number, PendingInvoke>();
  private nextInvokeId = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** 被新连接顶替（superseded）：onclose 据此回 idle 不重连，防互踢循环。 */
  private kickedBySupersede = false;
  /** 配对码请求挂起（ws 未打开时 pair() 先行调用）；onopen 补发，重连自动续配。 */
  private pendingPair: string | null = null;
  private pairWaiter: {
    resolve: (v: PairOk) => void;
    reject: (e: Error) => void;
  } | null = null;
  private authWaiter: {
    resolve: () => void;
    reject: (e: Error) => void;
  } | null = null;

  constructor(relayUrl: string, wsFactory?: (url: string) => WsLike) {
    this.relayUrl = relayUrl;
    this.wsFactory = wsFactory ?? ((url) => new WebSocket(url));
  }

  // ── AideTransport ──

  invoke<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextInvokeId;
      // JSON 边界：payload 是 unknown，T 是调用方声明的期望形状（收窄责任在 api 门面）。
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      try {
        // 协议要求 params 恒存在（Rust 端必填字段；无参命令传 {}）
        this.send(JSON.stringify({ type: "invoke", id, command, params: params ?? {} }));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
    if (event !== CHAT_EVENT) {
      // 远程只转发 chat-event；其他事件（lsp-*/pty-* 等）是桌面专属——
      // 显式降级为 no-op 而不是静默挂起，让误用在开发期可见。
      console.warn(`[aide-sdk] RemoteTransport: 事件 "${event}" 远程不可用，按 no-op 处理`);
      return Promise.resolve(() => {});
    }
    const set = this.eventCbs.get(event) ?? new Set();
    // cb 的 payload 泛型在边界处擦除为 unknown——分发时窄不回来，
    // 但事件生产端（桌面网关）与消费端（useChatSession）共享同一形状约定。
    const wrapped = cb as (e: { payload: unknown }) => void;
    set.add(wrapped);
    this.eventCbs.set(event, set);
    return Promise.resolve(() => {
      set.delete(wrapped);
    });
  }

  /** 远端语义：外链在手机本地浏览器新开 tab（不是桌面宿主机的浏览器）。 */
  openExternal(url: string): Promise<void> {
    // 浏览器环境的 PWA：window.open 即设备默认浏览器；noopener/noreferrer 防劫持。
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }

  // ── 连接管理（PWA ConnectView/App 消费）──

  get state(): ConnState {
    return this._state;
  }

  onStateChange(cb: (s: ConnState) => void): void {
    this.stateCbs.push(cb);
  }

  offStateChange(cb: (s: ConnState) => void): void {
    this.stateCbs = this.stateCbs.filter((c) => c !== cb);
  }

  /** 重连 + re-auth 成功后触发（UI 据此重新 load_messages 补齐事件缺口）。 */
  onReconnected(cb: () => void): void {
    this.reconnectedCbs.push(cb);
  }

  offReconnected(cb: () => void): void {
    this.reconnectedCbs = this.reconnectedCbs.filter((c) => c !== cb);
  }

  onError(cb: (msg: string) => void): void {
    this.errorCbs.push(cb);
  }

  /**
   * 发起连接（幂等：会先关掉旧连接）。
   * - {code}：桥接后停在 bridged，等 UI 调 pair()
   * - {deviceId, token}：桥接后自动 auth，成功到 authed
   * - relayUrl：换中继地址时传入更新（App 重配对场景复用同一实例——
   *   事件监听挂在实例上，换新实例会让已注册的 listen 挂在死连接上）。
   */
  connect(creds: ConnectCreds, relayUrl?: string): void {
    if (relayUrl) this.relayUrl = relayUrl;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.closedByUser = true; // 旧连接关闭不触发重连
      this.stopKeepalive();
      this.ws.close();
      this.ws = null;
    }
    this.closedByUser = false;
    this.kickedBySupersede = false;
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
    return new Promise((resolve, reject) => {
      this.pairWaiter = { resolve, reject };
      this.pendingPair = code;
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.send(JSON.stringify({ type: "pair", code }));
      }
    });
  }

  /** 主动断开：停止重连，回 idle。 */
  disconnect(): void {
    this.closedByUser = true;
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.failPending("已断开");
    this.setState("idle");
  }

  // ── 内部 ──

  private wsUrl(): string {
    return `${this.relayUrl.replace(/\/+$/, "")}/ws`;
  }

  /** 起活体帧定时器：relay 收到首帧 keepalive 才武装手机腿静默超时。
   *  tick 守卫 ws 身份与 readyState——真 onclose 异步，tick 可落在 close 与事件之间。 */
  private startKeepalive(ws: WsLike): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WS_OPEN) return;
      try {
        ws.send(JSON.stringify({ type: "keepalive" }));
      } catch (e) {
        // 发送抛错 = 连接将死：onclose 会清定时器，此处无需出声
        console.warn("[aide-sdk] keepalive send failed:", e);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private openOnce(): void {
    this.setState("connecting");
    const ws = this.wsFactory(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      const creds = this.creds;
      // 不可达：connect() 恒先设 creds 再 openOnce（防御性守卫，避免静默发出无凭据首包）
      if (!creds) return;
      this.startKeepalive(ws);
      // 中继层首条消息（路由用）：配对码或已配对凭据
      ws.send(JSON.stringify(
        "code" in creds
          ? { type: "connect", code: creds.code }
          : { type: "connect", device_id: creds.deviceId, token: creds.token },
      ));
      if ("token" in creds) {
        // 自动 re-auth。reject 不动状态：needsPairing 只由显式 auth_error 落
        // （handleMessage）；断线导致的 auth 中断是可重试的，onclose 走 offline。
        this.send(JSON.stringify({ type: "auth", token: creds.token }));
        this.authWaiter = {
          resolve: () => this.setState("authed"),
          reject: () => {},
        };
      } else {
        this.setState("bridged");
        // pair 在 ws 打开前调用过则补发；断线重连后同样重发（自动续配）
        if (this.pendingPair != null) {
          ws.send(JSON.stringify({ type: "pair", code: this.pendingPair }));
        }
      }
    };

    ws.onmessage = (ev) => this.handleMessage(String(ev.data));

    ws.onclose = () => {
      if (this.ws !== ws) return; // 已被新连接替换
      this.ws = null;
      this.stopKeepalive();
      if (this.closedByUser) {
        this.setState("idle");
        return;
      }
      // 被新连接顶替：会话已易主，重连只会与新连接互踢——停在这里等用户决策
      if (this.kickedBySupersede) {
        this.failPending("已被新连接顶替");
        // waiter 不能被早返回漏掉：bridged 阶段挂起的 pair() 正是 superseded 的典型窗口
        const err = new Error("已被新连接顶替");
        this.pairWaiter?.reject(err);
        this.pairWaiter = null;
        this.authWaiter?.reject(err);
        this.authWaiter = null;
        this.setState("idle");
        return;
      }
      this.failPending("连接断开");
      if (this.pairWaiter) {
        this.pairWaiter.reject(new Error("连接断开"));
        this.pairWaiter = null;
      }
      if (this.authWaiter) {
        this.authWaiter.reject(new Error("连接断开"));
        this.authWaiter = null;
      }
      // needsPairing 时不自动重连（token 无效，重试无意义，等用户重新配对）
      if (this.state === "needsPairing") {
        this.setState("idle");
        return;
      }
      this.setState("offline");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会跟随
    };
  }

  private scheduleReconnect(): void {
    // 不可达：onclose 里 closedByUser 已提前 return，且每次 onclose 后 this.ws 置空、
    // 重复 onclose 被 stale 守卫拦住——本守卫是防御竞态的兜底。
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // 不可达：disconnect() 会 clearTimeout 拦下回调；仅竞态（计时器已触发不可撤）兜底
      if (this.closedByUser) return;
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
    } catch {
      return; // 坏帧：哑管道中间产物或截断，丢弃即可（无状态损坏）
    }
    switch (msg.type) {
      case "pair_ok": {
        this.creds = { deviceId: msg.device_id, token: msg.token };
        this.pendingPair = null;
        this.setState("authed");
        this.pairWaiter?.resolve({ device_id: msg.device_id, token: msg.token });
        this.pairWaiter = null;
        break;
      }
      case "auth_ok": {
        this.setState("authed");
        this.authWaiter?.resolve();
        this.authWaiter = null;
        if (this.reconnecting) {
          this.reconnecting = false;
          this.reconnectedCbs.forEach((cb) => cb());
        }
        break;
      }
      case "auth_error": {
        this.pendingPair = null;
        this.setState("needsPairing");
        this.authWaiter?.reject(new Error(msg.message));
        this.authWaiter = null;
        this.pairWaiter?.reject(new Error(msg.message));
        this.pairWaiter = null;
        break;
      }
      case "connect_error": {
        // relay 源帧：unknown_code = 码路由未命中（码错/桌面未上报），回配对屏报码错
        // 且停止重试（重试同一个死码无意义）；superseded = 被新连接顶替；
        // device_offline 等其余原因忽略——onclose 照旧走 offline 退避
        if (msg.reason === "unknown_code") {
          this.pendingPair = null;
          this.setState("needsPairing");
          const err = new Error("配对码无效或已过期");
          this.authWaiter?.reject(err);
          this.authWaiter = null;
          this.pairWaiter?.reject(err);
          this.pairWaiter = null;
        } else if (msg.reason === "superseded") {
          this.kickedBySupersede = true;
        }
        break;
      }
      case "event": {
        const set = this.eventCbs.get(CHAT_EVENT);
        if (set) set.forEach((cb) => cb({ payload: msg.event }));
        break;
      }
      case "invoke_ok": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.payload);
        }
        break;
      }
      case "invoke_err": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.error));
        } else {
          this.errorCbs.forEach((cb) => cb(msg.error));
        }
        break;
      }
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }

  private send(data: string): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error("未连接");
    }
    this.ws.send(data);
  }

  private setState(s: ConnState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateCbs.forEach((cb) => cb(s));
  }
}

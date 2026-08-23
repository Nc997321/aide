import type {
  ChatEvent,
  ChatMessageItem,
  DesktopToPhone,
  PhoneToDesktop,
  RelayConnect,
  Session,
  Workspace,
} from "./types";

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

const WS_OPEN = 1;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

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

interface PendingRequest {
  kind: "sessions" | "messages" | "workspaces";
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * RemoteClient 公开接口（组件 prop 用）。
 * 类实例放进 ref 后模板解包会丢私有成员（UnwrapRef 映射类型），
 * 结构化接口可避免——组件只依赖公开方法。
 */
export interface RemoteClientLike {
  state: ConnState;
  onStateChange(cb: (s: ConnState) => void): void;
  offStateChange(cb: (s: ConnState) => void): void;
  onEvent(cb: (e: ChatEvent) => void): void;
  offEvent(cb: (e: ChatEvent) => void): void;
  onReconnected(cb: () => void): void;
  offReconnected(cb: () => void): void;
  onError(cb: (msg: string) => void): void;
  connect(creds: ConnectCreds): void;
  pair(code: string): Promise<PairOk>;
  sendMessage(sessionId: string | null, prompt: string, workspaceKey?: string): void;
  loadMessages(sessionId: string): Promise<ChatMessageItem[]>;
  listSessions(workspaceKey?: string): Promise<Session[]>;
  listWorkspaces(): Promise<Workspace[]>;
  disconnect(): void;
}

/**
 * 远程控制协议客户端：连中继 → 桥接 → 认证 → 收发。
 *
 * 状态机：idle → connecting → bridged → authed；
 * 断线指数退避重连（1s→30s 封顶）+ 重连后自动 re-auth；
 * auth 失败 → needsPairing（等用户重新配对，不自动重连）；
 * 中继/桌面不可达 → offline（持续重试）。
 *
 * 请求/应答：桌面网关串行处理消息，应答按序返回；pending 队列 FIFO 匹配。
 */
export class RemoteClient implements RemoteClientLike {
  private ws: WsLike | null = null;
  private wsFactory: (url: string) => WsLike;
  private relayUrl: string;
  private _state: ConnState = "idle";
  private stateCbs: Array<(s: ConnState) => void> = [];
  private eventCbs: Array<(e: ChatEvent) => void> = [];
  private reconnectedCbs: Array<() => void> = [];
  private errorCbs: Array<(msg: string) => void> = [];
  private creds: ConnectCreds | null = null;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private reconnecting = false;
  private pending: PendingRequest[] = [];
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

  get state(): ConnState {
    return this._state;
  }

  onStateChange(cb: (s: ConnState) => void): void {
    this.stateCbs.push(cb);
  }

  onEvent(cb: (e: ChatEvent) => void): void {
    this.eventCbs.push(cb);
  }

  /** 重连 + re-auth 成功后触发（UI 据此重新 load_messages 补齐事件缺口）。 */
  onReconnected(cb: () => void): void {
    this.reconnectedCbs.push(cb);
  }

  onError(cb: (msg: string) => void): void {
    this.errorCbs.push(cb);
  }

  offStateChange(cb: (s: ConnState) => void): void {
    this.stateCbs = this.stateCbs.filter((c) => c !== cb);
  }

  offEvent(cb: (e: ChatEvent) => void): void {
    this.eventCbs = this.eventCbs.filter((c) => c !== cb);
  }

  offReconnected(cb: () => void): void {
    this.reconnectedCbs = this.reconnectedCbs.filter((c) => c !== cb);
  }

  /**
   * 发起连接（幂等：会先关掉旧连接）。
   * - {code}：桥接后停在 bridged，等 UI 调 pair()
   * - {deviceId, token}：桥接后自动 auth，成功到 authed
   */
  connect(creds: ConnectCreds): void {
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
    return new Promise((resolve, reject) => {
      this.pairWaiter = { resolve, reject };
      this.pendingPair = code;
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.send({ type: "pair", code });
      }
    });
  }

  /**
   * 发消息；sessionId 为 null 时新建会话（桌面侧生成 remote-* id）。
   * workspaceKey：目标工作区（编码 key）。缺省 = 桌面当前活动工作区。
   * 历史会话必须传其归属工作区（App 按会话→工作区映射取），否则 cwd 落错目录。
   */
  sendMessage(sessionId: string | null, prompt: string, workspaceKey?: string): void {
    const msg: PhoneToDesktop = { type: "send_message", prompt };
    if (sessionId) msg.session_id = sessionId;
    if (workspaceKey) msg.workspace_key = workspaceKey;
    this.send(msg);
  }

  loadMessages(sessionId: string): Promise<ChatMessageItem[]> {
    return this.request("messages", {
      type: "load_messages",
      session_id: sessionId,
    }) as Promise<ChatMessageItem[]>;
  }

  /** 会话列表；workspaceKey 缺省 = 桌面当前活动工作区。 */
  listSessions(workspaceKey?: string): Promise<Session[]> {
    const msg: PhoneToDesktop = { type: "list_sessions" };
    if (workspaceKey) msg.workspace_key = workspaceKey;
    return this.request("sessions", msg) as Promise<Session[]>;
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request("workspaces", { type: "list_workspaces" }) as Promise<Workspace[]>;
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
    this.failPending("已断开");
    this.setState("idle");
  }

  // ── 内部 ──

  private wsUrl(): string {
    return `${this.relayUrl.replace(/\/+$/, "")}/ws`;
  }

  private openOnce(): void {
    this.setState("connecting");
    const ws = this.wsFactory(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      const creds = this.creds;
      if (!creds) return;
      const first: RelayConnect =
        "code" in creds
          ? { type: "connect", code: creds.code }
          : { type: "connect", device_id: creds.deviceId, token: creds.token };
      ws.send(JSON.stringify(first));
      if ("token" in creds) {
        // 自动 re-auth
        this.send({ type: "auth", token: creds.token });
        this.authWaiter = {
          resolve: () => this.setState("authed"),
          reject: () => this.setState("needsPairing"),
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
      if (this.closedByUser) {
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
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.reconnecting = true;
      this.openOnce();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private handleMessage(raw: string): void {
    let msg: DesktopToPhone;
    try {
      msg = JSON.parse(raw) as DesktopToPhone;
    } catch {
      return;
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
      case "event": {
        this.eventCbs.forEach((cb) => cb(msg.event));
        break;
      }
      case "sessions": {
        this.resolvePending("sessions", msg.sessions);
        break;
      }
      case "workspaces": {
        this.resolvePending("workspaces", msg.workspaces);
        break;
      }
      case "messages": {
        this.resolvePending("messages", msg.messages);
        break;
      }
      case "error": {
        const p = this.pending.shift();
        if (p) p.reject(new Error(msg.message));
        else this.errorCbs.forEach((cb) => cb(msg.message));
        break;
      }
    }
  }

  private request(kind: PendingRequest["kind"], msg: PhoneToDesktop): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.push({ kind, resolve, reject });
      this.send(msg);
    });
  }

  private resolvePending(kind: PendingRequest["kind"], value: unknown): void {
    const idx = this.pending.findIndex((p) => p.kind === kind);
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      p.resolve(value);
    }
  }

  private failPending(reason: string): void {
    while (this.pending.length) {
      this.pending.shift()!.reject(new Error(reason));
    }
  }

  private send(msg: PhoneToDesktop): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error("未连接");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private setState(s: ConnState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateCbs.forEach((cb) => cb(s));
  }
}

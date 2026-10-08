/**
 * Aide Link v1 传输（真相源：docs/aide-link-protocol.md + crates/aide-link/src/frame.rs）。
 *
 * 分层（协议 §2）：WebSocket 文本 → 中继层帧（connect/keepalive/connect_error，仅中继模式）
 * → 安全通道（sc_init/sc_resp/sc_err/sc：Noise IK[+psk2] 握手 + ChaCha20-Poly1305 分块密文）
 * → Link 帧（hello/call/subscribe/event/…）。
 * 对上实现 AideTransport { invoke, listen }：invoke → call，listen → subscribe 后的 event。
 *
 * 与已退役 v2 的行为差异：
 *  - 凭据不再是 token：connect(StoredCreds, 身份密钥) 走 resume 握手，手机私钥就是凭据；
 *    pairWithOffer(offer, 身份密钥) 扫码配对，psk 只活在内存里
 *  - 失败二分：定性（unauthorized / no_pairing_offer / superseded…）→ needsPairing；
 *    瞬断（device_offline / ws 掉线 / 解密失败）→ offline + 退避重试（1s→30s + 抖动）
 *  - 配对竞态（§3.2/§4.2）：hello 一经发出即切 resume 语义——Host 收到有效 hello 才烧
 *    二维码并记下手机公钥，之后断线一律免扫码续连（重试 pair 反而会吃 no_pairing_offer）
 *  - 事件必须订阅：hello_ok 后自动 subscribe，since 带断线续传位置（§9）
 *  - ArkTS 化规则同 v2：DOM 事件类型 → 最小事件 interface；JSON 边界 as 探测判别
 */
import type { AideTransport, AideEvent } from './transport';
import { createOhosWs } from './ws-ohos';
import type { StoredCreds } from './storage';
import type { PairOffer } from './pair-uri';
import { EMPTY, KeyPair, NoiseHandshake, NoiseTransport, noisePrologue } from './crypto/noise';
import { x25519Public } from './crypto/x25519';
import { randomBytes } from './crypto/random';
import { b64Encode, b64Decode, b64urlDecode, utf8Encode, utf8Decode, concatBytes } from './crypto/bytes';

export type ConnState =
  'idle' | // 未连接（用户主动断开）
  'connecting' | // 正在连（中继/direct + 握手 + hello，直到 hello_ok）
  'authed' | // 已认证（hello_ok 已回，订阅已发），可收发
  'needsPairing' | // 定性失败：需重新扫码配对（凭据被吊销/顶替/二维码烧掉/版本不兼容）
  'offline'; // 瞬断：自动退避重试中

/** 断线续传位置（协议 §9）。 */
export interface SinceInfo {
  epoch: string;
  seq: number;
}

export interface PairDone {
  hostName: string | null;
}

export type PairFailCode = 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | 'aborted';

function pairFailText(code: PairFailCode): string {
  if (code === 'expired') {
    return '配对二维码已过期或已被使用';
  }
  if (code === 'badhandshake') {
    return '配对握手失败，请重新扫码';
  }
  if (code === 'revoked') {
    return '配对已被撤销或被新设备顶替';
  }
  if (code === 'unsupported') {
    return '协议版本不兼容，请升级应用';
  }
  return '已取消';
}

/** 配对失败（带类型化 code，UI 按码给文案；协议 §10 错误码封闭集合）。 */
export class PairFailError extends Error {
  readonly code: PairFailCode;

  constructor(code: PairFailCode) {
    super(pairFailText(code));
    this.code = code;
  }
}

// ── 最小事件形状（ArkTS 无 DOM lib；ws-ohos.ets 按此适配）──

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

/** 外链打开注入点（平台绑定：ohos 由 ws-ohos.ets 的 makeOpenUrl 提供）。 */
export type OpenUrlFn = (url: string) => void;

// ── 中继层帧（协议 §2.2；仅中继模式可见）──

interface RelayConnectMsg {
  type: 'connect';
  device_id: string;
}

interface KeepaliveMsg {
  type: 'keepalive';
}

interface ConnectErrorMsg {
  type: 'connect_error';
  reason: string;
}

// ── 安全通道外层帧（协议 §4.1）──

interface ScInitMsg {
  type: 'sc_init';
  versions: number[];
  mode: string;
  msg: string;
}

interface ScRespMsg {
  type: 'sc_resp';
  version: number;
  msg: string;
}

interface ScErrMsg {
  type: 'sc_err';
  code: string;
  message: string;
}

interface ScDataMsg {
  type: 'sc';
  c: string;
  last: boolean;
}

// ── Link 内层帧（协议 §6；密文承载）──

interface ClientInfo {
  name: string;
  version: string;
  platform: string;
}

interface HelloMsg {
  type: 'hello';
  client: ClientInfo;
}

interface HostInfo {
  id: string;
  name: string;
  os: string;
  arch: string;
  version: string;
}

interface HelloOkMsg {
  type: 'hello_ok';
  version: number;
  host: HostInfo;
  granted: string[];
}

interface CallMsg {
  type: 'call';
  id: number;
  method: string;
  params: Record<string, Object>;
}

interface ResultMsg {
  type: 'result';
  id: number;
  value: Object | null;
}

interface ErrorMsg {
  type: 'error';
  id: number;
  code: string;
  message: string;
}

interface SubscribeMsg {
  type: 'subscribe';
  sessions: null;
  since: SinceInfo | null;
}

interface SubscribedMsg {
  type: 'subscribed';
  epoch: string;
  seq: number;
  resumed: boolean;
  gap: boolean;
  replayed: number;
}

interface EventMsg {
  type: 'event';
  seq: number;
  name: string;
  payload: Record<string, Object>;
}

interface PingMsg {
  type: 'ping';
  n: number;
}

interface PongMsg {
  type: 'pong';
  n: number;
}

interface ByeMsg {
  type: 'bye';
  code: string;
  message: string;
}

/** JSON 边界探测：只信 type 判别字段，各臂字段经协议文档对账。 */
interface WireProbe {
  type: string;
}

interface LinkProbe {
  type: string;
}

interface PendingInvoke {
  resolve: (v: Object | null) => void;
  reject: (e: Error) => void;
}

interface PairWaiter {
  resolve: (v: PairDone) => void;
  /** 只收 PairFailError（定性失败/取消）；Error 是 lib 接口，传子类会踩结构化类型。 */
  reject: (e: PairFailError) => void;
}

const WS_OPEN = 1;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
/** 中继层活体帧间隔：中继收到首帧后武装 60s 静默超时（§2.2）。端到端 ping 也挂同一 tick。 */
const KEEPALIVE_INTERVAL_MS = 20000;
/** 握手全程上限：openOnce → authed / 定性结论。TCP 黑洞 / 中继挂死 / 半开连接救不了的场景。 */
const HANDSHAKE_TIMEOUT_MS = 15000;
/** sc 分块（§4.3）：明文按 32768 字节切块，末块 last:true。 */
const SC_CHUNK_BYTES = 32768;
/** 重组后 Link 帧上限 8 MiB（§2.1），超过即断开。 */
const MAX_FRAME_BYTES = 8388608;

type StateCb = (s: ConnState) => void;
type EventCb = (e: AideEvent<Object>) => void;
type ReconnectedCb = () => void;
type SubscribedCb = () => void;
type ErrorCb = (msg: string) => void;

export class RemoteTransport implements AideTransport {
  private ws: WsLike | null = null;
  private readonly wsFactory: (url: string) => WsLike;
  private readonly openUrlImpl: OpenUrlFn | null;
  private _state: ConnState = 'idle';
  private stateCbs: StateCb[] = [];
  private eventCbs: Map<string, Set<EventCb>> = new Map();
  private reconnectedCbs: ReconnectedCb[] = [];
  private subscribedCbs: SubscribedCb[] = [];
  private errorCbs: ErrorCb[] = [];
  private pending: Map<number, PendingInvoke> = new Map();
  private nextCallId = 0;
  /** 配对结果挂起：定性失败/用户取消才 reject；瞬断重试期间保持挂起。 */
  private pairWaiter: PairWaiter | null = null;
  /** 本次连接由 pairWithOffer 发起（hello_ok 时据此 resolve pairWaiter）。 */
  private pairingFlow = false;
  private mode: 'pair' | 'resume' = 'resume';
  private myKey: KeyPair | null = null;
  private deviceId = '';
  private hostPublic: Uint8Array | null = null;
  /** 一次性配对密钥：只活在内存，hello 发出即清（§3.1 psk 永不落盘/写日志）。 */
  private psk: Uint8Array | null = null;
  /** 中继基址（拼 /ws）；null = direct 直连（不发中继帧）。 */
  private relayBase: string | null = null;
  private directUrl: string | null = null;
  private hostNameInternal: string | null = null;
  /** 续传位置：event.seq 取 max；subscribed 按 §9 表格收敛。 */
  private since: SinceInfo | null = null;
  /** 传输态加解密（sc_resp 处理完成后非空）。 */
  private noiseT: NoiseTransport | null = null;
  private handshake: NoiseHandshake | null = null;
  private rxChunks: Uint8Array[] = [];
  private rxLen = 0;
  private lastPingN = 0;
  private backoffMs = BACKOFF_BASE_MS;
  private reconnectTimer: number | null = null;
  private keepaliveTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private closedByUser = false;
  private reconnecting = false;
  /** 定性结论在途：sc_err/bye/connect_error{superseded} 设定，onclose/看门狗统一收尾。 */
  private definitivePending: PairFailCode | null = null;

  constructor(wsFactory?: (url: string) => WsLike, openUrl?: OpenUrlFn) {
    this.wsFactory = wsFactory ?? ((url: string) => createOhosWs(url));
    this.openUrlImpl = openUrl ?? null;
  }

  // ── AideTransport ──

  invoke<T>(command: string, params?: Record<string, Object>): Promise<T> {
    return new Promise<T>((resolve: (v: T) => void, reject: (e: Error) => void) => {
      const id = ++this.nextCallId;
      // JSON 边界：value 是动态值，T 是调用方声明的期望形状（收窄责任在 api 门面）。
      this.pending.set(id, { resolve: (v: Object | null) => resolve(v as T), reject: reject });
      try {
        // 协议要求 params 恒为对象（§6.2；无参命令传 {}）
        const m: CallMsg = { type: 'call', id: id, method: command, params: params ?? {} };
        this.sendLink(m);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  listen<T>(event: string, cb: (e: AideEvent<T>) => void): Promise<() => void> {
    if (event !== 'chat-event' && event !== 'system-notification' && event !== 'permissions-changed') {
      // Link 事件目录（§8）之外的名字收不到推送——显式 no-op 让误用在开发期可见
      console.warn(`[sdk] RemoteTransport: 事件 "${event}" 不在 Link 事件目录，按 no-op 处理`);
      return Promise.resolve(() => {});
    }
    let set = this.eventCbs.get(event);
    if (!set) {
      set = new Set<EventCb>();
      this.eventCbs.set(event, set);
    }
    const target = set;
    // cb 的 payload 泛型在边界处擦除——事件生产端（Host）与消费端共享同一形状约定。
    const wrapped = cb as EventCb;
    target.add(wrapped);
    return Promise.resolve(() => {
      target.delete(wrapped);
    });
  }

  /** 远端语义：外链在手机本地打开（不是 Host 宿主机的浏览器）。 */
  openExternal(url: string): Promise<void> {
    if (this.openUrlImpl) {
      this.openUrlImpl(url);
    } else {
      console.warn(`[sdk] openUrl 未注入，忽略外链：${url}`);
    }
    return Promise.resolve();
  }

  // ── 连接管理（ConnModel 消费）──

  get state(): ConnState {
    return this._state;
  }

  /** Host 显示名（hello_ok 里来的；配对期间用二维码里的 n）。 */
  get hostName(): string | null {
    return this.hostNameInternal;
  }

  /** 当前续传位置（ConnModel 持久化到 StoredCreds.epoch/lastSeq）。 */
  getResumeInfo(): SinceInfo | null {
    return this.since;
  }

  onStateChange(cb: StateCb): void {
    this.stateCbs.push(cb);
  }

  offStateChange(cb: StateCb): void {
    this.stateCbs = this.stateCbs.filter((c: StateCb) => c !== cb);
  }

  /** 重连 + 重新订阅成功后触发（UI 据此整页重拉；无缝续传时多拉一次无害）。 */
  onReconnected(cb: ReconnectedCb): void {
    this.reconnectedCbs.push(cb);
  }

  offReconnected(cb: ReconnectedCb): void {
    this.reconnectedCbs = this.reconnectedCbs.filter((c: ReconnectedCb) => c !== cb);
  }

  /** 每次 subscribed 后触发（ConnModel 持久化续传位置）。 */
  onSubscribed(cb: SubscribedCb): void {
    this.subscribedCbs.push(cb);
  }

  onError(cb: ErrorCb): void {
    this.errorCbs.push(cb);
  }

  /**
   * 已配对续连（幂等：会先掐掉旧连接）。resume 握手——手机的静态私钥就是凭据（§4.2）。
   */
  connect(creds: StoredCreds, myKey: KeyPair): void {
    let hostPublic: Uint8Array;
    try {
      hostPublic = b64urlDecode(creds.hostPublic);
    } catch (e) {
      // 不可达：storage.loadCreds 已做 32 字节校验（防御，避免 onCreate 崩溃）
      this.setState('needsPairing');
      return;
    }
    this.prepareNewSession();
    this.mode = 'resume';
    this.pairingFlow = false;
    this.myKey = myKey;
    this.deviceId = creds.deviceId;
    this.hostPublic = hostPublic;
    this.psk = null;
    this.relayBase = creds.relayUrl;
    this.directUrl = creds.directUrl;
    this.since = creds.epoch !== null ? { epoch: creds.epoch, seq: creds.lastSeq } : null;
    this.hostNameInternal = creds.hostName;
    this.openOnce();
  }

  /**
   * 扫码配对（§3.2）：pair 握手（psk）→ hello（= 配对确认，Host 收到才烧二维码）
   * → hello_ok = 配对成功。瞬断期间 promise 保持挂起（退避重连继续配对，
   * 二维码 10 分钟窗口内有效）；只有定性失败 / 用户取消才 reject。
   */
  pairWithOffer(offer: PairOffer, myKey: KeyPair): Promise<PairDone> {
    return new Promise<PairDone>((resolve: (v: PairDone) => void, reject: (e: PairFailError) => void) => {
      this.prepareNewSession();
      this.pairWaiter = { resolve: resolve, reject: reject };
      this.mode = 'pair';
      this.pairingFlow = true;
      this.myKey = myKey;
      this.deviceId = offer.deviceId;
      this.hostPublic = offer.hostPublic;
      this.psk = offer.psk;
      this.relayBase = offer.relay;
      this.directUrl = offer.direct;
      this.since = null; // 配对后从零订阅：不回放（§9 首次订阅）
      this.hostNameInternal = offer.name;
      this.openOnce();
    });
  }

  /** 主动断开：停止重连，回 idle；挂起中的配对按取消拒绝。 */
  disconnect(): void {
    this.closedByUser = true;
    this.stopKeepalive();
    this.stopHandshakeTimer();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
    this.failPending('已断开');
    if (this.pairWaiter !== null) {
      const w = this.pairWaiter;
      this.pairWaiter = null;
      w.reject(new PairFailError('aborted'));
    }
    this.pairingFlow = false;
    this.psk = null;
    this.setState('idle');
  }

  // ── 内部：连接生命周期 ──

  /** 新一轮连接的公共复位：掐旧连接、清计时器、作废旧挂起（配对按取消拒绝）。 */
  private prepareNewSession(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHandshakeTimer();
    if (this.ws !== null) {
      this.closedByUser = true; // 旧连接的 onclose 不触发重连（ws 身份守卫也会拦下）
      this.stopKeepalive();
      this.ws.close();
      this.ws = null;
    }
    this.closedByUser = false;
    this.reconnecting = false;
    this.definitivePending = null;
    this.backoffMs = BACKOFF_BASE_MS;
    if (this.pairWaiter !== null) {
      const w = this.pairWaiter;
      this.pairWaiter = null;
      w.reject(new PairFailError('aborted'));
    }
    this.failPending('已断开');
  }

  private wsUrl(): string {
    if (this.relayBase !== null) {
      return `${this.relayBase.replace(/\/+$/, '')}/ws`;
    }
    return this.directUrl ?? '';
  }

  private openOnce(): void {
    this.noiseT = null;
    this.handshake = null;
    this.rxChunks = [];
    this.rxLen = 0;
    this.setState('connecting');
    const url: string = this.wsUrl();
    if (url === '') {
      // 不可达：connect/pairWithOffer 都保证地址恰有一个（防御）
      this.setState('needsPairing');
      return;
    }
    const ws: WsLike = this.wsFactory(url);
    this.ws = ws;
    this.startHandshakeTimer(ws);
    ws.onopen = (ev: WsOpenEvent) => {
      this.onWsOpen(ws);
    };
    ws.onmessage = (ev: WsMessageEvent) => {
      try {
        this.handleWire(String(ev.data));
      } catch (e) {
        // 帧处理器的意外异常只记日志：协议状态由各分支自行维护
        console.warn(`[link] 帧处理异常：${e}`);
      }
    };
    ws.onclose = (ev: WsCloseEvent) => {
      this.onWsClose(ws);
    };
    ws.onerror = (_ev: WsErrorEvent) => {
      // onclose 会跟随
    };
  }

  private onWsOpen(ws: WsLike): void {
    // 中继模式先说中继层 connect（按 device_id 寻址 Host，§2.2）；
    // direct 直连跳过，连上直接说安全通道（§3.1）
    if (this.relayBase !== null) {
      const m: RelayConnectMsg = { type: 'connect', device_id: this.deviceId };
      ws.send(JSON.stringify(m));
    }
    this.startKeepalive(ws);
    this.sendScInit(ws);
  }

  private sendScInit(ws: WsLike): void {
    const myKey = this.myKey;
    const hostPublic = this.hostPublic;
    if (myKey === null || hostPublic === null) {
      return; // 不可达：connect/pairWithOffer 恒先设（防御；看门狗兜底）
    }
    // 每次连接都现做临时密钥（前向保密，§2.3）；NoiseHandshake 不内置随机源
    const epriv: Uint8Array = randomBytes(32);
    const ephemeral: KeyPair = { privateKey: epriv, publicKey: x25519Public(epriv) };
    const hs: NoiseHandshake =
      new NoiseHandshake('initiator', myKey, hostPublic, noisePrologue(this.deviceId),
        { psk: this.psk, fixedEphemeral: ephemeral });
    const msg1: Uint8Array = hs.writeMessage(EMPTY); // 96 字节（§4.2）
    this.handshake = hs;
    const m: ScInitMsg = { type: 'sc_init', versions: [1], mode: this.mode, msg: b64Encode(msg1) };
    ws.send(JSON.stringify(m));
  }

  private onWsClose(ws: WsLike): void {
    if (this.ws !== ws) {
      return; // 已被新连接替换 / 看门狗已收尾
    }
    this.ws = null;
    this.stopKeepalive();
    this.stopHandshakeTimer();
    if (this.closedByUser) {
      this.setState('idle');
      return;
    }
    if (this.definitivePending !== null) {
      this.finalizeDefinitive();
      return;
    }
    // 瞬断：挂起调用失败；pairWaiter 保持挂起——退避重连继续配对
    this.failPending('连接断开');
    this.setState('offline');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) {
      return;
    }
    const jitter: number = Math.floor(Math.random() * 500); // 0–500ms 抖动（§9）
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) {
        return;
      }
      this.reconnecting = true;
      this.openOnce();
    }, this.backoffMs + jitter);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  /** 单 tick 双活体：中继 keepalive（哑管道消费不转发）+ 端到端 ping（§6.4）。
   *  e2e ping 只在 authed 后发——hello 之前发 ping 违反阶段规则（§5）会被
   *  bye{protocol_error} 踢掉。 */
  private startKeepalive(ws: WsLike): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WS_OPEN) {
        return;
      }
      try {
        if (this.relayBase !== null) {
          const k: KeepaliveMsg = { type: 'keepalive' };
          ws.send(JSON.stringify(k));
        }
        if (this._state === 'authed' && this.noiseT !== null) {
          this.lastPingN++;
          const p: PingMsg = { type: 'ping', n: this.lastPingN };
          this.sendLink(p);
        }
      } catch (e) {
        // 发送抛错 = 连接将死：onclose 会接管
        console.warn(`[link] 心跳发送失败：${e}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** 握手看门狗：openOnce 起计时，authed / 定性结论前超时则强制掐断。
   *  覆盖 TCP 黑洞、中继挂死、半开连接——ws.close() 的关闭握手可能永不到达，
   *  故转移逻辑在此完整执行；迟到的 onclose 由 ws 身份守卫拦下。 */
  private startHandshakeTimer(ws: WsLike): void {
    this.stopHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws !== ws || this.closedByUser) {
        return;
      }
      if (this._state !== 'connecting') {
        return; // 已有结论（authed 时 setState 已解除看门狗，此为双保险）
      }
      this.ws = null; // 先置空拦下迟到/同步的 onclose
      this.stopKeepalive();
      ws.close();
      this.failPending('握手超时');
      if (this.definitivePending !== null) {
        this.finalizeDefinitive();
        return;
      }
      // pairWaiter 保持挂起：退避重连继续配对
      this.setState('offline');
      this.scheduleReconnect();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private stopHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  // ── 内部：外层帧（中继 + 安全通道）──

  private handleWire(raw: string): void {
    let probe: WireProbe;
    try {
      probe = JSON.parse(raw) as WireProbe;
    } catch (e) {
      return; // 坏帧：哑管道中间产物或截断，丢弃（无状态损坏）
    }
    switch (probe.type) {
      case 'connect_error': {
        const m = probe as ConnectErrorMsg;
        if (m.reason === 'superseded') {
          this.failDefinitive('revoked');
        } else {
          // device_offline / unknown_code：瞬断，close → onclose 走 offline 退避
          this.killChannel();
        }
        break;
      }
      case 'sc_resp': {
        this.handleScResp(probe as ScRespMsg);
        break;
      }
      case 'sc_err': {
        this.handleScErr(probe as ScErrMsg);
        break;
      }
      case 'sc': {
        this.handleScChunk(probe as ScDataMsg);
        break;
      }
      default:
        // 未知外层帧：忽略（§2.1 向前兼容）
        break;
    }
  }

  private handleScResp(m: ScRespMsg): void {
    const hs = this.handshake;
    if (hs === null) {
      // 未发 sc_init 就来 sc_resp：协议违规
      this.killChannel();
      return;
    }
    let msg2: Uint8Array;
    try {
      msg2 = b64Decode(m.msg);
    } catch (e) {
      this.killChannel();
      return;
    }
    try {
      hs.readMessage(msg2); // 失败 = psk 不对 / 连错 Host（§4.2）
    } catch (e) {
      this.killChannel();
      return;
    }
    this.handshake = null;
    this.noiseT = hs.split();
    this.sendHello();
    // 配对提交竞态（§3.2/§4.2）：hello 已发出——Host 收到有效 hello 即烧二维码并
    // 记下手机公钥；此后断线重连一律 resume（重试 pair 会吃 no_pairing_offer）。
    // psk 用完即清（§3.1：不落盘、不重用）。
    if (this.mode === 'pair') {
      this.mode = 'resume';
      this.psk = null;
    }
  }

  private handleScErr(m: ScErrMsg): void {
    const code: string = m.code;
    if (code === 'unauthorized') {
      // resume 的公钥不是已配对那把：被顶替 / 撤销（§9.2）——不重试
      this.failDefinitive('revoked');
    } else if (code === 'no_pairing_offer' && this.mode === 'pair') {
      // 二维码过期 / 已被用掉 / 没生成（§4.1）
      this.failDefinitive('expired');
    } else if (code === 'bad_handshake' && this.mode === 'pair') {
      this.failDefinitive('badhandshake');
    } else if (code === 'unsupported_version') {
      this.failDefinitive('unsupported');
    } else {
      // timeout / protocol_error / too_large / internal / resume 下的握手坏帧：瞬断重试
      this.killChannel();
    }
  }

  private handleScChunk(m: ScDataMsg): void {
    const t = this.noiseT;
    if (t === null) {
      // 握手未完成就来密文：协议违规
      this.killChannel();
      return;
    }
    let chunk: Uint8Array;
    try {
      chunk = t.open(b64Decode(m.c));
    } catch (e) {
      // 解密失败 = 通道不可信（重放/乱序/篡改，§4.3）：立即断开
      this.killChannel();
      return;
    }
    if (this.rxLen + chunk.length > MAX_FRAME_BYTES) {
      this.killChannel();
      return;
    }
    this.rxChunks.push(chunk);
    this.rxLen += chunk.length;
    if (!m.last) {
      return;
    }
    const frame: Uint8Array = concatBytes(this.rxChunks);
    this.rxChunks = [];
    this.rxLen = 0;
    this.handleLink(utf8Decode(frame));
  }

  /** 掐断当前连接：瞬断语义（onclose → offline 退避）；定性结论由 definitivePending 携带。 */
  private killChannel(): void {
    const ws = this.ws;
    if (ws === null) {
      if (this.definitivePending !== null) {
        this.finalizeDefinitive(); // 连接已不在：直接收尾（防御双保险）
      }
      return;
    }
    this.stopKeepalive();
    ws.close(); // onclose 收尾；TCP 已死时看门狗兜底
  }

  private failDefinitive(code: PairFailCode): void {
    if (this.definitivePending !== null) {
      return; // 已有定性结论在途
    }
    this.definitivePending = code;
    this.killChannel();
  }

  private finalizeDefinitive(): void {
    const code: PairFailCode = this.definitivePending === null ? 'revoked' : this.definitivePending;
    this.definitivePending = null;
    this.stopKeepalive();
    this.stopHandshakeTimer();
    this.failPending('连接已终止');
    this.psk = null;
    this.pairingFlow = false;
    if (this.pairWaiter !== null) {
      const w = this.pairWaiter;
      this.pairWaiter = null;
      w.reject(new PairFailError(code));
    }
    this.setState('needsPairing');
  }

  // ── 内部：Link 帧 ──

  private sendHello(): void {
    const client: ClientInfo = { name: 'aide-ohos', version: '1', platform: 'harmonyos' };
    const m: HelloMsg = { type: 'hello', client: client };
    this.sendLink(m);
  }

  private handleLink(raw: string): void {
    let probe: LinkProbe;
    try {
      probe = JSON.parse(raw) as LinkProbe;
    } catch (e) {
      // 重组后的 Link 帧不是合法 JSON：对端坏帧或截断——掐断
      this.killChannel();
      return;
    }
    switch (probe.type) {
      case 'hello_ok': {
        this.handleHelloOk(probe as HelloOkMsg);
        break;
      }
      case 'subscribed': {
        this.handleSubscribed(probe as SubscribedMsg);
        break;
      }
      case 'event': {
        this.handleEvent(probe as EventMsg);
        break;
      }
      case 'result': {
        const m = probe as ResultMsg;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p.resolve(m.value);
        }
        break;
      }
      case 'error': {
        const m = probe as ErrorMsg;
        const text: string =
          typeof m.message === 'string' && m.message !== '' ? m.message : m.code;
        if (typeof m.id === 'number') {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            p.reject(new Error(text));
            break;
          }
        }
        // 无对应挂起（invalid_frame / busy / 未知码按 failed 处理，§10）：上报展示
        this.errorCbs.forEach((cb: ErrorCb) => cb(text));
        break;
      }
      case 'ping': {
        const m = probe as PingMsg;
        const pong: PongMsg = { type: 'pong', n: m.n };
        this.sendLink(pong);
        break;
      }
      case 'bye': {
        const m = probe as ByeMsg;
        if (m.code === 'superseded' || m.code === 'revoked') {
          // 单设备模型：清凭据回配对，不自动重连（§6.5）
          this.failDefinitive('revoked');
        } else {
          // timeout / shutdown / too_large / protocol_error：瞬断退避重试
          this.killChannel();
        }
        break;
      }
      default:
        // 未知 Link 帧：忽略（§2.1 客户端忽略未知 Host 帧类型）
        break;
    }
  }

  private handleHelloOk(m: HelloOkMsg): void {
    if (this._state !== 'connecting') {
      return; // 重复/迟到的 hello_ok
    }
    const host = m.host;
    if (typeof host === 'object' && host !== null && typeof host.name === 'string') {
      this.hostNameInternal = host.name;
    }
    this.setState('authed'); // 解除看门狗
    if (this.pairingFlow && this.pairWaiter !== null) {
      this.pairingFlow = false;
      const w = this.pairWaiter;
      this.pairWaiter = null;
      w.resolve({ hostName: this.hostNameInternal });
    }
    // 事件必须订阅才推送（§6.3）；since 带断线续传位置（§9）
    const sub: SubscribeMsg = { type: 'subscribe', sessions: null, since: this.since };
    this.sendLink(sub);
  }

  private handleSubscribed(m: SubscribedMsg): void {
    if (m.resumed && this.since !== null) {
      // 原 Host 续传成功（§9 表第 1/2 行）：epoch 以 Host 为准；seq 保持——
      // 错过的事件正按序回放，event.seq 会推进到 Host 当前尾
      this.since = { epoch: m.epoch, seq: this.since.seq };
    } else {
      // 首次订阅（配对后）或 Host 重启过 epoch 变了（§9 表第 3 行）：
      // 位置重置为 Host 当前尾（UI 已全量重拉）
      this.since = { epoch: m.epoch, seq: m.seq };
    }
    this.subscribedCbs.forEach((cb: SubscribedCb) => cb());
    if (this.reconnecting) {
      this.reconnecting = false;
      // gap / epoch 变化同样触发：消费方本就整页重拉，无缝时多拉一次无害
      this.reconnectedCbs.forEach((cb: ReconnectedCb) => cb());
    }
  }

  private handleEvent(m: EventMsg): void {
    const since = this.since;
    if (since !== null && m.seq > since.seq) {
      this.since = { epoch: since.epoch, seq: m.seq };
    }
    const set = this.eventCbs.get(m.name);
    if (set) {
      set.forEach((cb: EventCb) => cb({ payload: m.payload }));
    }
  }

  // ── 内部：发送 ──

  /** 发一个 Link 帧：JSON → UTF-8 → 32768 分块 → 逐块加密成 sc 帧（§4.3）。 */
  private sendLink(frame: Object): void {
    const t = this.noiseT;
    if (t === null) {
      throw new Error('安全通道未建立');
    }
    this.sendChunks(t, utf8Encode(JSON.stringify(frame)));
  }

  private sendChunks(t: NoiseTransport, plain: Uint8Array): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) {
      throw new Error('未连接');
    }
    const total: number = plain.length;
    let off = 0;
    // 空明文也发一块（last:true，§4.3）
    while (true) {
      const end: number = Math.min(off + SC_CHUNK_BYTES, total);
      const block: Uint8Array = plain.subarray(off, end);
      const m: ScDataMsg = { type: 'sc', c: b64Encode(t.seal(block)), last: end >= total };
      ws.send(JSON.stringify(m));
      if (end >= total) {
        break;
      }
      off = end;
    }
  }

  private failPending(reason: string): void {
    this.pending.forEach((p: PendingInvoke) => p.reject(new Error(reason)));
    this.pending.clear();
  }

  private setState(s: ConnState): void {
    if (this._state === s) {
      return;
    }
    this._state = s;
    // 握手有结论（authed / 定性失败）：解除看门狗
    if (s === 'authed' || s === 'needsPairing') {
      this.stopHandshakeTimer();
    }
    this.stateCbs.forEach((cb: StateCb) => cb(s));
  }
}

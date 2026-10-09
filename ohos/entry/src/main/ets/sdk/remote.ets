/**
 * Aide Link v1 传输编排层（真相源：docs/aide-link-protocol.md + crates/aide-link/src/frame.rs）。
 *
 * 分层（协议 §2）：本文件只做「会话策略」——连接生命周期编排、重连退避、配对
 * 流程、Link 帧路由与 AideTransport 门面。单次连接的 wire 细节（中继层帧、
 * Noise 握手、sc 分块、看门狗、keepalive）全部内聚在 sdk/link/attempt.ets 的
 * ConnAttempt：一次连接一个实例，终局（瞬断/定性/废弃）后结构性失声，迟到的
 * socket 事件不再需要任何身份守卫。公开类型在 sdk/link/types.ets，经本文件
 * re-export 保持原导入面（ConnModel/ConnectPage/ws-ohos 零改动）。
 * 对上实现 AideTransport { invoke, listen }：invoke → call，listen → subscribe 后的 event。
 *
 * 与已退役 v2 的行为差异：
 *  - 凭据不再是 token：connect(StoredCreds, 身份密钥) 走 resume 握手，手机私钥就是凭据；
 *    pairWithOffer(offer, 身份密钥) 扫码配对，psk 只活在内存里
 *  - 失败二分：定性（unauthorized / no_pairing_offer / superseded…）→ needsPairing；
 *    瞬断（device_offline / ws 掉线 / 解密失败）→ offline + 退避重试（1s→30s + 抖动，
 *    上次连接存活 ≥30s 归零）
 *  - 配对竞态（§3.2/§4.2）：hello 一经发出即切 resume 语义——Host 收到有效 hello 才烧
 *    二维码并记下手机公钥，之后断线一律免扫码续连（重试 pair 反而会吃 no_pairing_offer）
 *  - 事件必须订阅：hello_ok 后自动 subscribe，since 带断线续传位置（§9）
 *  - ArkTS 化规则同 v2：DOM 事件类型 → 最小事件 interface；JSON 边界 as 探测判别
 */
import type { AideTransport, AideEvent } from './transport';
import { createOhosWs } from './ws-ohos';
import type { StoredCreds } from './storage';
import type { PairOffer } from './pair-uri';
import type { KeyPair } from './crypto/noise';
import { b64urlDecode } from './crypto/bytes';
import { ConnAttempt, AttemptConfig } from './link/attempt';
import { Backoff, STABLE_CONN_MS } from './link/backoff';
import { PairFailError } from './link/types';
import type {
  ByeMsg, CallMsg, ClientInfo, ErrorMsg, EventMsg, HelloMsg, HelloOkMsg, LinkProbe,
  PingMsg, PongMsg, ResultMsg, SubscribeMsg, SubscribedMsg
} from './link/frames';
import type { ConnState, OpenUrlFn, PairDone, PairFailCode, SinceInfo, WsLike } from './link/types';

export { PairFailError } from './link/types';
export type {
  ConnState, SinceInfo, PairDone, PairFailCode, WsLike, WsOpenEvent,
  WsMessageEvent, WsCloseEvent, WsErrorEvent, OpenUrlFn
} from './link/types';

interface PendingInvoke {
  resolve: (v: Object | null) => void;
  reject: (e: Error) => void;
}

interface PairWaiter {
  resolve: (v: PairDone) => void;
  /** 只收 PairFailError（定性失败/取消）；Error 是 lib 接口，传子类会踩结构化类型。 */
  reject: (e: PairFailError) => void;
}

type StateCb = (s: ConnState) => void;
type EventCb = (e: AideEvent<Object>) => void;
type ReconnectedCb = () => void;
type SubscribedCb = () => void;
type ErrorCb = (msg: string) => void;

export class RemoteTransport implements AideTransport {
  /** 在途连接尝试（一次连接一个实例；终局后被置 null，实例结构性失声）。 */
  private current: ConnAttempt | null = null;
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
  private readonly backoff: Backoff = new Backoff();
  private reconnectTimer: number | null = null;
  /** 本次成功订阅来自重连（而非首连）：subscribed 时据此触发 reconnectedCbs。 */
  private reconnecting = false;

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
        this.sendLinkOrThrow(m);
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
    this.spawnAttempt();
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
      this.spawnAttempt();
    });
  }

  /** 主动断开：废弃在途连接、停止重连，回 idle；挂起中的配对按取消拒绝。 */
  disconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.current !== null) {
      this.current.dispose();
      this.current = null;
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

  /** 新一轮连接的公共复位：废弃在途连接、清重连计时、退避归零、作废旧挂起
   *  （配对按取消拒绝）。在途 attempt 经 dispose 结构性失声，无收尾竞态。 */
  private prepareNewSession(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.current !== null) {
      this.current.dispose();
      this.current = null;
    }
    this.reconnecting = false;
    this.backoff.reset();
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

  /** 起一次连接尝试：接线四个回调，attempt 独占 wire 层直到终局。 */
  private spawnAttempt(): void {
    this.setState('connecting');
    const url: string = this.wsUrl();
    if (url === '') {
      // 不可达：connect/pairWithOffer 都保证地址恰有一个（防御）
      this.setState('needsPairing');
      return;
    }
    const myKey: KeyPair | null = this.myKey;
    const hostPublic: Uint8Array | null = this.hostPublic;
    if (myKey === null || hostPublic === null) {
      // 不可达：connect/pairWithOffer 恒先设（防御）
      this.setState('needsPairing');
      return;
    }
    const cfg: AttemptConfig = new AttemptConfig(url, this.relayBase !== null, this.deviceId,
      this.mode, this.psk, myKey, hostPublic, this.wsFactory);
    const attempt: ConnAttempt = new ConnAttempt(cfg);
    attempt.onChannelReady = (): void => {
      // 安全通道就绪即发 hello（= 配对确认）；配对提交竞态（§3.2/§4.2）：
      // hello 一经发出即切 resume 语义——Host 收到有效 hello 才烧二维码并记下
      // 手机公钥，之后断线重连一律 resume（重试 pair 会吃 no_pairing_offer）；
      // psk 用完即清（§3.1：不落盘、不重用）。
      const client: ClientInfo = { name: 'aide-ohos', version: '1', platform: 'harmonyos' };
      const m: HelloMsg = { type: 'hello', client: client };
      attempt.sendLink(m);
      if (this.mode === 'pair') {
        this.mode = 'resume';
        this.psk = null;
      }
    };
    attempt.onLinkFrame = (raw: string): void => {
      this.handleLink(raw, attempt);
    };
    attempt.onTransient = (reason: string): void => {
      this.handleTransient(attempt, reason);
    };
    attempt.onDefinitive = (code: PairFailCode): void => {
      this.handleDefinitive(code);
    };
    this.current = attempt;
  }

  /** attempt 瞬断收尾：作废引用、挂起调用按因失败、进 offline、按寿命判据调度重连。 */
  private handleTransient(attempt: ConnAttempt, reason: string): void {
    this.current = null;
    this.failPending(reason);
    this.setState('offline');
    this.scheduleReconnect(attempt);
  }

  /** attempt 定性收尾：不再重连；清一次性密态；配对按码拒绝；回 needsPairing。 */
  private handleDefinitive(code: PairFailCode): void {
    this.current = null;
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

  /** 退避重连：上次连接存活 ≥ STABLE_CONN_MS 视为健康史 → 退避归零；否则翻倍
   *  加抖动。仅瞬断路径进入；用户断开/新会话路径已清 reconnectTimer，无竞态。 */
  private scheduleReconnect(ended: ConnAttempt): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const lifetime: number = Date.now() - ended.startedAt();
    if (lifetime >= STABLE_CONN_MS) {
      this.backoff.reset();
    }
    const delay: number = this.backoff.next();
    console.info(`[link] ${delay}ms 后重连（上次连接存活 ${lifetime}ms）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = true;
      this.spawnAttempt();
    }, delay);
  }

  // ── 内部：Link 帧路由 ──

  private handleLink(raw: string, attempt: ConnAttempt): void {
    let probe: LinkProbe;
    try {
      probe = JSON.parse(raw) as LinkProbe;
    } catch (e) {
      // 重组后的 Link 帧不是合法 JSON：对端坏帧或截断——瞬断重连
      attempt.killTransient('连接断开');
      return;
    }
    switch (probe.type) {
      case 'hello_ok': {
        this.handleHelloOk(probe as HelloOkMsg, attempt);
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
        attempt.sendLink(pong);
        break;
      }
      case 'bye': {
        const m = probe as ByeMsg;
        if (m.code === 'superseded' || m.code === 'revoked') {
          // 单设备模型：清凭据回配对，不自动重连（§6.5）
          attempt.killDefinitive('revoked');
        } else {
          // timeout / shutdown / too_large / protocol_error：瞬断退避重试
          attempt.killTransient('连接断开');
        }
        break;
      }
      default:
        // 未知 Link 帧：忽略（§2.1 客户端忽略未知 Host 帧类型）
        break;
    }
  }

  private handleHelloOk(m: HelloOkMsg, attempt: ConnAttempt): void {
    if (this._state !== 'connecting') {
      return; // 重复/迟到的 hello_ok
    }
    const host = m.host;
    if (typeof host === 'object' && host !== null && typeof host.name === 'string') {
      this.hostNameInternal = host.name;
    }
    this.setState('authed');
    attempt.markAuthed();
    if (this.pairingFlow && this.pairWaiter !== null) {
      this.pairingFlow = false;
      const w = this.pairWaiter;
      this.pairWaiter = null;
      w.resolve({ hostName: this.hostNameInternal });
    }
    // 事件必须订阅才推送（§6.3）；since 带断线续传位置（§9）
    const sub: SubscribeMsg = { type: 'subscribe', sessions: null, since: this.since };
    attempt.sendLink(sub);
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

  // ── 内部：发送与状态 ──

  /** 经在途 attempt 发 Link 帧；无在途连接时与旧实现同文案（'未连接'）。 */
  private sendLinkOrThrow(frame: Object): void {
    const a: ConnAttempt | null = this.current;
    if (a === null) {
      throw new Error('未连接');
    }
    a.sendLink(frame);
  }

  private failPending(reason: string): void {
    this.pending.forEach((p: PendingInvoke) => p.reject(new Error(reason)));
    this.pending.clear();
  }

  private setState(s: ConnState): void {
    if (this._state === s) {
      return;
    }
    const prev: ConnState = this._state;
    this._state = s;
    console.info(`[link] state ${prev} → ${s}`);
    this.stateCbs.forEach((cb: StateCb) => cb(s));
  }
}

/**
 * ConnAttempt：一次自包含的连接尝试（协议 §2 分层里除 Link 帧路由外的全部）。
 *
 * 构造即建 socket、装 handler、起看门狗；此后这台 attempt 独占这次连接的
 * 中继层帧（connect/keepalive/connect_error）、Noise 握手（sc_init/sc_resp/
 * sc_err）、sc 分块加解密、keepalive tick 与握手看门狗。
 *
 * 核心不变量——「废弃的 attempt 结构性失声」：
 *  - 终局（瞬断/定性）与废弃（dispose）都先置 settled、再 detach()（拆 socket
 *    handler + 清定时器 + close），守卫只有各 handler 入口的 disposed||settled 一处；
 *  - 迟到的 socket 事件因 handler 已拆而结构性进不来——不需要任何散布的身份
 *    比对（旧 onmessage 无守卫时，迟到大帧可 killChannel 掐死新连接）；
 *  - 终局回调（onTransient/onDefinitive）至多触发一次。
 *
 * 结论二分（映射表与重构前逐条一致）：
 *  - 定性（凭据失效类）→ onDefinitive：unauthorized→revoked、no_pairing_offer/
 *    bad_handshake（仅 pair 模式）→expired/badhandshake、unsupported_version→
 *    unsupported、connect_error{superseded}→revoked、解密失败/超限/其余 sc_err→瞬断；
 *  - 瞬断 → onTransient（'连接断开' / 看门狗 '握手超时'）——重连策略归编排层。
 */
import type { PairFailCode, WsCloseEvent, WsErrorEvent, WsLike, WsMessageEvent, WsOpenEvent } from './types';
import {
  ConnectErrorMsg, KeepaliveMsg, LinkAssembler, PingMsg, RelayConnectMsg, SC_CHUNK_BYTES,
  ScDataMsg, ScErrMsg, ScInitMsg, ScRespMsg, WireProbe
} from './frames';
import { EMPTY, KeyPair, NoiseHandshake, NoiseTransport, noisePrologue } from '../crypto/noise';
import { x25519Public } from '../crypto/x25519';
import { randomBytes } from '../crypto/random';
import { b64Decode, b64Encode, utf8Encode } from '../crypto/bytes';

const WS_OPEN = 1;

/**
 * 一次连接尝试的参数（编排层组装；类而非对象字面量接口——ArkTS 约束）。
 * watchdogMs/keepaliveMs 可注入：真机默认 15s/20s，单测注 10ms 级。
 */
export class AttemptConfig {
  readonly url: string;
  /** true = 中继模式（open 先发中继层 connect；keepalive tick 恒发中继帧）。 */
  readonly relayMode: boolean;
  readonly deviceId: string;
  /** Noise 握手模式：pair（IKpsk2，psk 生效）/ resume（IK）。 */
  readonly mode: 'pair' | 'resume';
  /** pair 模式的一次性配对密钥；resume 为 null。 */
  readonly psk: Uint8Array | null;
  readonly myKey: KeyPair;
  readonly hostPublic: Uint8Array;
  readonly wsFactory: (url: string) => WsLike;
  /** 握手全程看门狗：覆盖 DoH 解析期 + 握手 + hello（默认 15s）。 */
  readonly watchdogMs: number;
  /** keepalive tick 间隔（默认 20s；中继 60s 静默超时的活体帧，§2.2）。 */
  readonly keepaliveMs: number;

  constructor(url: string, relayMode: boolean, deviceId: string, mode: 'pair' | 'resume',
    psk: Uint8Array | null, myKey: KeyPair, hostPublic: Uint8Array,
    wsFactory: (url: string) => WsLike, watchdogMs: number = 15000, keepaliveMs: number = 20000) {
    this.url = url;
    this.relayMode = relayMode;
    this.deviceId = deviceId;
    this.mode = mode;
    this.psk = psk;
    this.myKey = myKey;
    this.hostPublic = hostPublic;
    this.wsFactory = wsFactory;
    this.watchdogMs = watchdogMs;
    this.keepaliveMs = keepaliveMs;
  }
}

export class ConnAttempt {
  // ── 编排层接线（构造后立即装好；终局回调各自至多触发一次）──

  /** sc_resp 完成、安全通道已建立：可发 hello（此刻起 sendLink 可用）。 */
  onChannelReady: () => void = (): void => {};
  /** 重组解密出的 Link 帧原文（JSON 字符串；路由在编排层）。 */
  onLinkFrame: (raw: string) => void = (): void => {};
  /** 瞬断结论（'连接断开' / '握手超时'）：编排层退避重连。 */
  onTransient: (reason: string) => void = (): void => {};
  /** 定性结论（凭据失效类）：编排层清凭据回配对，不再重试。 */
  onDefinitive: (code: PairFailCode) => void = (): void => {};

  private readonly cfg: AttemptConfig;
  private readonly startedAtMs: number;
  private readonly ws: WsLike;
  private readonly assembler: LinkAssembler = new LinkAssembler();
  private handshake: NoiseHandshake | null = null;
  /** 传输态加解密（sc_resp 处理完成后非空）。 */
  private noiseT: NoiseTransport | null = null;
  private watchdogTimer: number | null = null;
  private keepaliveTimer: number | null = null;
  private lastPingN = 0;
  private authed = false;
  /** 已有终局结论或已被废弃：一切帧处理与回调静默（结构性失声的开关）。 */
  private settled = false;
  private disposed = false;

  constructor(cfg: AttemptConfig) {
    this.cfg = cfg;
    this.startedAtMs = Date.now();
    this.ws = cfg.wsFactory(cfg.url);
    this.wireSocket();
    // 握手看门狗：覆盖 TCP 黑洞 / 中继挂死 / 半开连接——ws.close() 的关闭握手
    // 可能永不到达，超时在此直接给瞬断结论（迟到的 onclose 被守卫拦下）。
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.disposed || this.settled || this.authed) {
        return;
      }
      this.killTransient('握手超时');
    }, cfg.watchdogMs);
  }

  private wireSocket(): void {
    const ws = this.ws;
    ws.onopen = (_ev: WsOpenEvent): void => {
      if (this.disposed || this.settled) {
        return;
      }
      // 中继模式先说中继层 connect（按 device_id 寻址 Host，§2.2）；
      // direct 直连跳过，连上直接说安全通道（§3.1）
      if (this.cfg.relayMode) {
        const m: RelayConnectMsg = { type: 'connect', device_id: this.cfg.deviceId };
        ws.send(JSON.stringify(m));
      }
      this.startKeepalive();
      this.sendScInit();
    };
    ws.onmessage = (ev: WsMessageEvent): void => {
      if (this.disposed || this.settled) {
        return;
      }
      try {
        this.handleWire(String(ev.data));
      } catch (e) {
        // 帧处理器的意外异常只记日志：协议状态由各分支自行维护
        console.warn(`[link] 帧处理异常：${e}`);
      }
    };
    ws.onclose = (_ev: WsCloseEvent): void => {
      if (this.disposed || this.settled) {
        return;
      }
      this.killTransient('连接断开');
    };
    ws.onerror = (_ev: WsErrorEvent): void => {
      // onclose 会跟随
    };
  }

  // ── 编排层入口 ──

  /** hello_ok 后调用：解除看门狗；keepalive tick 起加发 e2e ping（§6.4）。 */
  markAuthed(): void {
    this.authed = true;
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** 发一个 Link 帧：JSON → UTF-8 → 32768 分块 → 逐块加密成 sc 帧（§4.3）。
   *  文案冻结：通道未建立 / socket 已死分别抛 '安全通道未建立' / '未连接'。 */
  sendLink(frame: Object): void {
    const t: NoiseTransport | null = this.noiseT;
    if (t === null) {
      throw new Error('安全通道未建立');
    }
    if (this.ws.readyState !== WS_OPEN) {
      throw new Error('未连接');
    }
    const plain: Uint8Array = utf8Encode(JSON.stringify(frame));
    let off = 0;
    // 空明文也发一块（last:true，§4.3）
    while (true) {
      const end: number = Math.min(off + SC_CHUNK_BYTES, plain.length);
      const m: ScDataMsg = { type: 'sc', c: b64Encode(t.seal(plain.subarray(off, end))), last: end >= plain.length };
      this.ws.send(JSON.stringify(m));
      if (end >= plain.length) {
        break;
      }
      off = end;
    }
  }

  /** Link 层瞬断结论（bye{timeout} 等）→ 静默自毁并上报一次。 */
  killTransient(reason: string): void {
    if (this.disposed || this.settled) {
      return;
    }
    this.settled = true;
    this.detach();
    console.info(`[link] attempt 瞬断：${reason}（存活 ${Date.now() - this.startedAtMs}ms）`);
    this.onTransient(reason);
  }

  /** Link 层定性结论（bye{superseded/revoked}）→ 上报一次，编排层清凭据。 */
  killDefinitive(code: PairFailCode): void {
    if (this.disposed || this.settled) {
      return;
    }
    this.settled = true;
    this.detach();
    console.info(`[link] attempt 定性失败：${code}`);
    this.onDefinitive(code);
  }

  /** 编排层废弃（换新连接/用户断开）：拆 handler、清定时器、close——零回调。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.settled = true;
    this.detach();
  }

  isSettled(): boolean {
    return this.settled;
  }

  /** 构造时刻（编排层寿命判据：≥ STABLE_CONN_MS 则退避归零）。 */
  startedAt(): number {
    return this.startedAtMs;
  }

  // ── 内部：keepalive / 收尾 ──

  /** 单 tick 双活体：中继 keepalive（哑管道消费不转发）+ 端到端 ping（§6.4）。
   *  e2e ping 只在 authed 后发——hello 之前发 ping 违反阶段规则（§5）会被
   *  bye{protocol_error} 踢掉。 */
  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed || this.settled) {
        return;
      }
      if (this.ws.readyState !== WS_OPEN) {
        return;
      }
      try {
        if (this.cfg.relayMode) {
          const k: KeepaliveMsg = { type: 'keepalive' };
          this.ws.send(JSON.stringify(k));
        }
        if (this.authed && this.noiseT !== null) {
          this.lastPingN++;
          const p: PingMsg = { type: 'ping', n: this.lastPingN };
          this.sendLink(p);
        }
      } catch (e) {
        // 发送抛错 = 连接将死：终局交给 onclose / 看门狗
        console.warn(`[link] 心跳发送失败：${e}`);
      }
    }, this.cfg.keepaliveMs);
  }

  /** 终局/废弃统一收尾：清定时器、拆 socket handler（迟到大帧结构性进不来）、
   *  close。幂等：重复调用无副作用；close 的同步异常由适配层（ws-ohos）吞除。 */
  private detach(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
    this.ws.close();
  }

  // ── 内部：安全通道发起 ──

  /** 每次连接现做临时密钥（前向保密，§2.3）；NoiseHandshake 不内置随机源。 */
  private sendScInit(): void {
    const epriv: Uint8Array = randomBytes(32);
    const ephemeral: KeyPair = { privateKey: epriv, publicKey: x25519Public(epriv) };
    const hs: NoiseHandshake = new NoiseHandshake('initiator', this.cfg.myKey, this.cfg.hostPublic,
      noisePrologue(this.cfg.deviceId), { psk: this.cfg.psk, fixedEphemeral: ephemeral });
    const msg1: Uint8Array = hs.writeMessage(EMPTY); // 96 字节（§4.2）
    this.handshake = hs;
    const m: ScInitMsg = { type: 'sc_init', versions: [1], mode: this.cfg.mode, msg: b64Encode(msg1) };
    this.ws.send(JSON.stringify(m));
  }

  // ── 内部：外层帧（中继 + 安全通道；终局判定内置）──

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
          // 新设备配对顶替本机（§9.2）：定性，不重试
          this.killDefinitive('revoked');
        } else {
          // device_offline / unknown_code：瞬断
          this.killTransient('连接断开');
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
    const hs: NoiseHandshake | null = this.handshake;
    if (hs === null) {
      this.killTransient('连接断开'); // 未发 sc_init 就来 sc_resp：协议违规
      return;
    }
    try {
      hs.readMessage(b64Decode(m.msg)); // 失败 = psk 不对 / 连错 Host（§4.2）
    } catch (e) {
      this.killTransient('连接断开');
      return;
    }
    this.handshake = null;
    this.noiseT = hs.split();
    // 安全通道就绪：hello 由编排层在此发——「发出才烧配对码翻转」次序属会话策略
    this.onChannelReady();
  }

  /** sc_err → 二分结论（映射表与重构前逐条一致）。 */
  private handleScErr(m: ScErrMsg): void {
    const code: string = m.code;
    if (code === 'unauthorized') {
      // resume 的公钥不是已配对那把：被顶替 / 撤销（§9.2）——不重试
      this.killDefinitive('revoked');
    } else if (code === 'no_pairing_offer' && this.cfg.mode === 'pair') {
      // 二维码过期 / 已被用掉 / 没生成（§4.1）
      this.killDefinitive('expired');
    } else if (code === 'bad_handshake' && this.cfg.mode === 'pair') {
      this.killDefinitive('badhandshake');
    } else if (code === 'unsupported_version') {
      this.killDefinitive('unsupported');
    } else {
      // timeout / protocol_error / too_large / internal / resume 下的握手坏帧：瞬断重试
      this.killTransient('连接断开');
    }
  }

  private handleScChunk(m: ScDataMsg): void {
    const t: NoiseTransport | null = this.noiseT;
    if (t === null) {
      this.killTransient('连接断开'); // 握手未完成就来密文：协议违规
      return;
    }
    let chunk: Uint8Array;
    try {
      chunk = t.open(b64Decode(m.c));
    } catch (e) {
      // 解密失败 = 通道不可信（重放/乱序/篡改，§4.3）：立即断开
      this.killTransient('连接断开');
      return;
    }
    let frame: string | null;
    try {
      frame = this.assembler.push(chunk, m.last);
    } catch (e) {
      // 重组超 8 MiB 上限（§2.1）：对端行为异常
      this.killTransient('连接断开');
      return;
    }
    if (frame !== null) {
      this.onLinkFrame(frame);
    }
  }
}

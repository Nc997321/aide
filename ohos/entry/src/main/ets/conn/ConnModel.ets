/**
 * 连接应用层：RemoteTransport 的创建/复用 + 连接状态的全局可观察模型。
 *
 * 职责（协议 §3.2/§9）：
 *  - 传输实例只建一次（监听挂在实例上，重建会让 listener 挂死连接）；
 *    换凭据走同一实例的 connect() / pairWithOffer()——多主机切换亦然
 *  - 身份密钥交给 keychain（Asset 优先 + 明文降级）：首台配对时现生成一把，跨 Host 复用
 *  - pairWithOffer：确保身份 → 配对（psk 只活内存）→ 成功落盘
 *    {device_id, Host 公钥, relay, hostName}；已配过的主机覆盖旧凭据
 *  - 多主机（v1 单活）：hosts = 已配对全量（storage 数组），active = 上次连上的
 *    主机；switchTo 复用传输实例换凭据重连，authed 时 pendingDid !== activeDid
 *    判定「换了一台主机」，经 onHostChanged 回调链通知会话层整体复位
 *    （复位编排在 session/HostSync——本模块不能反向 import 会话模型）
 *  - autoConnect：有凭据 → 只读加载身份（绝不生成——否则等于换手机）→ resume 续连
 *    active 主机（active 失效则第一台）；身份缺失 = 凭据无法兑现，清掉回配对
 *  - needsPairing 归因：默认 revoked（续连被拒，只作废目标主机这一台凭据）/
 *    badhandshake（配对中断），pairWithOffer 的 catch 用 PairFailError.code 覆盖
 *  - 续传位置（epoch/lastSeq）：subscribed 后按目标主机持久化
 * 平台差异：状态从 Vue ref/reactive → @ObservedV2 + @Trace（V2 组件直接观察单例）。
 */
import { common } from '@kit.AbilityKit';
import { RemoteTransport, ConnState, PairDone, PairFailCode, PairFailError, SinceInfo } from '../sdk/remote';
import { setTransport } from '../sdk/transport';
import { makeOpenUrl } from '../sdk/ws-ohos';
import { StoredCreds, loadHosts, saveHosts, loadActiveDeviceId, saveActiveDeviceId,
  updateHostResume, updateHostSeen, updateHostName, removeHost, clearAllHosts } from '../sdk/storage';
import { IdentityKey, loadIdentityKey, ensureIdentityKey } from '../sdk/keychain';
import type { PairOffer } from '../sdk/pair-uri';
import { b64urlEncode } from '../sdk/crypto/bytes';

/** needsPairing 的归因（协议 §10 类型化错误码；undefined = 非错误态）。 */
export type PairError = 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | undefined;

/** 「换了一台主机」事件载荷（authed 时 pendingDid !== activeDid 触发一次）。 */
export interface HostChangedInfo {
  deviceId: string;
  hostName: string | null;
  /** true = 用户主动切换（switchTo）；false = 冷启动/断开后重连上另一台。 */
  viaSwitch: boolean;
}

export type HostChangedCb = (info: HostChangedInfo) => void;

@ObservedV2
export class ConnModel {
  @Trace state: ConnState = 'idle';
  @Trace pairError: PairError = undefined;
  /** 已配对主机全量（storage 数组的内存镜像；忘记/吊销后收缩）。 */
  @Trace hosts: StoredCreds[] = [];
  /** 上次连上的主机 deviceId（'' = 从未连上；持久化为 storage 的 active 键）。 */
  @Trace activeDeviceId: string = '';
  /** 当前 connect/配对的目标主机（连接中卡片 spinner 定位用）。 */
  @Trace pendingDeviceId: string = '';
  /** Host 显示名（hello_ok / 二维码 n），当前连接目标或已连主机。 */
  @Trace hostName: string | null = null;
  /** 主机切换进行中（switchTo → authed/失败前为 true；Index 据此保持 ChatPage 挂载）。 */
  @Trace switching: boolean = false;
  /** 切换目标显示名（ChatPage 横幅文案）。 */
  @Trace switchingTo: string = '';
  /** 配对进行中（UI 进度提示；瞬断重试期间保持 true 直到结论）。 */
  @Trace pairing: boolean = false;
  /** Host 侧执行错误（error 帧无对应挂起时上报）；UI 可选展示。 */
  @Trace lastError: string = '';

  private client: RemoteTransport | null = null;
  private context: common.UIAbilityContext | undefined = undefined;
  /** 已 authed 的主机（'' = 无；与 pendingDeviceId 比对判定主机变更）。 */
  private activeDid: string = '';
  private hostChangedCbs: HostChangedCb[] = [];

  /** EntryAbility.onCreate 里先于 autoConnect 调用。 */
  init(context: common.UIAbilityContext): void {
    this.context = context;
    this.reloadHosts();
    this.activeDeviceId = loadActiveDeviceId();
    const active: StoredCreds | null = this.findHost(this.activeDeviceId);
    this.hostName = active !== null ? active.hostName : null;
  }

  // ── 连接 ──

  /** 启动自动续连：active 主机（失效则第一台）→ 只读加载身份 → resume（免扫码）。
   *  异步（Asset 查询），EntryAbility 不等待——状态经 onStateChange 回调链推进。 */
  autoConnect(): void {
    const hosts: StoredCreds[] = loadHosts();
    this.hosts = hosts;
    if (hosts.length === 0) {
      return;
    }
    let target: StoredCreds | null = this.findHost(loadActiveDeviceId());
    if (target === null) {
      target = hosts[0];
    }
    const creds: StoredCreds = target;
    this.hostName = creds.hostName;
    loadIdentityKey().then((k: IdentityKey | null) => {
      if (k === null) {
        this.handleIdentityMissing();
        return;
      }
      this.connectInternal(creds, k);
    }).catch((e: Error) => {
      console.warn(`[conn] autoConnect 失败：${e.message ?? ''}`);
    });
  }

  /** 切换主机（v1 单活）：复用传输实例换凭据重连；authed 后经 onHostChanged
   *  通知会话层复位。凭据保留（离线的主机随时可切回）。 */
  switchTo(deviceId: string): void {
    const found: StoredCreds | null = this.findHost(deviceId);
    if (found === null) {
      return;
    }
    if (this.state === 'authed' && this.activeDid === deviceId) {
      return; // 已在这台上
    }
    if (this.state === 'connecting' && this.pendingDeviceId === deviceId) {
      return; // 正在连这台
    }
    const creds: StoredCreds = found;
    this.switching = true;
    this.switchingTo = creds.hostName !== null ? creds.hostName : hostShortId(deviceId);
    this.pairError = undefined;
    loadIdentityKey().then((k: IdentityKey | null) => {
      if (k === null) {
        this.handleIdentityMissing();
        return;
      }
      this.connectInternal(creds, k);
    }).catch((e: Error) => {
      console.warn(`[conn] switchTo 失败：${e.message ?? ''}`);
      this.switching = false;
      this.switchingTo = '';
    });
  }

  /** 扫码配对：确保身份 → 配对（psk 只活内存）→ 成功存凭据（authed 由 handleState 切页）。
   *  已配过的主机覆盖旧凭据（epoch/lastSeq 归零重续）。 */
  async pairWithOffer(offer: PairOffer): Promise<void> {
    this.pairing = true;
    this.pairError = undefined;
    this.pendingDeviceId = offer.deviceId;
    try {
      const myKey: IdentityKey = await ensureIdentityKey();
      const t: RemoteTransport = this.ensureClient();
      const done: PairDone = await t.pairWithOffer(offer, myKey);
      const stored: StoredCreds = {
        deviceId: offer.deviceId,
        hostPublic: b64urlEncode(offer.hostPublic),
        relayUrl: offer.relay,
        directUrl: offer.direct,
        hostName: done.hostName,
        epoch: null,
        lastSeq: 0,
        lastSeen: Date.now() // 配对即连上
      };
      const hosts: StoredCreds[] = loadHosts().filter((c: StoredCreds) => c.deviceId !== offer.deviceId);
      hosts.push(stored);
      saveHosts(hosts);
      this.reloadHosts();
    } catch (e) {
      // 定性失败：传输层已置 needsPairing（handleState 只作废目标主机凭据 + 默认归因），
      // 这里用类型化 code 覆盖（expired/badhandshake/revoked/unsupported）
      if (e instanceof PairFailError) {
        const code: PairFailCode = e.code;
        // aborted = 用户主动断开（disconnectActive 已清错误态）：不算配对失败
        this.pairError = code === 'aborted' ? undefined : code;
      } else {
        console.warn(`[conn] 配对意外失败：${e}`);
        this.pairError = 'badhandshake';
      }
    } finally {
      this.pairing = false;
    }
  }

  /** 断开当前连接（保留凭据）：停自动重连；传输实例保留——下次切换/重连复用。
   *  主动断开后任何重连（含同主机）都会触发会话层全量复位（activeDid 已清）。 */
  disconnectActive(): void {
    if (this.client !== null) {
      this.client.disconnect(); // 停重连；state → idle 由 handleState 回写
    }
    this.activeDid = '';
    this.pendingDeviceId = '';
    this.switching = false;
    this.switchingTo = '';
    this.pairError = undefined;
    this.lastError = '';
  }

  /** 忘记一台主机：删凭据；若它正是当前/在连主机则一并断开。 */
  forgetHost(deviceId: string): void {
    removeHost(deviceId);
    this.reloadHosts();
    if (this.pendingDeviceId === deviceId || this.activeDid === deviceId) {
      if (this.client !== null) {
        this.client.disconnect();
      }
      this.activeDid = '';
      this.pendingDeviceId = '';
      this.switching = false;
      this.switchingTo = '';
    }
    if (this.activeDeviceId === deviceId) {
      this.activeDeviceId = '';
    }
    if (this.hosts.length === 0) {
      this.hostName = null;
    }
  }

  /** 会话层注册「换主机」回调（HostSync 在 EntryAbility.onCreate 注册一次）。 */
  registerHostChanged(cb: HostChangedCb): void {
    this.hostChangedCbs.push(cb);
  }

  /** 供页面/会话层取传输实例（invoke/listen 走 sdk/transport 门面即可，一般无需直取）。 */
  get transport(): RemoteTransport | null {
    return this.client;
  }

  // ── 内部 ──

  private findHost(deviceId: string): StoredCreds | null {
    if (deviceId === '') {
      return null;
    }
    for (let i = 0; i < this.hosts.length; i++) {
      if (this.hosts[i].deviceId === deviceId) {
        return this.hosts[i];
      }
    }
    return null;
  }

  private reloadHosts(): void {
    this.hosts = loadHosts();
  }

  /** 身份私钥丢失（Asset 与明文降级都无）：全部凭据无法兑现——清光回配对。 */
  private handleIdentityMissing(): void {
    console.warn('[conn] 身份密钥缺失，凭据作废');
    clearAllHosts();
    this.hosts = [];
    this.activeDeviceId = '';
    this.pendingDeviceId = '';
    this.activeDid = '';
    this.hostName = null;
    this.switching = false;
    this.switchingTo = '';
    this.state = 'needsPairing';
    this.pairError = 'revoked';
  }

  private connectInternal(creds: StoredCreds, k: IdentityKey): void {
    this.pendingDeviceId = creds.deviceId;
    const t: RemoteTransport = this.ensureClient();
    t.connect(creds, k);
  }

  private ensureClient(): RemoteTransport {
    if (this.client === null) {
      const openUrl = this.context !== undefined ? makeOpenUrl(this.context) : undefined;
      const t = new RemoteTransport(undefined, openUrl);
      setTransport(t); // 此后所有 api.* 调用走 Link 远程 RPC
      t.onStateChange((s: ConnState) => {
        this.handleState(s);
      });
      t.onError((m: string) => {
        this.lastError = m;
      });
      t.onSubscribed(() => {
        this.persistResume();
      });
      this.client = t;
    }
    return this.client;
  }

  private handleState(s: ConnState): void {
    this.state = s;
    if (s === 'authed') {
      const t = this.client;
      const did = this.pendingDeviceId;
      const viaSwitch = this.switching;
      const helloName = t !== null ? t.hostName : null;
      if (did !== '') {
        updateHostSeen(did);
        if (helloName !== null) {
          updateHostName(did, helloName); // hello_ok 的 Host 名落地
        }
        this.reloadHosts();
      }
      const stored: StoredCreds | null = this.findHost(did);
      this.hostName = helloName !== null ? helloName : (stored !== null ? stored.hostName : null);
      if (did !== '' && did !== this.activeDid) {
        // 换了一台主机（或断开后重连）：active 落盘 + 通知会话层全量复位
        this.activeDid = did;
        this.activeDeviceId = did;
        saveActiveDeviceId(did);
        const info: HostChangedInfo = { deviceId: did, hostName: this.hostName, viaSwitch: viaSwitch };
        for (let i = 0; i < this.hostChangedCbs.length; i++) {
          this.hostChangedCbs[i](info);
        }
      }
      this.switching = false;
      this.switchingTo = '';
    }
    if (s === 'needsPairing') {
      // 定性失败：只作废目标主机这一台凭据（其余主机随时可切）
      const did = this.pendingDeviceId;
      if (did !== '') {
        removeHost(did);
        this.reloadHosts();
      }
      this.activeDid = ''; // 连接已死：后续任何 authed 都按换主机全量复位
      this.switching = false;
      this.switchingTo = '';
      if (this.hosts.length === 0) {
        this.hostName = null;
        this.activeDeviceId = '';
      }
      if (this.pairError === undefined) {
        // 默认归因：续连被拒 = revoked；配对中断 = badhandshake
        // （随后被 pairWithOffer catch 的类型化 code 覆盖）
        this.pairError = this.pairing ? 'badhandshake' : 'revoked';
      }
    }
  }

  /** 续传位置持久化（协议 §9：epoch/lastSeq，按目标主机）。 */
  private persistResume(): void {
    const t = this.client;
    if (t === null || this.pendingDeviceId === '') {
      return;
    }
    const since: SinceInfo | null = t.getResumeInfo();
    if (since === null) {
      return;
    }
    updateHostResume(this.pendingDeviceId, since.epoch, since.seq);
  }
}

/** did 短显（32 hex 前 8 位）。 */
export function hostShortId(deviceId: string): string {
  return deviceId.length > 8 ? deviceId.substring(0, 8) : deviceId;
}

const HOST_PALETTE: string[] = ['#0A59F7', '#00B42A', '#FF7D00', '#7B61FF', '#14C9C9', '#F77EBC'];

/** 主机头像色（deviceId 哈希取色，稳定不变）。 */
export function hostColor(deviceId: string): string {
  let h: number = 0;
  for (let i = 0; i < deviceId.length; i++) {
    h += deviceId.charCodeAt(i);
  }
  return HOST_PALETTE[h % HOST_PALETTE.length];
}

/** 主机头像底色（同色 10% 透明）。 */
export function hostTint(deviceId: string): string {
  return '#1A' + hostColor(deviceId).substring(1);
}

/** 全局单例：EntryAbility 与各页面共同观察同一实例。 */
export const connModel: ConnModel = new ConnModel();

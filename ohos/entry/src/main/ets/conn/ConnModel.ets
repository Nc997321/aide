/**
 * 连接应用层：RemoteTransport 的创建/复用 + 连接状态的全局可观察模型。
 *
 * 职责（协议 §3.2/§9）：
 *  - 传输实例只建一次（监听挂在实例上，重建会让 listener 挂死连接）；
 *    换凭据走同一实例的 connect() / pairWithOffer()
 *  - 身份密钥交给 keychain（Asset 优先 + 明文降级）：首台配对时现生成一把，跨 Host 复用
 *  - pairWithOffer：确保身份 → 配对（psk 只活内存）→ 成功落盘
 *    {device_id, Host 公钥, relay, hostName}
 *  - autoConnect：有凭据 → 只读加载身份（绝不生成——否则等于换手机）→ resume 续连；
 *    身份缺失 = 凭据无法兑现，清掉回配对
 *  - needsPairing 归因：默认 revoked（续连被拒）/ badhandshake（配对中断），
 *    pairWithOffer 的 catch 用 PairFailError.code 覆盖
 *  - 续传位置（epoch/lastSeq）：subscribed 后与离开 authed 时持久化
 * 平台差异：状态从 Vue ref/reactive → @ObservedV2 + @Trace（V2 组件直接观察单例）。
 */
import { common } from '@kit.AbilityKit';
import { RemoteTransport, ConnState, PairDone, PairFailCode, PairFailError, SinceInfo } from '../sdk/remote';
import { setTransport } from '../sdk/transport';
import { makeOpenUrl } from '../sdk/ws-ohos';
import { StoredCreds, loadCreds, saveCreds, clearCreds } from '../sdk/storage';
import { IdentityKey, loadIdentityKey, ensureIdentityKey } from '../sdk/keychain';
import type { PairOffer } from '../sdk/pair-uri';
import { b64urlEncode } from '../sdk/crypto/bytes';

/** needsPairing 的归因（协议 §10 类型化错误码；undefined = 非错误态）。 */
export type PairError = 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | undefined;

@ObservedV2
export class ConnModel {
  @Trace state: ConnState = 'idle';
  @Trace pairError: PairError = undefined;
  @Trace hasCreds: boolean = false;
  /** Host 显示名（二维码 n / hello_ok），已配对脚注展示。 */
  @Trace hostName: string | null = null;
  /** 配对进行中（UI 进度提示；瞬断重试期间保持 true 直到结论）。 */
  @Trace pairing: boolean = false;
  /** Host 侧执行错误（error 帧无对应挂起时上报）；UI 可选展示。 */
  @Trace lastError: string = '';

  private client: RemoteTransport | null = null;
  private context: common.UIAbilityContext | undefined = undefined;

  /** EntryAbility.onCreate 里先于 autoConnect 调用。 */
  init(context: common.UIAbilityContext): void {
    this.context = context;
    const stored: StoredCreds | null = loadCreds();
    if (stored !== null) {
      this.hasCreds = true;
      this.hostName = stored.hostName;
    }
  }

  // ── 连接 ──

  /** 启动自动续连：有凭据 → 只读加载身份 → resume（免扫码）。异步（Asset 查询），
   *  EntryAbility 不等待——状态经 onStateChange 回调链推进。 */
  autoConnect(): void {
    const stored: StoredCreds | null = loadCreds();
    if (stored === null) {
      return;
    }
    this.hasCreds = true;
    this.hostName = stored.hostName;
    loadIdentityKey().then((k: IdentityKey | null) => {
      if (k === null) {
        // 身份私钥丢失（Asset 与明文降级都无）：凭据无法兑现——清掉回配对
        console.warn('[conn] 身份密钥缺失，凭据作废');
        clearCreds();
        this.hasCreds = false;
        this.hostName = null;
        this.state = 'needsPairing';
        this.pairError = 'revoked';
        return;
      }
      const t: RemoteTransport = this.ensureClient();
      t.connect(stored, k);
    }).catch((e: Error) => {
      console.warn(`[conn] autoConnect 失败：${e.message ?? ''}`);
    });
  }

  /** 扫码配对：确保身份 → 配对（psk 只活内存）→ 成功存凭据（authed 由 handleState 切页）。 */
  async pairWithOffer(offer: PairOffer): Promise<void> {
    this.pairing = true;
    this.pairError = undefined;
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
        lastSeq: 0
      };
      saveCreds(stored);
      this.hasCreds = true;
    } catch (e) {
      // 定性失败：传输层已置 needsPairing（handleState 清凭据 + 默认归因），
      // 这里用类型化 code 覆盖（expired/badhandshake/revoked/unsupported）
      if (e instanceof PairFailError) {
        const code: PairFailCode = e.code;
        // aborted = 用户主动断开（disconnectAll 已清错误态）：不算配对失败
        this.pairError = code === 'aborted' ? undefined : code;
      } else {
        console.warn(`[conn] 配对意外失败：${e}`);
        this.pairError = 'badhandshake';
      }
    } finally {
      this.pairing = false;
    }
  }

  /** 断开：停自动重连 + 清凭据 + 回配对屏。传输实例保留——下次配对复用。 */
  disconnectAll(): void {
    if (this.client !== null) {
      this.client.disconnect(); // 停重连；state → idle 由 handleState 回写
    }
    clearCreds();
    this.hasCreds = false;
    this.pairError = undefined;
    this.lastError = '';
    this.hostName = null;
  }

  /** 供页面/会话层取传输实例（invoke/listen 走 sdk/transport 门面即可，一般无需直取）。 */
  get transport(): RemoteTransport | null {
    return this.client;
  }

  // ── 内部 ──

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
      // hello_ok 的 Host 名落地（配对期间先用二维码里的 n 兜底）
      const t = this.client;
      if (t !== null && t.hostName !== null) {
        this.hostName = t.hostName;
      }
    }
    if (s === 'needsPairing') {
      // 定性失败：凭据作废（重新扫码即配新 Host）
      clearCreds();
      this.hasCreds = false;
      this.hostName = null;
      if (this.pairError === undefined) {
        // 默认归因：续连被拒 = revoked；配对中断 = badhandshake
        // （随后被 pairWithOffer catch 的类型化 code 覆盖）
        this.pairError = this.pairing ? 'badhandshake' : 'revoked';
      }
    }
  }

  /** 续传位置持久化（协议 §9：epoch/lastSeq）。 */
  private persistResume(): void {
    const t = this.client;
    if (t === null) {
      return;
    }
    const since: SinceInfo | null = t.getResumeInfo();
    const stored: StoredCreds | null = loadCreds();
    if (since === null || stored === null) {
      return;
    }
    if (stored.epoch === since.epoch && stored.lastSeq === since.seq) {
      return;
    }
    stored.epoch = since.epoch;
    stored.lastSeq = since.seq;
    saveCreds(stored);
  }
}

/** 全局单例：EntryAbility 与各页面共同观察同一实例。 */
export const connModel: ConnModel = new ConnModel();

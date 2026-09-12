/**
 * 连接应用层：RemoteTransport 的创建/复用 + 连接状态的全局可观察模型。
 *
 * 过筛自 remote-pwa/src/App.vue 的连接编排段（ArkTS 化）。语义与上游零偏差：
 *  - 传输实例只建一次（监听挂在实例上，重建会让 listener 挂死连接）；
 *    换 URL/凭据走同一实例的 connect() 重连
 *  - needsPairing 的错误分型：配对流程中（pairing）→ badcode；token 流程 → revoked
 *  - pair 成功 → saveCreds；启动时有凭据 → 自动续连
 * 平台差异：状态从 Vue ref/reactive → @ObservedV2 + @Trace（V2 组件直接观察单例）。
 * 会话数据编排（onAuthed 拉供应商/工作区/会话）属路线第 4 步，接入 api 门面时对照补齐。
 */
import { common } from '@kit.AbilityKit';
import { RemoteTransport, ConnState, ConnectCreds, ConnectByCode, ConnectByToken, PairOk } from '../sdk/remote';
import { setTransport } from '../sdk/transport';
import { makeOpenUrl } from '../sdk/ws-ohos';
import { StoredCreds, loadCreds, saveCreds, clearCreds, saveRelayUrl, loadRelayUrl, DEFAULT_RELAY_URL } from '../sdk/storage';

/** needsPairing 的归因：badcode = 本次配对码被拒；revoked = 已存 token 被吊销。 */
export type PairError = 'badcode' | 'revoked' | undefined;

@ObservedV2
export class ConnModel {
  @Trace state: ConnState = 'idle';
  @Trace pairError: PairError = undefined;
  @Trace hasCreds: boolean = false;
  /** 上次输入的中继地址（未配对时也保留，连接页预填；未存过用缺省值）。 */
  @Trace savedRelayUrl: string = DEFAULT_RELAY_URL;
  /** 桌面侧执行错误（invoke_err 无对应挂起请求时上报）；UI 可选展示。 */
  @Trace lastError: string = '';

  private client: RemoteTransport | null = null;
  /** 配对流程进行中（needsPairing 时区分 badcode/revoked 的标志）。 */
  private pairing: boolean = false;
  private context: common.UIAbilityContext | undefined = undefined;

  /** EntryAbility.onCreate 里先于 autoConnect 调用。 */
  init(context: common.UIAbilityContext): void {
    this.context = context;
    this.savedRelayUrl = loadRelayUrl();
    const stored: StoredCreds | null = loadCreds();
    if (stored !== null) {
      this.hasCreds = true;
    }
  }

  // ── 连接 ──

  /** 启动自动续连：有凭据直接 token 连接（免配对）。 */
  autoConnect(): void {
    const stored: StoredCreds | null = loadCreds();
    if (stored === null) {
      return;
    }
    this.hasCreds = true;
    const t: RemoteTransport = this.ensureClient(stored.relayUrl);
    const creds: ConnectByToken = { deviceId: stored.deviceId, token: stored.token };
    t.connect(creds, stored.relayUrl);
  }

  /** 配对：连接中继 → 发 pair → 成功存凭据（authed 由 handleState 接管切页）。 */
  async pairWithCode(relayUrl: string, code: string): Promise<void> {
    this.pairing = true;
    this.pairError = undefined;
    saveRelayUrl(relayUrl);
    this.savedRelayUrl = relayUrl;
    const t: RemoteTransport = this.ensureClient(relayUrl);
    const creds: ConnectByCode = { code: code };
    t.connect(creds, relayUrl);
    try {
      const ok: PairOk = await t.pair(code);
      const stored: StoredCreds = { relayUrl: relayUrl, deviceId: ok.device_id, token: ok.token };
      saveCreds(stored);
      this.hasCreds = true;
    } catch (e) {
      // auth_error → handleState 已置 needsPairing + badcode；连接断开 → offline 自动重试
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
  }

  /** 供页面/后续会话层取传输实例（invoke/listen 走 sdk/transport 门面即可，一般无需直取）。 */
  get transport(): RemoteTransport | null {
    return this.client;
  }

  // ── 内部 ──

  private ensureClient(relayUrl: string): RemoteTransport {
    if (this.client === null) {
      const openUrl = this.context !== undefined ? makeOpenUrl(this.context) : undefined;
      const t = new RemoteTransport(relayUrl, undefined, openUrl);
      setTransport(t); // 此后所有 api.* 调用走远程 RPC
      t.onStateChange((s: ConnState) => {
        this.handleState(s);
      });
      t.onError((m: string) => {
        this.lastError = m;
      });
      this.client = t;
    }
    return this.client;
  }

  private handleState(s: ConnState): void {
    this.state = s;
    if (s === 'needsPairing') {
      // 配对失败（badcode）与 token 被吊销（revoked）都回连接屏
      clearCreds();
      this.hasCreds = false;
      this.pairError = this.pairing ? 'badcode' : 'revoked';
    }
  }
}

/** 全局单例：EntryAbility 与各页面共同观察同一实例。 */
export const connModel: ConnModel = new ConnModel();

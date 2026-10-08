/**
 * Aide Link v1 凭据持久化（协议 §9：{device_id, Host 公钥, relay, epoch, lastSeq}）。
 *
 *  - 手机身份私钥不在这里——见 keychain.ets（Asset 安全存储 + 明文降级）
 *  - 配对 psk 永不落盘（只在配对握手的内存里活一次）
 *  - 读侧字段级校验，坏数据（含 v2 遗留的 token 形状）视作无凭据并清键回配对
 * 单 Host 形状（v1 手机 UI 单连接；多 Host 留待 UI 需要时扩展）。
 * 平台差异：localStorage → @ohos.data.preferences（EntryAbility.onCreate 先 initStorage）。
 * TTS 开关等应用偏好沿用同一 preferences 实例。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { b64urlDecode } from './crypto/bytes';

export interface StoredCreds {
  /** Host 的 device_id（32 位十六进制小写——中继路由键）。 */
  deviceId: string;
  /** Host X25519 静态公钥（b64url 无填充，32 字节）——手机据此认 Host。 */
  hostPublic: string;
  /** 中继基址（无尾部斜杠；传输层拼 /ws）。与 directUrl 恰有一个非空。 */
  relayUrl: string | null;
  /** 直连 WebSocket 地址（测试 Host / 局域网）。 */
  directUrl: string | null;
  /** Host 显示名（hello_ok 里来的；UI 展示用）。 */
  hostName: string | null;
  /** 上次订阅所处的 Host 代（epoch）；null = 从未收到过 subscribed。 */
  epoch: string | null;
  /** 收到的最大 event.seq（断线续传位置）。 */
  lastSeq: number;
}

const STORE_NAME = 'aide_remote';
const CREDS_KEY = 'aide-remote-creds';
const TTS_KEY = 'aide-tts';

let store: preferences.Preferences | null = null;

/** EntryAbility.onCreate 里最先调用（后续所有读写依赖此实例）。 */
export function initStorage(context: common.UIAbilityContext): void {
  if (store === null) {
    try {
      store = preferences.getPreferencesSync(context, { name: STORE_NAME });
    } catch (e) {
      store = null;
      console.warn('[storage] preferences 初始化失败：凭据将不持久化');
    }
  }
}

const HEX32 = new RegExp('^[0-9a-f]{32}$');

function isCredsValid(c: StoredCreds): boolean {
  if (typeof c.deviceId !== 'string' || !HEX32.test(c.deviceId)) {
    return false;
  }
  if (typeof c.hostPublic !== 'string') {
    return false;
  }
  try {
    if (b64urlDecode(c.hostPublic).length !== 32) {
      return false;
    }
  } catch (e) {
    return false;
  }
  const relayOk: boolean = typeof c.relayUrl === 'string' && c.relayUrl !== '';
  const directOk: boolean = typeof c.directUrl === 'string' && c.directUrl !== '';
  if (relayOk === directOk) {
    return false; // relay 与 direct 恰有一个
  }
  if (c.epoch !== null && typeof c.epoch !== 'string') {
    return false;
  }
  if (typeof c.lastSeq !== 'number' || c.lastSeq < 0 || Math.floor(c.lastSeq) !== c.lastSeq) {
    return false;
  }
  return true;
}

export function loadCreds(): StoredCreds | null {
  if (store === null) {
    return null;
  }
  let raw: string = '';
  try {
    raw = store.getSync(CREDS_KEY, '') as string;
  } catch (e) {
    return null;
  }
  if (raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StoredCreds;
    if (isCredsValid(parsed)) {
      return parsed;
    }
    clearCreds(); // 坏形状（含 v2 token 遗留）：清键回配对
    return null;
  } catch (e) {
    clearCreds();
    return null;
  }
}

export function saveCreds(creds: StoredCreds): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(CREDS_KEY, JSON.stringify(creds));
    store.flush().catch((e: Error) => {
      console.warn(`[storage] creds flush 失败：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn('[storage] saveCreds 失败：凭据未落盘');
  }
}

export function clearCreds(): void {
  if (store === null) {
    return;
  }
  try {
    store.deleteSync(CREDS_KEY);
    store.flush().catch((e: Error) => {
      console.warn(`[storage] creds flush 失败：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn('[storage] clearCreds 失败');
  }
}

/** 通用键值读写（keychain 明文降级路径用；勿存大对象）。 */
export function putPrefRaw(key: string, value: string): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(key, value);
    store.flush().catch((e: Error) => {
      console.warn(`[storage] flush 失败（${key}）：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn(`[storage] putPrefRaw 失败（${key}）`);
  }
}

export function getPrefRaw(key: string, def: string): string {
  if (store === null) {
    return def;
  }
  try {
    return store.getSync(key, def) as string;
  } catch (e) {
    return def;
  }
}

export function deletePrefRaw(key: string): void {
  if (store === null) {
    return;
  }
  try {
    store.deleteSync(key);
    store.flush().catch((e: Error) => {
      console.warn(`[storage] flush 失败（${key}）：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn(`[storage] deletePrefRaw 失败（${key}）`);
  }
}

/** 语音播报开关（'1' 开 / '0' 关；缺省/坏数据按开——对照原型 localStorage 默认）。 */
export function loadTtsEnabled(): boolean {
  if (store === null) {
    return true;
  }
  try {
    return store.getSync(TTS_KEY, '1') as string === '1';
  } catch (e) {
    return true;
  }
}

export function saveTtsEnabled(v: boolean): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(TTS_KEY, v ? '1' : '0');
    store.flush().catch((e: Error) => {
      console.warn(`[storage] tts flush 失败：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn('[storage] saveTtsEnabled 失败');
  }
}

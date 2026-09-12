/**
 * 凭据持久化：中继 URL + device_id + token（配对成功后落盘，重连免配对）。
 *
 * 过筛自 remote-pwa/src/storage.ts（ArkTS 化）。语义与上游零偏差：
 *  - 三键同源：creds 整体 JSON / relayUrl 单独记住（未配对时也保留上次输入）
 *  - 读侧字段级校验，坏数据一律视作无凭据（回配对屏）
 * ohos 侧附加键：语音播报开关 aide-tts（对照 design/voice-broadcast/app.html
 * 的 localStorage 同名键，'1'/'0' 字符串，默认开）。
 * 平台差异：localStorage → @ohos.data.preferences（EntryAbility.onCreate 先 initStorage）。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

export interface StoredCreds {
  relayUrl: string;
  deviceId: string;
  token: string;
}

const STORE_NAME = 'aide_remote';
const CREDS_KEY = 'aide-remote-creds';
const RELAY_URL_KEY = 'aide-remote-relay-url';
const TTS_KEY = 'aide-tts';

/** 中继地址缺省值：未保存过时的预填基址（RemoteTransport.wsUrl 自动拼 /ws 路径）。 */
export const DEFAULT_RELAY_URL: string = 'ws://home.aideai.store:8000';

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
    if (
      typeof parsed.relayUrl === 'string' &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.token === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch (e) {
    return null; // 坏数据视作无凭据
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

/** 中继 URL 单独记住（未配对时也保留上次输入）。 */
export function saveRelayUrl(url: string): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(RELAY_URL_KEY, url);
    store.flush().catch((e: Error) => {
      console.warn(`[storage] relayUrl flush 失败：${e.message ?? ''}`);
    });
  } catch (e) {
    console.warn('[storage] saveRelayUrl 失败');
  }
}

/** 中继 URL 读取（未保存/为空回退缺省值，连接页预填用）。 */
export function loadRelayUrl(): string {
  if (store === null) {
    return DEFAULT_RELAY_URL;
  }
  try {
    const saved: string = store.getSync(RELAY_URL_KEY, '') as string;
    return saved !== '' ? saved : DEFAULT_RELAY_URL;
  } catch (e) {
    return DEFAULT_RELAY_URL;
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

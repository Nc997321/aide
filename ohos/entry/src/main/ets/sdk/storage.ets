/**
 * 凭据持久化：中继 URL + device_id + token（配对成功后落盘，重连免配对）。
 *
 * 过筛自 remote-pwa/src/storage.ts（ArkTS 化）。语义与上游零偏差：
 *  - 三键同源：creds 整体 JSON / relayUrl 单独记住（未配对时也保留上次输入）
 *  - 读侧字段级校验，坏数据一律视作无凭据（回配对屏）
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

export function loadRelayUrl(): string {
  if (store === null) {
    return '';
  }
  try {
    return store.getSync(RELAY_URL_KEY, '') as string;
  } catch (e) {
    return '';
  }
}

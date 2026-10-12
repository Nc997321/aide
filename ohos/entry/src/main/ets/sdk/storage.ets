/**
 * Aide Link v1 凭据持久化（协议 §9：{device_id, Host 公钥, relay, epoch, lastSeq}）。
 *
 *  - 手机身份私钥不在这里——见 keychain.ets（Asset 安全存储 + 明文降级）
 *  - 配对 psk 永不落盘（只在配对握手的内存里活一次）
 *  - 读侧字段级校验，坏数据（含 v2 遗留的 token 形状）视作无凭据并清键回配对
 *  - 多 Host 形状：hosts 键存 StoredCreds[]（每台主机一条），active 键存当前
 *    主机的 deviceId；v1 旧单键 aide-remote-creds 首读时自动迁移进数组。
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
  /** 上次连接成功的时间（Date.now() 毫秒；0 = 从未连上过）。 */
  lastSeen: number;
}

const STORE_NAME = 'aide_remote';
const HOSTS_KEY = 'aide-remote-hosts';
const ACTIVE_KEY = 'aide-remote-active';
const LEGACY_CREDS_KEY = 'aide-remote-creds';
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

function flushSoon(): void {
  if (store === null) {
    return;
  }
  store.flush().catch((e: Error) => {
    console.warn(`[storage] flush 失败：${e.message ?? ''}`);
  });
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
  if (c.hostName !== null && typeof c.hostName !== 'string') {
    return false;
  }
  if (c.epoch !== null && typeof c.epoch !== 'string') {
    return false;
  }
  if (typeof c.lastSeq !== 'number' || c.lastSeq < 0 || Math.floor(c.lastSeq) !== c.lastSeq) {
    return false;
  }
  return true; // lastSeen 缺失/非法不判无效——归一为 0
}

/** 校验 + 拷贝（补齐 lastSeen），坏形状返回 null。入参可能来自 JSON.parse，先判空。 */
function normalizeCreds(h: StoredCreds): StoredCreds | null {
  if (h === null || h === undefined) {
    return null;
  }
  if (!isCredsValid(h)) {
    return null;
  }
  const seenOk: boolean = typeof h.lastSeen === 'number' && h.lastSeen >= 0 &&
    Math.floor(h.lastSeen) === h.lastSeen;
  const c: StoredCreds = {
    deviceId: h.deviceId,
    hostPublic: h.hostPublic,
    relayUrl: h.relayUrl,
    directUrl: h.directUrl,
    hostName: h.hostName,
    epoch: h.epoch,
    lastSeq: h.lastSeq,
    lastSeen: seenOk ? h.lastSeen : 0,
  };
  return c;
}

function deleteHostsKey(): void {
  if (store === null) {
    return;
  }
  try {
    store.deleteSync(HOSTS_KEY);
    flushSoon();
  } catch (e) {
    // 键不存在/删除失败都无所谓——下次读到再清
  }
}

/** 旧单键迁移：hosts 键为空且旧键形状有效 → 迁入数组并置 active。 */
function tryMigrateLegacy(): StoredCreds[] {
  if (store === null) {
    return [];
  }
  let raw: string = '';
  try {
    raw = store.getSync(LEGACY_CREDS_KEY, '') as string;
  } catch (e) {
    return [];
  }
  if (raw === '') {
    return [];
  }
  let legacy: StoredCreds | null = null;
  try {
    const parsed = JSON.parse(raw) as StoredCreds;
    legacy = normalizeCreds(parsed);
  } catch (e) {
    legacy = null;
  }
  try {
    store.deleteSync(LEGACY_CREDS_KEY); // 无论好坏都清旧键（坏形状回配对）
    flushSoon();
  } catch (e) {
  }
  if (legacy === null) {
    return [];
  }
  saveHosts([legacy]);
  saveActiveDeviceId(legacy.deviceId);
  return [legacy];
}

/** 读全部已配对主机（字段级校验；坏元素跳过，整体坏清键）。 */
export function loadHosts(): StoredCreds[] {
  if (store === null) {
    return [];
  }
  let raw: string = '';
  try {
    raw = store.getSync(HOSTS_KEY, '') as string;
  } catch (e) {
    return [];
  }
  if (raw === '') {
    return tryMigrateLegacy();
  }
  let parsed: StoredCreds[] = [];
  try {
    const obj = JSON.parse(raw) as StoredCreds[];
    if (!(obj instanceof Array)) {
      deleteHostsKey();
      return [];
    }
    parsed = obj;
  } catch (e) {
    deleteHostsKey();
    return [];
  }
  const out: StoredCreds[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const c = normalizeCreds(parsed[i]);
    if (c !== null) {
      out.push(c);
    }
  }
  return out;
}

export function saveHosts(hosts: StoredCreds[]): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(HOSTS_KEY, JSON.stringify(hosts));
    flushSoon();
  } catch (e) {
    console.warn('[storage] saveHosts 失败：凭据未落盘');
  }
}

/** 当前主机 deviceId（'' = 无）。 */
export function loadActiveDeviceId(): string {
  if (store === null) {
    return '';
  }
  try {
    return store.getSync(ACTIVE_KEY, '') as string;
  } catch (e) {
    return '';
  }
}

export function saveActiveDeviceId(deviceId: string): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(ACTIVE_KEY, deviceId);
    flushSoon();
  } catch (e) {
    console.warn('[storage] saveActiveDeviceId 失败');
  }
}

/** 当前主机的凭据（active 指向的主机；无 active 或找不到 → null）。 */
export function loadActiveCreds(): StoredCreds | null {
  const active = loadActiveDeviceId();
  if (active === '') {
    return null;
  }
  const hosts = loadHosts();
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].deviceId === active) {
      return hosts[i];
    }
  }
  return null;
}

/** 订阅成功后回写续传位置（主机不在数组里则忽略）。 */
export function updateHostResume(deviceId: string, epoch: string | null, lastSeq: number): void {
  const hosts = loadHosts();
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].deviceId === deviceId) {
      hosts[i].epoch = epoch;
      hosts[i].lastSeq = lastSeq;
      saveHosts(hosts);
      return;
    }
  }
}

/** 连接成功后盖“最后在线”时间戳。 */
export function updateHostSeen(deviceId: string): void {
  const hosts = loadHosts();
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].deviceId === deviceId) {
      hosts[i].lastSeen = Date.now();
      saveHosts(hosts);
      return;
    }
  }
}

/** hello_ok 里拿到更好的名字时回写。 */
export function updateHostName(deviceId: string, name: string): void {
  const hosts = loadHosts();
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].deviceId === deviceId && hosts[i].hostName !== name) {
      hosts[i].hostName = name;
      saveHosts(hosts);
      return;
    }
  }
}

/** 忘记一台主机（同时清掉指向它的 active）。 */
export function removeHost(deviceId: string): void {
  const hosts = loadHosts();
  const out: StoredCreds[] = [];
  for (let i = 0; i < hosts.length; i++) {
    if (hosts[i].deviceId !== deviceId) {
      out.push(hosts[i]);
    }
  }
  saveHosts(out);
  if (loadActiveDeviceId() === deviceId) {
    saveActiveDeviceId('');
  }
}

/** 清空全部主机数据（身份密钥丢失时回配对用）。 */
export function clearAllHosts(): void {
  if (store === null) {
    return;
  }
  try {
    store.deleteSync(HOSTS_KEY);
    store.deleteSync(ACTIVE_KEY);
    store.deleteSync(LEGACY_CREDS_KEY);
    flushSoon();
  } catch (e) {
    console.warn('[storage] clearAllHosts 失败');
  }
}

/** 通用键值读写（keychain 明文降级路径用；勿存大对象）。 */
export function putPrefRaw(key: string, value: string): void {
  if (store === null) {
    return;
  }
  try {
    store.putSync(key, value);
    flushSoon();
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
    flushSoon();
  } catch (e) {
    console.warn('[storage] deletePrefRaw 失败');
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
    flushSoon();
  } catch (e) {
    console.warn('[storage] saveTtsEnabled 失败');
  }
}

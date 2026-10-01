/**
 * 手机身份密钥管理（协议 §9）。
 *
 * 一台手机一把 X25519 静态密钥（生成后跨 Host 复用；断开/解绑不删——
 * Host 侧靠 device_id + 公钥认手机，删了就等于换了一台手机）。
 * 私钥首选 Asset Store Kit（系统级加密存储，DEVICE_FIRST_UNLOCKED 可用）；
 * Asset 不可用时降级 preferences 明文（b64）并响亮告警——不比 v2 明文 token 差。
 * 公钥不落盘：x25519Public(私钥) 现场派生。
 */
import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { utf8Encode, b64Encode, b64Decode } from './crypto/bytes';
import { x25519Public, isValidPrivateKey } from './crypto/x25519';
import { randomBytes } from './crypto/random';
import { putPrefRaw, getPrefRaw } from './storage';

const ALIAS = 'aide-link-identity';
const FALLBACK_KEY = 'aide-link-identity-fallback';

export interface IdentityKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function aliasBytes(): Uint8Array {
  return utf8Encode(ALIAS);
}

async function assetLoad(): Promise<Uint8Array | null> {
  // AssetMap 是类型别名（Map<Tag, Value>）——无构造器，直接 new Map
  const query: asset.AssetMap = new Map<asset.Tag, asset.Value>();
  query.set(asset.Tag.ALIAS, aliasBytes());
  query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
  try {
    const res: Array<asset.AssetMap> = await asset.query(query);
    if (res.length === 0) {
      return null;
    }
    const secret: asset.Value | undefined = res[0].get(asset.Tag.SECRET);
    if (secret === undefined) {
      return null;
    }
    return secret as Uint8Array;
  } catch (e) {
    const err = e as BusinessError;
    if (err.code !== 24000002) { // 24000002 = 目标不存在（首次运行是正常路径）
      console.warn(`[keychain] Asset 查询失败（code=${err.code}），尝试明文降级读取`);
    }
    return null;
  }
}

async function assetSave(priv: Uint8Array): Promise<boolean> {
  const attr: asset.AssetMap = new Map<asset.Tag, asset.Value>();
  attr.set(asset.Tag.ALIAS, aliasBytes());
  attr.set(asset.Tag.SECRET, priv);
  attr.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
  attr.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
  try {
    await asset.add(attr);
    return true;
  } catch (e) {
    const err = e as BusinessError;
    console.warn(`[keychain] Asset 写入失败（code=${err.code}），降级 preferences 明文存储`);
    return false;
  }
}

function fallbackSave(priv: Uint8Array): void {
  putPrefRaw(FALLBACK_KEY, b64Encode(priv));
  console.warn('[keychain] 身份私钥以明文降级存入 preferences（Asset Store 不可用）');
}

function fallbackLoad(): Uint8Array | null {
  const raw: string = getPrefRaw(FALLBACK_KEY, '');
  if (raw === '') {
    return null;
  }
  try {
    const priv: Uint8Array = b64Decode(raw);
    if (priv.length !== 32 || !isValidPrivateKey(priv)) {
      return null;
    }
    return priv;
  } catch (e) {
    return null;
  }
}

function makeIdentity(priv: Uint8Array): IdentityKey {
  return { privateKey: priv, publicKey: x25519Public(priv) };
}

/** 只读：存在则加载，不存在返回 null（绝不生成新钥——自动续连专用）。 */
export async function loadIdentityKey(): Promise<IdentityKey | null> {
  const fromAsset: Uint8Array | null = await assetLoad();
  if (fromAsset !== null) {
    if (!isValidPrivateKey(fromAsset)) {
      console.error('[keychain] Asset 中的身份私钥校验失败——按无身份处理（需重新配对）');
      return null;
    }
    return makeIdentity(fromAsset);
  }
  const fromPrefs: Uint8Array | null = fallbackLoad();
  if (fromPrefs !== null) {
    return makeIdentity(fromPrefs);
  }
  return null;
}

/** 加载或生成（仅配对路径调用：这台手机还没有身份就现做一把并立即持久化）。 */
export async function ensureIdentityKey(): Promise<IdentityKey> {
  const existing: IdentityKey | null = await loadIdentityKey();
  if (existing !== null) {
    return existing;
  }
  const priv: Uint8Array = randomBytes(32);
  const saved: boolean = await assetSave(priv);
  if (!saved) {
    fallbackSave(priv);
  }
  return makeIdentity(priv);
}

/**
 * 配对 URI 解析（协议 §3.1）：
 *
 *   aide-link://pair?v=1&relay=<URL 编码的中继地址>&id=<32 位十六进制>
 *                  &pk=<Host 公钥 b64url 无填充>&psk=<一次性密钥 b64url 无填充>
 *                  &n=<Host 名，可缺省>&exp=<过期 unix 秒，可缺省>
 *
 * 规则（以 docs/aide-link-protocol.md 为准）：
 *   - `relay` 与 `direct` 恰有一个；relay 形态手机连 `<relay>/ws` 且先发中继层 connect，
 *     direct 形态连上直接说安全通道
 *   - 忽略未知键；值按 URL 规则解码
 *   - v ≠ 1 → bad_version（提示用户升级 App，而不是报"无效二维码"）
 *   - psk 是秘密：只进内存握手，不落盘不落日志（存储层只存握手成功后的长期凭据）
 */

import { b64urlDecode } from './crypto/bytes';

/** 解析成功的配对 offer（只在内存里活到握手完成为止）。 */
export interface PairOffer {
  /** 中继基址（已去掉尾部斜杠）；手机实际连 `<relay>/ws`。与 direct 恰有一个非空。 */
  relay: string | null;
  /** 直连 WebSocket 地址（局域网 / Tailscale / 测试 Host），原样使用。 */
  direct: string | null;
  /** Host 的 device_id（32 位十六进制，小写）。 */
  deviceId: string;
  /** Host 的 X25519 静态公钥（32 字节）——手机据此认 Host。 */
  hostPublic: Uint8Array;
  /** 一次性密钥（32 字节）——只在这个 URI 里，永不经过网络。 */
  psk: Uint8Array;
  /** Host 显示名（UI 用），可缺省。 */
  name: string | null;
  /** 过期时刻（unix 秒，给 UI 倒计时用；Host 侧自己强制过期）。可缺省。 */
  expiresAt: number | null;
}

export type PairUriErrorCode = 'bad_format' | 'bad_version' | 'bad_fields';

export class PairUriError extends Error {
  readonly code: PairUriErrorCode;

  constructor(code: PairUriErrorCode, message: string) {
    super(message);
    this.name = 'PairUriError';
    this.code = code;
  }
}

const PREFIX = 'aide-link://pair';
const HEX32 = new RegExp('^[0-9a-fA-F]{32}$');

function decodeComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    throw new PairUriError('bad_format', '配对码包含非法的转义序列');
  }
}

/**
 * 解析扫码 / 粘贴得到的字符串。不是配对 URI 或字段不合法时抛 PairUriError。
 */
export function parsePairUri(input: string): PairOffer {
  const s = input.trim();
  if (s.length < PREFIX.length || s.substring(0, PREFIX.length).toLowerCase() !== PREFIX) {
    throw new PairUriError('bad_format', '这不是配对二维码');
  }
  let query = s.length > PREFIX.length ? s.substring(PREFIX.length) : '';
  // 查询串必须以 '?' 开头（哪怕其后为空，也按缺字段处理）；其他形态一律格式错误
  if (!query.startsWith('?')) {
    throw new PairUriError('bad_format', '配对码格式不正确');
  }
  query = query.substring(1);
  const hashAt = query.indexOf('#');
  if (hashAt >= 0) {
    query = query.substring(0, hashAt);
  }

  const fields = new Map<string, string>();
  const segs = query.split('&');
  for (const seg of segs) {
    if (seg.length === 0) {
      continue;
    }
    const eq = seg.indexOf('=');
    const rawKey = eq >= 0 ? seg.substring(0, eq) : seg;
    const rawVal = eq >= 0 ? seg.substring(eq + 1) : '';
    const key = decodeComponent(rawKey);
    if (key.length === 0) {
      continue;
    }
    // 后出现的键覆盖先出现的（与 URL 语义一致）；未知键直接忽略
    fields.set(key, decodeComponent(rawVal));
  }

  const v = fields.get('v');
  if (v !== '1') {
    throw new PairUriError('bad_version', v === undefined ? '配对码缺少版本号' : `不支持的配对码版本 v=${v}，请升级 App`);
  }

  const relayRaw = fields.get('relay');
  const directRaw = fields.get('direct');
  if (relayRaw !== undefined && directRaw !== undefined) {
    throw new PairUriError('bad_fields', '配对码同时包含 relay 与 direct');
  }
  if (relayRaw === undefined && directRaw === undefined) {
    throw new PairUriError('bad_fields', '配对码缺少连接地址');
  }
  let relay: string | null = null;
  let direct: string | null = null;
  if (relayRaw !== undefined) {
    if (relayRaw.length === 0) {
      throw new PairUriError('bad_fields', '配对码的中继地址为空');
    }
    // 归一化：去尾部斜杠，传输层负责拼 '/ws'
    relay = relayRaw.replace(new RegExp('/+$'), '');
  } else if (directRaw !== undefined) {
    if (directRaw.length === 0) {
      throw new PairUriError('bad_fields', '配对码的直连地址为空');
    }
    if (directRaw.indexOf('ws://') !== 0 && directRaw.indexOf('wss://') !== 0) {
      throw new PairUriError('bad_fields', '配对码的直连地址不是 ws(s) 地址');
    }
    direct = directRaw;
  }

  const id = fields.get('id');
  if (id === undefined || !HEX32.test(id)) {
    throw new PairUriError('bad_fields', '配对码的 Host 编号无效');
  }
  const deviceId = id.toLowerCase();

  const pkStr = fields.get('pk');
  if (pkStr === undefined) {
    throw new PairUriError('bad_fields', '配对码缺少 Host 公钥');
  }
  let hostPublic: Uint8Array;
  try {
    hostPublic = b64urlDecode(pkStr);
  } catch (e) {
    throw new PairUriError('bad_fields', '配对码的 Host 公钥无效');
  }
  if (hostPublic.length !== 32) {
    throw new PairUriError('bad_fields', '配对码的 Host 公钥长度不对');
  }

  const pskStr = fields.get('psk');
  if (pskStr === undefined) {
    throw new PairUriError('bad_fields', '配对码缺少一次性密钥');
  }
  let psk: Uint8Array;
  try {
    psk = b64urlDecode(pskStr);
  } catch (e) {
    throw new PairUriError('bad_fields', '配对码的一次性密钥无效');
  }
  if (psk.length !== 32) {
    throw new PairUriError('bad_fields', '配对码的一次性密钥长度不对');
  }

  const n = fields.get('n');
  const name = n !== undefined && n.length > 0 ? n : null;

  let expiresAt: number | null = null;
  const expStr = fields.get('exp');
  if (expStr !== undefined && new RegExp('^[0-9]+$').test(expStr)) {
    expiresAt = Number(expStr);
  }

  return { relay, direct, deviceId, hostPublic, psk, name, expiresAt };
}

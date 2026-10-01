/**
 * 字节与文本编码工具（纯 TS，无平台依赖——Node 可直接跑向量验证，鸿蒙侧同一份代码）。
 *
 * 覆盖 Aide Link 需要的全部编码：UTF-8、hex、标准 base64（sc 帧密文，带填充）、
 * URL 安全 base64 无填充（配对 URI 里的 pk/psk）。手写实现而非平台 API：
 *  - ArkTS 运行时没有 atob/btoa；@ohos.util 的 TextEncoder/Base64 会让本层耦合平台；
 *  - 协议要的是逐字节确定的行为，自包含实现最可审计。
 */

/** UTF-8 编码（含代理对 → 4 字节序列；孤立代理落 U+FFFD，与 WHATWG 行为一致）。 */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 解码（畸形序列落 U+FFFD，尽力而为——协议帧都是合法 JSON，不会走到）。 */
export function utf8Decode(b: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) {
      out += String.fromCharCode(c);
      i++;
    } else if (c >= 0xc0 && c < 0xe0 && i + 1 < b.length) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (b[i + 1] & 0x3f));
      i += 2;
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < b.length) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f));
      i += 3;
    } else if (c >= 0xf0 && c < 0xf8 && i + 3 < b.length) {
      const cp = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
      out += String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += 4;
    } else {
      out += '\ufffd';
      i++;
    }
  }
  return out;
}

/** 拼接字节段（免去调用方手工分配）。 */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) {
    n += p.length;
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const HEX = '0123456789abcdef';

export function hexEncode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += HEX[b[i] >> 4] + HEX[b[i] & 0x0f];
  }
  return out;
}

export function hexDecode(s: string): Uint8Array {
  if (s.length % 2 !== 0) {
    throw new Error('hex: odd length');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexVal(s.charCodeAt(i * 2));
    const lo = hexVal(s.charCodeAt(i * 2 + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) {
    return c - 48;
  }
  if (c >= 97 && c <= 102) {
    return c - 87;
  }
  if (c >= 65 && c <= 70) {
    return c - 55;
  }
  throw new Error('hex: bad char');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 标准 base64（带 '=' 填充）——sc 帧的 `c` / `msg` 字段用这个。 */
export function b64Encode(b: Uint8Array): string {
  return b64EncodeWith(b, B64, true);
}

/** 标准 base64 解码；非 base64 字符（含多余填充）抛错——密文不可信即断开。 */
export function b64Decode(s: string): Uint8Array {
  return b64DecodeWith(s, B64);
}

/** URL 安全 base64，无填充——配对 URI 里的 pk/psk 用这个（43 字符 = 32 字节）。 */
export function b64urlEncode(b: Uint8Array): string {
  return b64EncodeWith(b, B64URL, false);
}

export function b64urlDecode(s: string): Uint8Array {
  return b64DecodeWith(s, B64URL);
}

function b64EncodeWith(b: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n0 = b[i];
    const n1 = i + 1 < b.length ? b[i + 1] : 0;
    const n2 = i + 2 < b.length ? b[i + 2] : 0;
    const trip = (n0 << 16) | (n1 << 8) | n2;
    out += alphabet[(trip >> 18) & 63] + alphabet[(trip >> 12) & 63];
    out += i + 1 < b.length ? alphabet[(trip >> 6) & 63] : pad ? '=' : '';
    out += i + 2 < b.length ? alphabet[trip & 63] : pad ? '=' : '';
  }
  return out;
}

function b64DecodeWith(s: string, alphabet: string): Uint8Array {
  // 计算有效字符数（忽略尾部填充），其余字符必须都是字母表内的
  let end = s.length;
  while (end > 0 && s.charAt(end - 1) === '=') {
    end--;
  }
  const rev = new Map<number, number>();
  for (let i = 0; i < alphabet.length; i++) {
    rev.set(alphabet.charCodeAt(i), i);
  }
  const outLen = Math.floor((end * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let oi = 0;
  for (let i = 0; i < end; i++) {
    const v = rev.get(s.charCodeAt(i));
    if (v === undefined) {
      throw new Error('base64: bad char');
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi] = (acc >> bits) & 0xff;
      oi++;
    }
  }
  if (oi !== outLen) {
    throw new Error('base64: bad length');
  }
  return out;
}

/** 相等时间比较（标签比对用；长度不同直接 false）。 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * ChaCha20-Poly1305 AEAD（RFC 8439）：Noise 传输态与握手中的加解密原语。
 *
 * - nonce 12 字节；Noise 的用法是 4 零字节 ‖ 64 位小端计数器（由 noise.ts 构造）。
 * - 认证失败抛错（调用方据此断开连接——重放/乱序/篡改一律不可信）。
 * - Poly1305 用 BigInt：同 x25519.ts 的取舍——本地运算，清晰优先。
 */

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
}

function keyToWords(key: Uint8Array): Uint32Array {
  const w = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    w[i] = (key[i * 4] | (key[i * 4 + 1] << 8) | (key[i * 4 + 2] << 16) | (key[i * 4 + 3] << 24)) >>> 0;
  }
  return w;
}

function nonceToWords(nonce: Uint8Array): Uint32Array {
  const w = new Uint32Array(3);
  for (let i = 0; i < 3; i++) {
    w[i] = (nonce[i * 4] | (nonce[i * 4 + 1] << 8) | (nonce[i * 4 + 2] << 16) | (nonce[i * 4 + 3] << 24)) >>> 0;
  }
  return w;
}

/** ChaCha20 块函数（RFC 8439 §2.3）：64 字节密钥流。 */
function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array): Uint8Array {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  s.set(key, 4);
  s[12] = counter >>> 0;
  s.set(nonce, 13);
  const w = s.slice();
  for (let i = 0; i < 10; i++) {
    quarter(w, 0, 4, 8, 12);
    quarter(w, 1, 5, 9, 13);
    quarter(w, 2, 6, 10, 14);
    quarter(w, 3, 7, 11, 15);
    quarter(w, 0, 5, 10, 15);
    quarter(w, 1, 6, 11, 12);
    quarter(w, 2, 7, 8, 13);
    quarter(w, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (w[i] + s[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;

function loadLEBig(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    r = (r << 8n) | BigInt(b[i]);
  }
  return r;
}

/** RFC 8439 §2.8：aad 与 ct 各自零填充到 16 字节边界（是 MAC 数据构造的一部分）。 */
function pad16(data: Uint8Array): Uint8Array {
  const pad = (16 - (data.length % 16)) % 16;
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  return out;
}

/** Poly1305（RFC 8439 §2.5）：mac = MAC(key, aad || ct)。 */
function poly1305(key: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const r = loadLEBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = loadLEBig(key.subarray(16, 32));
  let acc = 0n;
  const blocks = (data: Uint8Array): void => {
    for (let i = 0; i < data.length; i += 16) {
      const len = Math.min(16, data.length - i);
      const block = new Uint8Array(len + 1);
      block.set(data.subarray(i, i + len), 0);
      block[len] = 1; // 高位补 0x01
      acc = ((acc + loadLEBig(block)) * r) % P1305;
    }
  };
  // 先补零到边界，再按块处理：短块 +0x01 的位置在补零之后（2^128），不是紧跟数据尾
  blocks(pad16(aad));
  blocks(pad16(ct));
  const le = (n: number): Uint8Array => {
    const b = new Uint8Array(8);
    let x = n;
    for (let i = 0; i < 8; i++) {
      b[i] = x & 0xff;
      x = Math.floor(x / 256);
    }
    return b;
  };
  const lenBlock = new Uint8Array(16);
  lenBlock.set(le(aad.length), 0);
  lenBlock.set(le(ct.length), 8);
  blocks(lenBlock); // 长度块同样过 acc*r（整 16 字节，高位补 0x01 与 RFC 一致）
  const tag = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  let x = tag;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * AEAD 加密：输出 ct ‖ tag(16)。aad 参与认证不参与加密（Noise 用握手哈希当 aad）。
 */
export function chacha20Poly1305Seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const kw = keyToWords(key);
  const nw = nonceToWords(nonce);
  const block0 = chachaBlock(kw, 0, nw);
  const polyKey = block0.subarray(0, 32);
  const ct = new Uint8Array(plaintext.length);
  let counter = 1;
  for (let off = 0; off < plaintext.length; off += 64) {
    const ks = chachaBlock(kw, counter, nw);
    const take = Math.min(64, plaintext.length - off);
    for (let i = 0; i < take; i++) {
      ct[off + i] = plaintext[off + i] ^ ks[i];
    }
    counter++;
  }
  const tag = poly1305(polyKey, aad, ct);
  const out = new Uint8Array(ct.length + 16);
  out.set(ct, 0);
  out.set(tag, ct.length);
  return out;
}

/** AEAD 解密：认证失败抛 Error（调用方据此断开）。 */
export function chacha20Poly1305Open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 16) {
    throw new Error('aead: ciphertext too short');
  }
  const ctLen = data.length - 16;
  const kw = keyToWords(key);
  const nw = nonceToWords(nonce);
  const block0 = chachaBlock(kw, 0, nw);
  const polyKey = block0.subarray(0, 32);
  const ct = data.subarray(0, ctLen);
  const expect = data.subarray(ctLen);
  const tag = poly1305(polyKey, aad, ct);
  let diff = 0;
  for (let i = 0; i < 16; i++) {
    diff |= tag[i] ^ expect[i];
  }
  if (diff !== 0) {
    throw new Error('aead: authentication failed');
  }
  const pt = new Uint8Array(ctLen);
  let counter = 1;
  for (let off = 0; off < ctLen; off += 64) {
    const ks = chachaBlock(kw, counter, nw);
    const take = Math.min(64, ctLen - off);
    for (let i = 0; i < take; i++) {
      pt[off + i] = ct[off + i] ^ ks[i];
    }
    counter++;
  }
  return pt;
}

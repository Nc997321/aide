/**
 * SHA-256 / HMAC-SHA256 / HKDF-SHA256（纯 TS）。Noise IK/IKpsk2 的哈希层。
 * 实现遵循 FIPS 180-4 / RFC 2104 / RFC 5869；可增量更新（握手状态机逐段喂入）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** 增量 SHA-256：update 喂入任意段，digest 出 32 字节摘要（一次性 sha256 建议直接用下方的便捷函数）。 */
export class Sha256 {
  private h: Uint32Array;
  private buf: Uint8Array;
  private bufLen: number;
  private totalLen: number;

  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.totalLen = 0;
  }

  update(data: Uint8Array): this {
    this.absorb(data);
    this.totalLen += data.length;
    return this;
  }

  digest(): Uint8Array {
    // 填充：0x80 + 0…0 补到 56 (mod 64)，再接 8 字节大端位长，凑满整块
    const bitLenHi = Math.floor(this.totalLen / 0x20000000) >>> 0;
    const bitLenLo = (this.totalLen << 3) >>> 0;
    const padLen = (this.bufLen < 56 ? 56 : 120) - this.bufLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    tail[padLen] = bitLenHi >>> 24;
    tail[padLen + 1] = (bitLenHi >>> 16) & 0xff;
    tail[padLen + 2] = (bitLenHi >>> 8) & 0xff;
    tail[padLen + 3] = bitLenHi & 0xff;
    tail[padLen + 4] = bitLenLo >>> 24;
    tail[padLen + 5] = (bitLenLo >>> 16) & 0xff;
    tail[padLen + 6] = (bitLenLo >>> 8) & 0xff;
    tail[padLen + 7] = bitLenLo & 0xff;
    this.absorb(tail);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.h[i] & 0xff;
    }
    return out;
  }

  /** 喂入字节（不计数）——digest 的填充走这里，避免污染 totalLen。 */
  private absorb(data: Uint8Array): void {
    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 64) {
        this.compress(this.buf);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.compress(data.subarray(off, off + 64));
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
  }

  private compress(block: Uint8Array): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let hh = this.h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + hh) >>> 0;
  }
}

/** 一次性 SHA-256（多段拼接，免去调用方 concat）。 */
export function sha256(parts: Uint8Array[]): Uint8Array {
  const h = new Sha256();
  for (const p of parts) {
    h.update(p);
  }
  return h.digest();
}

/** HMAC-SHA256（RFC 2104）。key 长于 64 字节先哈希；parts 多段拼接。 */
export function hmacSha256(key: Uint8Array, parts: Uint8Array[]): Uint8Array {
  let k = key;
  if (k.length > 64) {
    k = sha256([k]);
  }
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const kb = i < k.length ? k[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const inner = sha256([ipad, ...parts]);
  return sha256([opad, inner]);
}

const EMPTY = new Uint8Array(0);

/**
 * HKDF-SHA256（RFC 5869）：extract = HMAC(salt, ikm) → expand。
 * Noise 的 MixKey / Split 用它（info 恒空，输出 2×32 字节）。
 */
export function hkdfSha256(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const prk = hmacSha256(salt, [ikm]);
  const out = new Uint8Array(length);
  let prev: Uint8Array = EMPTY;
  let generated = 0;
  let counter = 1;
  while (generated < length) {
    const block = hmacSha256(prk, [prev, info, Uint8Array.of(counter)]);
    const take = Math.min(32, length - generated);
    out.set(block.subarray(0, take), generated);
    prev = block;
    generated += take;
    counter++;
  }
  return out;
}

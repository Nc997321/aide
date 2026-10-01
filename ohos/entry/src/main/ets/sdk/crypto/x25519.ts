/**
 * X25519（RFC 7748）：Curve25519 Montgomery 阶梯标量乘。
 *
 * BigInt 实现：清晰优先于常数时间——运算发生在手机本地（私钥不出设备，
 * 没有跨设备的时序信道），安全模型可接受。逐字节正确性由 noise_vectors.json
 * 与 RFC 7748 官方向量双重钉死。
 */

const P = (1n << 255n) - 19n;
const A24 = 121665n;

function loadLE(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    r = (r << 8n) | BigInt(b[i]);
  }
  return r;
}

function storeLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = n;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modP(n: bigint): bigint {
  let r = n % P;
  if (r < 0n) {
    r += P;
  }
  return r;
}

function powMod(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      r = (r * b) % P;
    }
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

/** 模逆：z^(p-2) mod p（p 是素数）。 */
function invert(z: bigint): bigint {
  return powMod(z, P - 2n);
}

/**
 * X25519(k, u)：32 字节私钥 × 32 字节公钥 → 32 字节共享密钥。
 * 输出为全零时抛错（Noise 规约：DH 输出全零 = 拒绝，防不合规对端）。
 */
export function x25519(scalar: Uint8Array, peer: Uint8Array): Uint8Array {
  if (scalar.length !== 32 || peer.length !== 32) {
    throw new Error('x25519: inputs must be 32 bytes');
  }
  // clamp：k[0] &= 248, k[31] &= 127, k[31] |= 64
  const k = (loadLE(scalar) & 0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n) | (1n << 254n);
  // u 最高位掩掉（RFC 7748：接收侧必须掩）
  const u = loadLE(peer) & ((1n << 255n) - 1n);

  let x1 = u;
  let x2 = 1n;
  let z2 = 0n;
  let x3 = u;
  let z3 = 1n;
  let swap = 0n;
  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap === 1n) {
      const tx = x2; x2 = x3; x3 = tx;
      const tz = z2; z2 = z3; z3 = tz;
    }
    swap = kt;
    // Montgomery 阶梯（RFC 7748 §5 pseudocode）
    const a = modP(x2 + z2);
    const aa = (a * a) % P;
    const b = modP(x2 - z2);
    const bb = (b * b) % P;
    const e = modP(aa - bb);
    const c = modP(x3 + z3);
    const d = modP(x3 - z3);
    const da = (d * a) % P;
    const cb = (c * b) % P;
    x3 = (da + cb) % P;
    x3 = (x3 * x3) % P;
    z3 = modP(da - cb);
    z3 = (z3 * z3) % P;
    z3 = (z3 * x1) % P;
    x2 = (aa * bb) % P;
    z2 = ((aa + A24 * e) * e) % P;
  }
  if (swap === 1n) {
    const tx = x2; x2 = x3; x3 = tx;
    const tz = z2; z2 = z3; z3 = tz;
  }
  const res = (x2 * invert(z2)) % P;
  if (res === 0n) {
    throw new Error('x25519: all-zero output (bad peer key?)');
  }
  return storeLE(res, 32);
}

/** 基点 9 的标量乘：私钥 → 公钥。 */
export function x25519Public(privateKey: Uint8Array): Uint8Array {
  return x25519(privateKey, basePoint());
}

function basePoint(): Uint8Array {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
}

/** 私钥合法性校验（32 字节非全零；clamp 内部做，这里只查形状）。 */
export function isValidPrivateKey(b: Uint8Array): boolean {
  if (b.length !== 32) {
    return false;
  }
  let any = 0;
  for (let i = 0; i < 32; i++) {
    any |= b[i];
  }
  return any !== 0;
}

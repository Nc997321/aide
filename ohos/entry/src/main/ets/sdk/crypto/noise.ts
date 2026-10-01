/**
 * Noise IK / IKpsk2（Noise_…_25519_ChaChaPoly_SHA256）——Aide Link 安全通道的握手状态机。
 *
 * 真相源：src-tauri/crates/aide-link/src/secure.rs（snow 库）+ tests/fixtures/noise_vectors.json。
 * 本文件是它的纯 TS 移植（手机一侧为主，responder 侧供向量验证 / 本地联调）：
 *  - pair   = Noise_IKpsk2_25519_ChaChaPoly_SHA256（psk = 二维码里的一次性密钥，psk 位置 2）
 *  - resume = Noise_IK_25519_ChaChaPoly_SHA256
 *  - prologue = "aide-link/1:" + device_id
 *  - 两条握手消息 payload 均为空；msg1 = e‖ENC(s)‖ENC(∅) = 96 字节，msg2 = e‖ENC(∅) = 48 字节
 *  - 传输态：每方向独立计数器，nonce = 4 零字节 ‖ 64 位小端 n，无 AD
 */

import { hmacSha256, hkdfSha256, sha256 } from './sha256';
import { x25519 } from './x25519';
import { chacha20Poly1305Open, chacha20Poly1305Seal } from './aead';
import { utf8Encode } from './bytes';

export const NOISE_PAIR = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256';
export const NOISE_RESUME = 'Noise_IK_25519_ChaChaPoly_SHA256';

export const EMPTY = new Uint8Array(0);

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export type NoiseRole = 'initiator' | 'responder';

/** AEAD 认证失败（psk 不对 / 连错 Host / 密文被篡改——一律视为通道不可信）。 */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseError';
  }
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519(privateKey, publicKey);
  } catch (e) {
    throw new NoiseError(`DH failed: ${(e as Error).message}`);
  }
}

function nonceOf(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let x = n;
  for (let i = 4; i < 12; i++) {
    nonce[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  return nonce;
}

/** 单方向加密态：k（32 字节或 null=明文透传）+ 严格递增计数器。 */
class CipherState {
  private key: Uint8Array | null;
  private n: number;

  constructor(key: Uint8Array | null) {
    this.key = key;
    this.n = 0;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) {
      return plaintext.slice();
    }
    if (this.n >= Number.MAX_SAFE_INTEGER) {
      throw new NoiseError('nonce exhausted');
    }
    const out = chacha20Poly1305Seal(this.key, nonceOf(this.n), ad, plaintext);
    this.n++;
    return out;
  }

  decrypt(ad: Uint8Array, data: Uint8Array): Uint8Array {
    if (this.key === null) {
      return data.slice();
    }
    try {
      return chacha20Poly1305Open(this.key, nonceOf(this.n), ad, data);
    } catch (e) {
      throw new NoiseError(`decrypt failed: ${(e as Error).message}`);
    } finally {
      this.n++;
    }
  }
}

/** 对称态：h（握手哈希）/ ck（链密钥）/ 临时 CipherState。 */
class SymmetricState {
  h: Uint8Array;
  private ck: Uint8Array;
  cipher: CipherState;

  constructor(protocolName: string, prologue: Uint8Array) {
    const name = utf8Encode(protocolName);
    if (name.length <= 32) {
      const padded = new Uint8Array(32);
      padded.set(name, 0);
      this.h = padded;
    } else {
      this.h = sha256([name]);
    }
    this.ck = this.h.slice();
    this.cipher = new CipherState(null);
    this.mixHash(prologue);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256([this.h, data]);
  }

  mixKey(ikm: Uint8Array): void {
    const okm = hkdfSha256(this.ck, ikm, EMPTY, 64);
    this.ck = okm.subarray(0, 32).slice();
    this.cipher = new CipherState(okm.subarray(32, 64).slice());
  }

  /** psk token（Noise 规范修订版 / snow 0.9）：ck, temp_h, temp_k = HKDF(ck, data, 3)。 */
  mixKeyAndHash(data: Uint8Array): void {
    const okm = hkdfSha256(this.ck, data, EMPTY, 96);
    this.ck = okm.subarray(0, 32).slice();
    this.mixHash(okm.subarray(32, 64).slice());
    this.cipher = new CipherState(okm.subarray(64, 96).slice());
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(data: Uint8Array): Uint8Array {
    const pt = this.cipher.decrypt(this.h, data);
    this.mixHash(data);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const okm = hkdfSha256(this.ck, EMPTY, EMPTY, 64);
    return [new CipherState(okm.subarray(0, 32).slice()), new CipherState(okm.subarray(32, 64).slice())];
  }
}

export interface HandshakeOptions {
  /** IKpsk2 的一次性密钥（仅 pair 模式；resume 传 null）。 */
  psk?: Uint8Array | null;
  /** 固定临时密钥（仅向量验证用；真实握手必须随机）。 */
  fixedEphemeral?: KeyPair | null;
}

/**
 * 握手状态机。用法（手机一侧）：
 *   const hs = new NoiseHandshake('initiator', own, hostPublic, prologueBytes, { psk });
 *   const msg1 = hs.writeMessage(EMPTY);        // 96 字节 → sc_init.msg
 *   // … 收到 sc_resp.msg …
 *   hs.readMessage(msg2);                       // 失败 = psk 不对 / 连错 Host
 *   const t = hs.split();                       // t.seal / t.open
 */
export class NoiseHandshake {
  private ss: SymmetricState;
  private s: KeyPair;
  private rs: Uint8Array;
  private re: Uint8Array | null = null;
  private e: KeyPair | null = null;
  private role: NoiseRole;
  private psk: Uint8Array | null;
  private pskMode: boolean;
  private fixedEphemeral: KeyPair | null;
  private turn: number;

  constructor(role: NoiseRole, own: KeyPair, remoteStatic: Uint8Array, prologue: Uint8Array, options?: HandshakeOptions) {
    this.role = role;
    this.s = own;
    this.rs = remoteStatic.slice();
    this.psk = options?.psk ?? null;
    this.pskMode = this.psk !== null;
    this.fixedEphemeral = options?.fixedEphemeral ?? null;
    this.turn = 0;
    const name = this.psk !== null ? NOISE_PAIR : NOISE_RESUME;
    this.ss = new SymmetricState(name, prologue);
    // 预消息 <- s：发起方混对端静态公钥，响应方混自己静态公钥
    if (this.role === 'initiator') {
      this.ss.mixHash(this.rs);
    } else {
      this.ss.mixHash(this.s.publicKey);
    }
  }

  /** 发起方写 msg1（e, es, s, ss）或响应方写 msg2（e, ee, se, psk2）。 */
  writeMessage(payload: Uint8Array): Uint8Array {
    this.e = this.makeEphemeral();
    const parts: Uint8Array[] = [this.e.publicKey];
    this.ss.mixHash(this.e.publicKey);
    if (this.pskMode) {
      // psk 模式（Noise 规范修订 / snow 0.9）：e 公钥除 MixHash 外还要 MixKey
      this.ss.mixKey(this.e.publicKey);
    }
    if (this.turn === 0 && this.role === 'initiator') {
      // -> e, es, s, ss
      this.ss.mixKey(dh(this.e.privateKey, this.rs));
      parts.push(this.ss.encryptAndHash(this.s.publicKey));
      this.ss.mixKey(dh(this.s.privateKey, this.rs));
    } else if (this.turn === 1 && this.role === 'responder') {
      // <- e, ee, se, psk
      if (this.re === null) {
        throw new NoiseError('responder: no msg1 read yet');
      }
      this.ss.mixKey(dh(this.e.privateKey, this.re));
      this.ss.mixKey(dh(this.e.privateKey, this.rs));
      if (this.psk !== null) {
        this.ss.mixKeyAndHash(this.psk);
      }
    } else {
      throw new NoiseError('writeMessage: wrong turn');
    }
    parts.push(this.ss.encryptAndHash(payload));
    this.turn++;
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

  /** 发起方读 msg2（e, ee, se, psk2）或响应方读 msg1（e, es, s, ss）。 */
  readMessage(message: Uint8Array): Uint8Array {
    if (message.length < 32) {
      throw new NoiseError('handshake message too short');
    }
    this.re = message.subarray(0, 32).slice();
    this.ss.mixHash(this.re);
    if (this.pskMode) {
      // psk 模式：对端 e 公钥同样进链密钥
      this.ss.mixKey(this.re);
    }
    if (this.turn === 0 && this.role === 'responder') {
      // -> e, es, s, ss
      if (message.length !== 96) {
        throw new NoiseError(`bad msg1 length: ${message.length}`);
      }
      this.ss.mixKey(dh(this.s.privateKey, this.re));
      this.rs = this.ss.decryptAndHash(message.subarray(32, 80));
      this.ss.mixKey(dh(this.s.privateKey, this.rs));
      const payload = this.ss.decryptAndHash(message.subarray(80));
      this.turn++;
      return payload;
    }
    if (this.turn === 1 && this.role === 'initiator') {
      // <- e, ee, se, psk
      if (message.length !== 48) {
        throw new NoiseError(`bad msg2 length: ${message.length}`);
      }
      if (this.e === null) {
        throw new NoiseError('initiator: msg1 not written yet');
      }
      this.ss.mixKey(dh(this.e.privateKey, this.re));
      this.ss.mixKey(dh(this.s.privateKey, this.re));
      if (this.psk !== null) {
        this.ss.mixKeyAndHash(this.psk);
      }
      const payload = this.ss.decryptAndHash(message.subarray(32));
      this.turn++;
      return payload;
    }
    throw new NoiseError('readMessage: wrong turn');
  }

  /** 响应方读出对端（手机）静态公钥（msg1 之后才可用）。 */
  get remoteStatic(): Uint8Array {
    return this.rs.slice();
  }

  /** 握手完成 → 传输态（发起方/响应方各自的收发方向）。 */
  split(): NoiseTransport {
    const [c1, c2] = this.ss.split();
    return this.role === 'initiator' ? new NoiseTransport(c1, c2) : new NoiseTransport(c2, c1);
  }

  private makeEphemeral(): KeyPair {
    if (this.fixedEphemeral !== null) {
      return this.fixedEphemeral;
    }
    throw new NoiseError('no ephemeral source: pass options.fixedEphemeral or wire a random generator');
  }
}

/**
 * 传输态：握手完成后两个方向的加密通道。
 * seal/open 各自维护严格递增计数器——WebSocket 有序，乱序/重放即解密失败。
 */
export class NoiseTransport {
  private send: CipherState;
  private recv: CipherState;

  constructor(send: CipherState, recv: CipherState) {
    this.send = send;
    this.recv = recv;
  }

  /** 加密一块明文（调用方负责 32 KiB 分块与 last 标记）。 */
  seal(plaintext: Uint8Array): Uint8Array {
    return this.send.encrypt(EMPTY, plaintext);
  }

  /** 解密一块密文；失败抛 NoiseError（= 通道不可信，立即断开）。 */
  open(ciphertext: Uint8Array): Uint8Array {
    return this.recv.decrypt(EMPTY, ciphertext);
  }
}

/** prologue：把通道绑到这台 Host 与协议版本上（两端必须一致）。 */
export function noisePrologue(deviceId: string): Uint8Array {
  return utf8Encode(`aide-link/1:${deviceId}`);
}

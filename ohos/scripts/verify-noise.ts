/**
 * 密码学层向量验证（Node 直跑，不进应用构建）：
 *   tsc scripts/verify-noise.ts --outDir <temp> --module commonjs --target es2022 --skipLibCheck --ignoreConfig
 *   node <temp>/scripts/verify-noise.js
 * 覆盖：SHA-256 / HMAC / HKDF / X25519 / ChaCha20 / Poly1305 / AEAD 的 RFC 官方向量，
 * 以及 crates/aide-link/tests/fixtures/noise_vectors.json 的逐字节一致性向量
 * （msg1/msg2 十六进制与 base64、传输态双向第一块密文） */
declare const require: (id: string) => {
  readFileSync(p: string, enc: string): string;
  resolve(...parts: string[]): string;
};
declare const __dirname: string;
declare const process: { exit(code: number): void; argv: string[] };
const fs = require('fs');
const path = require('path');
import { sha256, hmacSha256, hkdfSha256 } from '../entry/src/main/ets/sdk/crypto/sha256';
import { x25519, x25519Public } from '../entry/src/main/ets/sdk/crypto/x25519';
import { chacha20Poly1305Seal, chacha20Poly1305Open } from '../entry/src/main/ets/sdk/crypto/aead';
import { b64Encode, b64Decode, hexEncode, hexDecode, utf8Encode, utf8Decode } from '../entry/src/main/ets/sdk/crypto/bytes';
import { NoiseHandshake, NoiseTransport, noisePrologue, KeyPair } from '../entry/src/main/ets/sdk/crypto/noise';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function eqBytes(name: string, got: Uint8Array, want: Uint8Array): void {
  const g = hexEncode(got);
  const w = hexEncode(want);
  let detail = '';
  if (g !== w) {
    // 首个差异字节定位 + 上下文窗口
    let first = -1;
    const n = Math.max(got.length, want.length);
    for (let i = 0; i < n; i++) {
      const a = i < got.length ? got[i] : -1;
      const b = i < want.length ? want[i] : -1;
      if (a !== b) {
        first = i;
        break;
      }
    }
    const lo = Math.max(0, first - 8);
    const hi = Math.min(n, first + 16);
    const gs = hexEncode(got.subarray(lo, Math.min(hi, got.length)));
    const ws = hexEncode(want.subarray(lo, Math.min(hi, want.length)));
    detail = `len ${got.length} vs ${want.length}, first diff @${first}: got[..${lo}..${hi}] ${gs} want ${ws}`;
  }
  check(name, g === w, detail);
}

function hex(s: string): Uint8Array {
  return hexDecode(s.replace(/[:\s]/g, ''));
}

function kp(privHex: string, pubHex: string): KeyPair {
  return { privateKey: hex(privHex), publicKey: hex(pubHex) };
}

// ── SHA-256 ──
console.log('SHA-256:');
eqBytes('abc', sha256([utf8Encode('abc')]), hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
eqBytes('empty', sha256([new Uint8Array(0)]), hex('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'));

// ── HMAC-SHA256（RFC 4231 TC1）──
console.log('HMAC-SHA256 (RFC 4231):');
const hmacKey = new Uint8Array(20).fill(0x0b);
eqBytes('tc1', hmacSha256(hmacKey, [utf8Encode('Hi There')]), hex('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'));

// ── HKDF（RFC 5869 TC1）──
console.log('HKDF-SHA256 (RFC 5869):');
{
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c]);
  const info = new Uint8Array([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
  eqBytes('tc1', hkdfSha256(salt, ikm, info, 42), hex('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'));
}

// ── X25519（RFC 7748）──
console.log('X25519 (RFC 7748):');
{
  const out1 = x25519(hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'), hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'));
  eqBytes('5.2 vector 1', out1, hex('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552'));
  const out2 = x25519(hex('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d'), hex('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493'));
  eqBytes('5.2 vector 2', out2, hex('95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957'));
}
{
  const alice = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bob = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  eqBytes('6.1 alice pub', x25519Public(alice), hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'));
  eqBytes('6.1 bob pub', x25519Public(bob), hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'));
  eqBytes('6.1 shared', x25519(alice, x25519Public(bob)), hex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'));
}

// ── ChaCha20-Poly1305（RFC 8439）──
console.log('ChaCha20-Poly1305 (RFC 8439):');
{
  // §2.8.2 AEAD test vector
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = 0x80 + i;
  }
  const nonce = hex('070000004041424344454647');
  const aad = hex('50515253c0c1c2c3c4c5c6c7');
  const pt = utf8Encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const sealed = chacha20Poly1305Seal(key, nonce, aad, pt);
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  eqBytes('2.8.2 ciphertext', ct, hex('d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116'));
  eqBytes('2.8.2 tag', tag, hex('1ae10b594f09e26a7e902ecbd0600691'));
  const opened = chacha20Poly1305Open(key, nonce, aad, sealed);
  check('2.8.2 roundtrip', utf8Decode(opened) === utf8Decode(pt));
  let tampered = sealed.slice();
  tampered[0] ^= 1;
  let threw = false;
  try {
    chacha20Poly1305Open(key, nonce, aad, tampered);
  } catch (e) {
    threw = true;
  }
  check('2.8.2 tamper rejected', threw);
}

// ── 编码工具 ──
console.log('bytes:');
{
  const sample = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  check('b64 roundtrip', hexEncode(b64Decode(b64Encode(sample))) === hexEncode(sample));
  check('b64 standard padding', b64Encode(new Uint8Array([0xfb])) === '+w==');
  check('b64url', b64Encode(sample).length > 0 && b64Encode(new Uint8Array([0xfb])) === '+w==');
  const zh = ' aide-link/1:0011¾中文';
  check('utf8 roundtrip', utf8Decode(utf8Encode(zh)) === zh);
}

// ── noise_vectors.json：逐字节一致性 ──
console.log('noise_vectors.json:');
{
  // 编译产物可能跑在任意目录（temp outDir），仓库根由 argv[2] 传入；缺省按源码布局回退
  const rootArg = process.argv.length > 2 ? process.argv[2] : path.resolve(__dirname, '../..');
  const p = path.resolve(rootArg, 'src-tauri/crates/aide-link/tests/fixtures/noise_vectors.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8')) as { vectors: Record<string, unknown>[] };
  for (const v of doc.vectors) {
    const inputs = v.inputs as Record<string, string | null>;
    const hs = v.handshake as Record<string, Record<string, unknown> | string>;
    const transport = v.transport as Record<string, Record<string, unknown> | undefined>;
    const name = v.name as string;
    const mode = ((hs.sc_init as Record<string, unknown>).mode) as string;
    const psk = inputs.psk_hex ? hex(inputs.psk_hex as string) : null;
    const phone = kp(inputs.phone_private_hex as string, inputs.phone_public_hex as string);
    const host = kp(inputs.host_private_hex as string, inputs.host_public_hex as string);
    const eInit = { privateKey: hex(inputs.initiator_ephemeral_private_hex as string), publicKey: x25519Public(hex(inputs.initiator_ephemeral_private_hex as string)) };
    const eResp = { privateKey: hex(inputs.responder_ephemeral_private_hex as string), publicKey: x25519Public(hex(inputs.responder_ephemeral_private_hex as string)) };
    const prologue = utf8Encode(inputs.prologue_utf8 as string);
    check(`${name}: prologue helper`, hexEncode(noisePrologue(inputs.device_id as string)) === hexEncode(prologue));

    const initiator = new NoiseHandshake('initiator', phone, host.publicKey, prologue, { psk, fixedEphemeral: eInit });
    const msg1 = initiator.writeMessage(new Uint8Array(0));
    eqBytes(`${name}: msg1 bytes`, msg1, hex(hs.msg1_hex as string));
    check(`${name}: sc_init.msg base64`, b64Encode(msg1) === ((hs.sc_init as Record<string, unknown>).msg as string));

    const responder = new NoiseHandshake('responder', host, phone.publicKey, prologue, { psk, fixedEphemeral: eResp });
    const payload1 = responder.readMessage(msg1);
    check(`${name}: msg1 payload empty`, payload1.length === 0);
    eqBytes(`${name}: responder learns phone static`, responder.remoteStatic, phone.publicKey);

    const msg2 = responder.writeMessage(new Uint8Array(0));
    eqBytes(`${name}: msg2 bytes`, msg2, hex(hs.msg2_hex as string));
    check(`${name}: sc_resp.msg base64`, b64Encode(msg2) === ((hs.sc_resp as Record<string, unknown>).msg as string));
    const payload2 = initiator.readMessage(msg2);
    check(`${name}: msg2 payload empty`, payload2.length === 0);

    const phoneT = initiator.split();
    const hostT = responder.split();

    const p2h = transport.phone_to_host as Record<string, unknown>;
    const h2p = transport.host_to_phone as Record<string, unknown>;
    const hello = utf8Encode(p2h.plaintext_utf8 as string);
    const sealed = phoneT.seal(hello);
    eqBytes(`${name}: phone→host first ciphertext`, sealed, b64Decode(((p2h.sc as Record<string, unknown>).c as string)));
    const opened = hostT.open(b64Decode(((p2h.sc as Record<string, unknown>).c as string)));
    check(`${name}: host opens phone frame`, utf8Decode(opened) === (p2h.plaintext_utf8 as string));

    const sealed2 = hostT.seal(utf8Encode(h2p.plaintext_utf8 as string));
    eqBytes(`${name}: host→phone first ciphertext`, sealed2, b64Decode(((h2p.sc as Record<string, unknown>).c as string)));
    const opened2 = phoneT.open(b64Decode(((h2p.sc as Record<string, unknown>).c as string)));
    check(`${name}: phone opens host frame`, utf8Decode(opened2) === (h2p.plaintext_utf8 as string));

    // 错 psk 的 pair 握手必须在发起方读 msg2 时失败
    if (psk !== null) {
      const badInitiator = new NoiseHandshake('initiator', phone, host.publicKey, prologue, { psk: new Uint8Array(32).fill(0x77), fixedEphemeral: eInit });
      badInitiator.writeMessage(new Uint8Array(0));
      let failed = false;
      try {
        badInitiator.readMessage(msg2);
      } catch (e) {
        failed = true;
      }
      check(`${name}: wrong psk rejected at msg2`, failed);
    }
  }
}

console.log(failures === 0 ? '\nALL VECTORS PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

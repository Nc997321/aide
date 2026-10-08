// Brute-force the effective h0 snow used for the pair vector
// usage: node scripts/debug-pair.cjs <compiled-out-dir>
const fs = require('fs');
const path = require('path');
const { sha256, hkdfSha256 } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/sha256.js');
const { x25519, x25519Public } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/x25519.js');
const { chacha20Poly1305Seal } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/aead.js');
const { utf8Encode, hexDecode, hexEncode } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/bytes.js');

const repo = process.argv[3];
const doc = JSON.parse(fs.readFileSync(path.resolve(repo, 'src-tauri/crates/aide-link/tests/fixtures/noise_vectors.json'), 'utf8'));
const v = doc.vectors.find((x) => x.name.includes('pair'));
const inp = v.inputs;

const phonePriv = hexDecode(inp.phone_private_hex);
const phonePub = hexDecode(inp.phone_public_hex);
const hostPub = hexDecode(inp.host_public_hex);
const eInit = hexDecode(inp.initiator_ephemeral_private_hex);
const prologue = utf8Encode(inp.prologue_utf8);
const wantMsg1 = hexDecode(v.handshake.msg1_hex);

function nonceOf() {
  return new Uint8Array(12);
}

function buildMsg1(h0) {
  let h = h0;
  let ck = h0.slice();
  h = sha256([h, prologue]);
  h = sha256([h, hostPub]); // initiator pre-message <- s
  const e = x25519Public(eInit);
  h = sha256([h, e]);
  // es
  let okm = hkdfSha256(ck, x25519(eInit, hostPub), new Uint8Array(0), 64);
  ck = okm.subarray(0, 32);
  const k1 = okm.subarray(32, 64);
  const ctS = chacha20Poly1305Seal(k1, nonceOf(), h, phonePub);
  h = sha256([h, ctS]);
  // ss
  okm = hkdfSha256(ck, x25519(phonePriv, hostPub), new Uint8Array(0), 64);
  ck = okm.subarray(0, 32);
  const k2 = okm.subarray(32, 64);
  const ctEmpty = chacha20Poly1305Seal(k2, nonceOf(), h, new Uint8Array(0));
  const out = new Uint8Array(e.length + ctS.length + ctEmpty.length);
  out.set(e, 0);
  out.set(ctS, e.length);
  out.set(ctEmpty, e.length + ctS.length);
  return out;
}

function tryH0(label, h0) {
  const got = buildMsg1(h0);
  const ok = hexEncode(got) === hexEncode(wantMsg1);
  console.log(ok ? `MATCH  ${label}` : `no     ${label}`);
  return ok;
}

const name36 = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256';
const name32 = 'Noise_IK_25519_ChaChaPoly_SHA256';
const name36b = utf8Encode(name36);

// candidate 1: spec — SHA256(name)
tryH0('SHA256(name36)', sha256([name36b]));
// candidate 2: name truncated to 32 bytes
const trunc = new Uint8Array(32);
trunc.set(name36b.subarray(0, 32));
tryH0('name36[0..32]', trunc);
// candidate 3: name zero-padded to 64, take first 32
const pad64 = new Uint8Array(64);
pad64.set(name36b);
const c64 = pad64.subarray(0, 32);
tryH0('name36 padded-64 first32', c64.slice());
// candidate 4: full 64-byte padded h (mix_hash over 64 bytes)
// candidate 5: IK name h0 (if modifier dropped)
tryH0('SHA256(name32-IK)', sha256([utf8Encode(name32)]));
const t32 = new Uint8Array(32);
t32.set(utf8Encode(name32));
tryH0('name32 padded', t32.slice());
// candidate 6: zeros
tryH0('zeros', new Uint8Array(32));
// candidate 7: name36 padded to 48?
const pad48 = new Uint8Array(48);
pad48.set(name36b);
tryH0('name36 padded-48 (48-byte h not supported)', pad48.subarray(0, 32).slice());

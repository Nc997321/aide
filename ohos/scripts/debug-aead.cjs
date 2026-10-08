// ChaCha20-Poly1305 differential debug vs node:crypto
// usage: node scripts/debug-aead.cjs <compiled-out-dir>
const nodeCrypto = require('node:crypto');
const { chacha20Poly1305Seal } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/aead.js');

function hex(b) {
  return Buffer.from(b).toString('hex');
}

function nodeSeal(key, nonce, aad, pt) {
  const c = nodeCrypto.createCipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(nonce));
  if (aad.length > 0) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(pt)), c.final()]);
  return { ct: new Uint8Array(ct), tag: new Uint8Array(c.getAuthTag()) };
}

function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : -1;
    const y = i < b.length ? b[i] : -1;
    if (x !== y) return i;
  }
  return -1;
}

// RFC 8439 2.8.2
const key = new Uint8Array(32);
for (let i = 0; i < 32; i++) key[i] = 0x80 + i;
const nonce = Buffer.from('070000004041424344454647', 'hex');
const aad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.", 'utf8');
const mine = chacha20Poly1305Seal(key, nonce, aad, pt);
const ref = nodeSeal(key, nonce, aad, pt);
const myCt = mine.subarray(0, mine.length - 16);
const myTag = mine.subarray(mine.length - 16);
console.log('rfc ct  first diff @', firstDiff(myCt, ref.ct), 'mine:', hex(myCt.slice(72, 96)));
console.log('                ref:', hex(ref.ct.slice(72, 96)));
console.log('rfc tag match:', hex(myTag) === hex(ref.tag), 'mine:', hex(myTag), 'ref:', hex(ref.tag));

// random differential
let bad = 0;
for (let i = 0; i < 30; i++) {
  const k = new Uint8Array(32);
  for (let j = 0; j < 32; j++) k[j] = Math.floor(Math.random() * 256);
  const nc = new Uint8Array(12);
  for (let j = 0; j < 12; j++) nc[j] = Math.floor(Math.random() * 256);
  const al = [0, 12, 32][i % 3];
  const pl = [0, 1, 31, 63, 64, 65, 127, 128, 200][i % 9];
  const ad = new Uint8Array(al);
  for (let j = 0; j < al; j++) ad[j] = Math.floor(Math.random() * 256);
  const p = new Uint8Array(pl);
  for (let j = 0; j < pl; j++) p[j] = Math.floor(Math.random() * 256);
  const s = chacha20Poly1305Seal(k, nc, ad, p);
  const r = nodeSeal(k, nc, ad, p);
  const sct = s.subarray(0, s.length - 16);
  const stag = s.subarray(s.length - 16);
  const d1 = firstDiff(sct, r.ct);
  const d2 = firstDiff(stag, r.tag);
  if (d1 !== -1 || d2 !== -1) {
    bad++;
    console.log(`iter ${i} (aad ${al}, pt ${pl}): ct diff @${d1}, tag diff @${d2}`);
  }
}
console.log(bad === 0 ? 'ALL AEAD DIFFERENTIAL OK' : `${bad} mismatch iterations`);

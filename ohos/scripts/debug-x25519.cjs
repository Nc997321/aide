// X25519 differential debug vs node:crypto
// usage: node scripts/debug-x25519.cjs <compiled-out-dir>
const nodeCrypto = require('node:crypto');
const { x25519, x25519Public } = require(process.argv[2] + '/entry/src/main/ets/sdk/crypto/x25519.js');

const mask = 0x7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8n;
console.log('clamp mask hex digits:', mask.toString(16).length, '(expect 64)');

function rawKeys() {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    priv: new Uint8Array(privDer.subarray(privDer.length - 32)),
    pub: new Uint8Array(pubDer.subarray(pubDer.length - 32)),
    nodePriv: privateKey,
    nodePub: publicKey
  };
}

function hex(b) {
  return Buffer.from(b).toString('hex');
}

let bad = 0;
for (let i = 0; i < 8; i++) {
  const a = rawKeys();
  const b = rawKeys();
  const myPubA = x25519Public(a.priv);
  const pubOk = hex(myPubA) === hex(a.pub);
  const myShared = x25519(a.priv, b.pub);
  const nodeShared = nodeCrypto.diffieHellman({ privateKey: a.nodePriv, publicKey: b.nodePub });
  const sharedOk = hex(myShared) === nodeShared.toString('hex');
  if (!pubOk || !sharedOk) {
    bad++;
    console.log(`iter ${i}: pub ${pubOk ? 'OK' : 'MISMATCH got ' + hex(myPubA) + ' want ' + hex(a.pub)}`);
    console.log(`        shared ${sharedOk ? 'OK' : 'MISMATCH got ' + hex(myShared) + ' want ' + nodeShared.toString('hex')}`);
  }
}
console.log(bad === 0 ? 'ALL X25519 DIFFERENTIAL OK' : `${bad} mismatch iterations`);

const v1 = x25519(
  Buffer.from('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4', 'hex'),
  Buffer.from('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c', 'hex')
);
console.log('v1:', hex(v1) === 'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552' ? 'PASS' : 'FAIL ' + hex(v1));
const v2 = x25519(
  Buffer.from('4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d', 'hex'),
  Buffer.from('e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493', 'hex')
);
console.log('v2:', hex(v2) === '95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957' ? 'PASS' : 'FAIL ' + hex(v2));

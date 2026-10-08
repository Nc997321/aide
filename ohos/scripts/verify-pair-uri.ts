/**
 * 配对 URI 解析验证（Node 直跑）：
 *   tsc scripts/verify-pair-uri.ts --outDir <temp> --module commonjs --target es2022 --skipLibCheck --ignoreConfig
 *   node <temp>/scripts/verify-pair-uri.js
 * 覆盖：协议文档 §3.1 的样例 URI（含 URL 编码）、direct 形态、忽略未知键、
 * 各种字段错误（版本 / relay+direct 并存 / 缺 psk / 坏 base64 / 坏 id）。 */
declare const process: { exit(code: number): void };
import { parsePairUri, PairUriError, PairOffer } from '../entry/src/main/ets/sdk/pair-uri';
import { b64urlEncode, utf8Encode } from '../entry/src/main/ets/sdk/crypto/bytes';

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function expectError(name: string, code: string, input: string): void {
  try {
    parsePairUri(input);
    check(name, false, 'expected error but parsed');
  } catch (e) {
    const err = e as PairUriError;
    check(name, err instanceof PairUriError && err.code === code, `got ${(e as Error).message}`);
  }
}

function expectOffer(name: string, input: string, verify: (o: PairOffer) => boolean): void {
  try {
    const o = parsePairUri(input);
    check(name, verify(o));
  } catch (e) {
    check(name, false, `unexpected error: ${(e as Error).message}`);
  }
}

console.log('pair URI:');

// 协议文档 §3.1 样例（relay 值带百分号编码、尾部斜杠）
const hostPk = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  hostPk[i] = 0x80 + i;
}
const psk = new Uint8Array(32).fill(0x5a);
const pkB = b64urlEncode(hostPk);
const pskB = b64urlEncode(psk);
expectOffer('doc example relay', `aide-link://pair?v=1&relay=wss%3A%2F%2Frelay.example.com%2F&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}&n=My%20Host&exp=1900000000`, (o) => {
  return o.relay === 'wss://relay.example.com' && o.direct === null &&
    o.deviceId === '00112233445566778899aabbccddeeff' &&
    o.hostPublic.length === 32 && o.hostPublic[0] === 0x80 && o.hostPublic[31] === 0x9f &&
    o.psk.length === 32 && o.psk[0] === 0x5a &&
    o.name === 'My Host' && o.expiresAt === 1900000000;
});

// direct 形态 + 未知键忽略 + 大写 device_id 归一化
expectOffer('direct form, unknown keys, uppercase id',
  `aide-link://pair?v=1&direct=ws%3A%2F%2F192.168.1.5%3A9000%2Fws&id=ABCDEF0123456789ABCDEF0123456789&pk=${pkB}&psk=${pskB}&futurekey=whatever`, (o) => {
  return o.direct === 'ws://192.168.1.5:9000/ws' && o.relay === null &&
    o.deviceId === 'abcdef0123456789abcdef0123456789' &&
    o.name === null && o.expiresAt === null;
});

// 最小 URI：无 n / exp
expectOffer('minimal', `aide-link://pair?v=1&relay=wss://r.example.com&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`, (o) => {
  return o.relay === 'wss://r.example.com' && o.name === null && o.expiresAt === null;
});

// 前后空白容错
expectOffer('surrounding whitespace', `  aide-link://pair?v=1&direct=ws://h:1&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}\n`, (o) => {
  return o.direct === 'ws://h:1';
});

// 错误形态
expectError('not a pair uri', 'bad_format', 'https://example.com/pair?v=1');
expectError('empty', 'bad_format', '');
expectError('prefix only', 'bad_format', 'aide-link://pair');
expectError('bad escape', 'bad_format', `aide-link://pair?v=1&relay=%zz&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
expectError('version 2', 'bad_version', `aide-link://pair?v=2&relay=wss://r&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
expectError('missing version', 'bad_version', `aide-link://pair?relay=wss://r&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
expectError('relay and direct', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&direct=ws://h&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
expectError('neither relay nor direct', 'bad_fields', `aide-link://pair?v=1&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
expectError('bad id', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=xyz&pk=${pkB}&psk=${pskB}`);
expectError('short id', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeef&pk=${pkB}&psk=${pskB}`);
expectError('missing pk', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeeff&psk=${pskB}`);
expectError('pk not base64url', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeeff&pk=++++&psk=${pskB}`);
expectError('pk wrong length', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeeff&pk=${b64urlEncode(utf8Encode('short'))}&psk=${pskB}`);
expectError('missing psk', 'bad_fields', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeeff&pk=${pkB}`);
expectError('direct not ws', 'bad_fields', `aide-link://pair?v=1&direct=http://h&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}`);
// exp 非数字 → 宽容处理为 null（可选字段）
expectOffer('non-numeric exp tolerated', `aide-link://pair?v=1&relay=wss://r&id=00112233445566778899aabbccddeeff&pk=${pkB}&psk=${pskB}&exp=soon`, (o) => {
  return o.expiresAt === null;
});

console.log(failures === 0 ? '\nALL PAIR URI PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

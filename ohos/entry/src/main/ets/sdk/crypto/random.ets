/**
 * 平台 CSPRNG 适配：cryptoFramework → randomBytes(n)。
 *
 * crypto/noise.ts 是纯 TS（Node 直接跑向量验证），随机源刻意留在平台层：
 * 握手临时密钥、身份密钥对的熵全部来自系统安全随机数发生器
 * （cryptoFramework.Random 底底为系统 CSPRNG，满足不可预测性）。
 */
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/** 生成 n 个密码学随机字节（n > 0）。 */
export function randomBytes(n: number): Uint8Array {
  const rand: cryptoFramework.Random = cryptoFramework.createRandom();
  return rand.generateRandomSync(n).data;
}

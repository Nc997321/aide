/**
 * Backoff 单测：指数翻倍 + [0,500) 抖动 + 30s 封顶 + reset 归零。
 * 语义镜像桌面 relay.rs（健康史归零——旧实现成功后永不归零的缺陷不回归）。
 */
import { describe, it, expect } from '@ohos/hypium';
import { Backoff } from '../../../main/ets/sdk/link/backoff';

/** 断言 delay ∈ [lo, hi)。 */
function checkRange(delay: number, lo: number, hi: number): void {
  expect(delay >= lo).assertTrue();
  expect(delay < hi).assertTrue();
}

export default function backoffTest(): void {
  describe('Backoff', () => {
    it('next_基数1000翻倍封顶30s_含抖动', 0, (): void => {
      const b: Backoff = new Backoff();
      checkRange(b.next(), 1000, 1500);
      checkRange(b.next(), 2000, 2500);
      checkRange(b.next(), 4000, 4500);
      checkRange(b.next(), 8000, 8500);
      checkRange(b.next(), 16000, 16500);
      checkRange(b.next(), 30000, 30500);
    });

    it('next_封顶后恒为30s档', 0, (): void => {
      const b: Backoff = new Backoff();
      for (let i = 0; i < 6; i++) {
        b.next(); // 爬到封顶
      }
      for (let i = 0; i < 8; i++) {
        checkRange(b.next(), 30000, 30500);
      }
    });

    it('reset_健康史归零', 0, (): void => {
      const b: Backoff = new Backoff();
      for (let i = 0; i < 6; i++) {
        b.next(); // 封顶态
      }
      b.reset();
      checkRange(b.next(), 1000, 1500);
      checkRange(b.next(), 2000, 2500);
    });
  });
}

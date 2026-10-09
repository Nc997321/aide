/**
 * LinkAssembler 单测：sc 分块重组的纯逻辑面。
 * 空明文末块得空串（§4.3）、reset 不串块、超限抛错且状态不被污染。
 */
import { describe, it, expect } from '@ohos/hypium';
import { LinkAssembler, MAX_FRAME_BYTES } from '../../../main/ets/sdk/link/frames';
import { utf8Encode } from '../../../main/ets/sdk/crypto/bytes';

export default function assemblerTest(): void {
  describe('LinkAssembler', () => {
    it('push_单块还原完整帧', 0, (): void => {
      const a: LinkAssembler = new LinkAssembler();
      expect(a.push(utf8Encode('{"type":"ping","n":1}'), true)).assertEqual('{"type":"ping","n":1}');
    });

    it('push_多块拼接跨块帧', 0, (): void => {
      const a: LinkAssembler = new LinkAssembler();
      expect(a.push(utf8Encode('{"type":'), false)).assertNull();
      expect(a.push(utf8Encode('"pong"'), false)).assertNull();
      expect(a.push(utf8Encode(',"n":7}'), true)).assertEqual('{"type":"pong","n":7}');
    });

    it('push_空明文末块得空串', 0, (): void => {
      const a: LinkAssembler = new LinkAssembler();
      expect(a.push(new Uint8Array(0), true)).assertEqual('');
    });

    it('reset_丢弃半帧不串块', 0, (): void => {
      const a: LinkAssembler = new LinkAssembler();
      a.push(utf8Encode('残缺半帧'), false);
      a.reset();
      expect(a.push(utf8Encode('新帧'), true)).assertEqual('新帧');
    });

    it('push_超8MiB上限抛错且状态不污染', 0, (): void => {
      const a: LinkAssembler = new LinkAssembler();
      const big: Uint8Array = new Uint8Array(MAX_FRAME_BYTES + 1);
      let threw: boolean = false;
      try {
        a.push(big, false);
      } catch (e) {
        threw = true;
      }
      expect(threw).assertTrue();
      // 抛错发生在入队前：半块未累计，后续小帧不受影响
      expect(a.push(utf8Encode('ok'), true)).assertEqual('ok');
    });
  });
}

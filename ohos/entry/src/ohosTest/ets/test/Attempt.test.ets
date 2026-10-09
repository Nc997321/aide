/**
 * ConnAttempt 单测：终局二分映射 + 「废弃 attempt 结构性失声」不变量。
 *
 * 全部走 FakeWs 注入（无真 socket、无 DoH）；握手只走到 sc_init 发出，
 * 不应答 sc_resp——被测的是结论映射与失声守卫，不是 Noise 本身。
 * 定时器类用例把 watchdog/keepalive 注到 10ms 级，真机单测秒级完成。
 */
import { describe, it, expect } from '@ohos/hypium';
import { AttemptConfig, ConnAttempt } from '../../../main/ets/sdk/link/attempt';
import type { PairFailCode, WsLike } from '../../../main/ets/sdk/link/types';
import { KeyPair } from '../../../main/ets/sdk/crypto/noise';
import { x25519Public } from '../../../main/ets/sdk/crypto/x25519';
import { FakeWs } from '../testutil/FakeWs';

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve: (v: void) => void) => {
    setTimeout(resolve, ms);
  });
}

/** 任意种子 → 32B 私钥 → x25519 公钥（非零标量乘基点必得有效公钥）。 */
function testKey(seed: number): KeyPair {
  const priv: Uint8Array = new Uint8Array(32);
  priv[0] = seed & 0xFF;
  return { privateKey: priv, publicKey: x25519Public(priv) };
}

/** 中继模式 + 注入 FakeWs 的测试配置（watchdog/keepalive 默认真机值，可注 10ms 级）。 */
function makeConfig(ws: FakeWs, mode: 'pair' | 'resume', watchdogMs: number = 15000,
  keepaliveMs: number = 20000): AttemptConfig {
  return new AttemptConfig('ws://fake.local/ws', true, '0123456789abcdef0123456789abcdef',
    mode, mode === 'pair' ? new Uint8Array(32) : null, testKey(1), testKey(2).publicKey,
    (_url: string): WsLike => ws, watchdogMs, keepaliveMs);
}

/** 四路终局回调的记录仪（计数 + 收集参数）。 */
class AttemptRecorder {
  ready: number = 0;
  links: string[] = [];
  transient: string[] = [];
  definitive: string[] = [];

  wire(a: ConnAttempt): void {
    a.onChannelReady = (): void => {
      this.ready++;
    };
    a.onLinkFrame = (raw: string): void => {
      this.links.push(raw);
    };
    a.onTransient = (reason: string): void => {
      this.transient.push(reason);
    };
    a.onDefinitive = (code: PairFailCode): void => {
      this.definitive.push(code);
    };
  }
}

export default function attemptTest(): void {
  describe('ConnAttempt', () => {
    it('superseded_定性revoked且迟到事件零触发', 0, async (): Promise<void> => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume'));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      ws.emitOpen();
      ws.emitText('{"type":"connect_error","reason":"superseded"}');
      expect(rec.definitive.length).assertEqual(1);
      expect(rec.definitive[0]).assertEqual('revoked');
      // 终局后 socket 迟到帧/关闭：handler 已拆，结构性静默
      ws.emitText('{"type":"connect_error","reason":"device_offline"}');
      ws.emitClose(1006);
      await sleep(20);
      expect(rec.transient.length).assertEqual(0);
      expect(rec.definitive.length).assertEqual(1);
    });

    it('dispose_编排层废弃后零回调', 0, (): void => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume'));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      a.dispose();
      expect(a.isSettled()).assertTrue();
      ws.emitOpen();
      ws.emitText('{"type":"connect_error","reason":"superseded"}');
      ws.emitClose(1006);
      expect(rec.ready).assertEqual(0);
      expect(rec.transient.length).assertEqual(0);
      expect(rec.definitive.length).assertEqual(0);
    });

    it('watchdog_握手超时瞬断', 0, async (): Promise<void> => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume', 10, 20000));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      await sleep(80);
      expect(rec.transient.length).assertEqual(1);
      expect(rec.transient[0]).assertEqual('握手超时');
      expect(rec.definitive.length).assertEqual(0);
    });

    it('connect_error_主机离线瞬断', 0, (): void => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume'));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      ws.emitOpen();
      ws.emitText('{"type":"connect_error","reason":"device_offline"}');
      expect(rec.transient.length).assertEqual(1);
      expect(rec.transient[0]).assertEqual('连接断开');
      expect(rec.definitive.length).assertEqual(0);
    });

    it('sc_err_配对码过期定性expired', 0, (): void => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'pair'));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      ws.emitOpen();
      ws.emitText('{"type":"sc_err","code":"no_pairing_offer","message":""}');
      expect(rec.definitive.length).assertEqual(1);
      expect(rec.definitive[0]).assertEqual('expired');
    });

    it('sc_err_resume下同码只瞬断', 0, (): void => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume'));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      ws.emitOpen();
      ws.emitText('{"type":"sc_err","code":"no_pairing_offer","message":""}');
      // resume 模式下 no_pairing_offer 不是「码烧了」：瞬断重试
      expect(rec.transient.length).assertEqual(1);
      expect(rec.transient[0]).assertEqual('连接断开');
      expect(rec.definitive.length).assertEqual(0);
    });

    it('keepalive_中继心跳恒发_未authed不发e2e_ping', 0, async (): Promise<void> => {
      const ws: FakeWs = new FakeWs();
      const a: ConnAttempt = new ConnAttempt(makeConfig(ws, 'resume', 15000, 10));
      const rec: AttemptRecorder = new AttemptRecorder();
      rec.wire(a);
      ws.emitOpen();
      await sleep(80);
      a.dispose();
      expect(ws.hasSent('{"type":"keepalive"}')).assertTrue();
      // 阶段规则（§5）：hello 前发 ping 会被 bye{protocol_error} 踢掉
      expect(ws.hasSent('"type":"ping"')).assertFalse();
    });
  });
}

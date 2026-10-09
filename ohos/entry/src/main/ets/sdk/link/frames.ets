/**
 * Aide Link wire 帧目录（协议 §2.2/§4.1/§6）+ sc 分块重组器。
 *
 * 帧字段名是三端字符串契约（relay-server / src-tauri / 本机），冻结不改；
 * 各帧字段经协议文档对账，JSON 边界只信 type 判别字段探测。
 * LinkAssembler 是纯逻辑（无 socket、无定时器）：密文解开的明文块按序拼接，
 * last 时解码为完整 Link 帧——分块边界与加密边界由调用方（attempt.ets）对齐。
 */
import type { SinceInfo } from './types';
import { concatBytes, utf8Decode } from '../crypto/bytes';

// ── 中继层帧（协议 §2.2；仅中继模式可见）──

export interface RelayConnectMsg {
  type: 'connect';
  device_id: string;
}

export interface KeepaliveMsg {
  type: 'keepalive';
}

export interface ConnectErrorMsg {
  type: 'connect_error';
  reason: string;
}

// ── 安全通道外层帧（协议 §4.1）──

export interface ScInitMsg {
  type: 'sc_init';
  versions: number[];
  mode: string;
  msg: string;
}

export interface ScRespMsg {
  type: 'sc_resp';
  version: number;
  msg: string;
}

export interface ScErrMsg {
  type: 'sc_err';
  code: string;
  message: string;
}

export interface ScDataMsg {
  type: 'sc';
  c: string;
  last: boolean;
}

// ── Link 内层帧（协议 §6；密文承载）──

export interface ClientInfo {
  name: string;
  version: string;
  platform: string;
}

export interface HelloMsg {
  type: 'hello';
  client: ClientInfo;
}

export interface HostInfo {
  id: string;
  name: string;
  os: string;
  arch: string;
  version: string;
}

export interface HelloOkMsg {
  type: 'hello_ok';
  version: number;
  host: HostInfo;
  granted: string[];
}

export interface CallMsg {
  type: 'call';
  id: number;
  method: string;
  params: Record<string, Object>;
}

export interface ResultMsg {
  type: 'result';
  id: number;
  value: Object | null;
}

export interface ErrorMsg {
  type: 'error';
  id: number;
  code: string;
  message: string;
}

export interface SubscribeMsg {
  type: 'subscribe';
  sessions: null;
  since: SinceInfo | null;
}

export interface SubscribedMsg {
  type: 'subscribed';
  epoch: string;
  seq: number;
  resumed: boolean;
  gap: boolean;
  replayed: number;
}

export interface EventMsg {
  type: 'event';
  seq: number;
  name: string;
  payload: Record<string, Object>;
}

export interface PingMsg {
  type: 'ping';
  n: number;
}

export interface PongMsg {
  type: 'pong';
  n: number;
}

export interface ByeMsg {
  type: 'bye';
  code: string;
  message: string;
}

/** JSON 边界探测：只信 type 判别字段，各臂字段经协议文档对账。 */
export interface WireProbe {
  type: string;
}

export interface LinkProbe {
  type: string;
}

// ── 常量（协议 §2.1/§4.3）──

/** sc 分块：明文按 32768 字节切块，末块 last:true。 */
export const SC_CHUNK_BYTES = 32768;
/** 重组后 Link 帧上限 8 MiB（§2.1），超过即断开。 */
export const MAX_FRAME_BYTES = 8388608;

/**
 * 接收侧 sc 分块重组器：一次连接一个实例（块不跨连接），push 喂明文块。
 */
export class LinkAssembler {
  private chunks: Uint8Array[] = [];
  private len: number = 0;

  /**
   * 追加一块明文；last=true 时返回完整 Link 帧（空明文也得空串），否则 null。
   * 累计超过 MAX_FRAME_BYTES 抛错——调用方按瞬断处理（对端行为异常，§2.1）。
   */
  push(chunk: Uint8Array, last: boolean): string | null {
    if (this.len + chunk.length > MAX_FRAME_BYTES) {
      throw new Error(`Link 帧超过 ${MAX_FRAME_BYTES} 字节上限`);
    }
    this.chunks.push(chunk);
    this.len += chunk.length;
    if (!last) {
      return null;
    }
    const frame: Uint8Array = concatBytes(this.chunks);
    this.reset();
    return utf8Decode(frame);
  }

  /** 丢弃未完成的半帧（防御性接口：正常生命周期随连接实例一起丢弃）。 */
  reset(): void {
    this.chunks = [];
    this.len = 0;
  }
}

/**
 * Aide Link 公开类型（叶节点，零依赖）。
 *
 * 连接状态机、配对结果、断线续传位置与平台 WebSocket 子集接口——sdk/remote.ets
 * 经显式 re-export 保持原导入面（ConnModel/ConnectPage/ws-ohos 零改动）。
 * 本文件只放「消费方需要的形状」，wire 帧目录在 frames.ets，策略类型留在 remote.ets。
 */

/** 连接状态机（RemoteTransport 单点迁移；UI 据 ConnState 分形）。 */
export type ConnState =
  'idle' | // 未连接（用户主动断开）
  'connecting' | // 正在连（中继/direct + 握手 + hello，直到 hello_ok）
  'authed' | // 已认证（hello_ok 已回，订阅已发），可收发
  'needsPairing' | // 定性失败：需重新扫码配对（凭据被吊销/顶替/二维码烧掉/版本不兼容）
  'offline'; // 瞬断：自动退避重试中

/** 断线续传位置（协议 §9）。 */
export interface SinceInfo {
  epoch: string;
  seq: number;
}

export interface PairDone {
  hostName: string | null;
}

export type PairFailCode = 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | 'aborted';

function pairFailText(code: PairFailCode): string {
  if (code === 'expired') {
    return '配对二维码已过期或已被使用';
  }
  if (code === 'badhandshake') {
    return '配对握手失败，请重新扫码';
  }
  if (code === 'revoked') {
    return '配对已被撤销或被新设备顶替';
  }
  if (code === 'unsupported') {
    return '协议版本不兼容，请升级应用';
  }
  return '已取消';
}

/** 配对失败（带类型化 code，UI 按码给文案；协议 §10 错误码封闭集合）。 */
export class PairFailError extends Error {
  readonly code: PairFailCode;

  constructor(code: PairFailCode) {
    super(pairFailText(code));
    this.code = code;
  }
}

// ── 最小事件形状（ArkTS 无 DOM lib；ws-ohos.ets 按此适配）──

export interface WsOpenEvent {}

export interface WsMessageEvent {
  data: string | ArrayBuffer;
}

export interface WsCloseEvent {
  code: number;
  reason: string;
}

export interface WsErrorEvent {
  message: string;
}

/** 客户端实际用到的 WebSocket 子集（结构化类型，测试可注入假实现）。 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: WsOpenEvent) => void) | null;
  onmessage: ((ev: WsMessageEvent) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
  onerror: ((ev: WsErrorEvent) => void) | null;
}

/** 外链打开注入点（平台绑定：ohos 由 ws-ohos.ets 的 makeOpenUrl 提供）。 */
export type OpenUrlFn = (url: string) => void;

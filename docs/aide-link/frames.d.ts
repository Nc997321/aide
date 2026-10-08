/**
 * Aide Link v1 的帧类型（叙述版见 ../aide-link-protocol.md；Rust 真相源见
 * src-tauri/crates/aide-link/src/frame.rs——二者由 aide-link 的 `typescript_parity` 测试守着同步）。
 *
 * 这只是类型声明，不含运行时代码；手机端（PWA / ArkTS）按它实现即可。
 * 配对二维码的内容见 ../aide-link-protocol.md §3（`aide-link://pair?…`）。
 */

export const LINK_PROTOCOL_VERSION: 1;

// ── 通用 ──

export type ErrorCode =
  | "unsupported_version"
  | "unauthorized"
  | "no_pairing_offer"
  | "bad_handshake"
  | "unauthenticated"
  | "unknown_method"
  | "invalid_frame"
  | "invalid_params"
  | "failed"
  | "busy"
  | "internal"
  | "superseded"
  | "revoked"
  | "shutdown"
  | "timeout"
  | "too_large"
  | "protocol_error";

export interface ClientInfo { name?: string; version?: string; platform?: string }
export interface HostInfo { id: string; name: string; os: string; arch: string; version: string }
export interface Limits { max_frame_bytes: number; max_in_flight: number }
/** 续传位置：哪一代 Host（epoch）的第几号事件。 */
export interface Since { epoch: string; seq: number }

// ── 外层（安全通道）：握手 + 加密数据，明文 JSON，中继看得到、看不懂 ──

export type ScMode = "pair" | "resume";

export type WireFrame =
  /** 手机 → Host：发起握手。`msg` = Noise 第一条消息（标准 base64）。 */
  | { type: "sc_init"; versions: number[]; mode: ScMode; msg: string }
  /** Host → 手机：握手第二条消息。 */
  | { type: "sc_resp"; version: number; msg: string }
  /** Host → 手机：握手被拒（随后断开）。 */
  | { type: "sc_err"; code: ErrorCode; message: string }
  /** 双向：一块密文（标准 base64）；`last` = 一个 Link 帧的末块。 */
  | { type: "sc"; c: string; last: boolean };

// ── 内层 Link 帧（经 `sc` 加密承载）：客户端 → Host ──

export type ClientFrame =
  | { type: "hello"; client?: ClientInfo }
  | { type: "call"; id: number; method: string; params?: Record<string, unknown> }
  | { type: "subscribe"; sessions?: string[] | null; since?: Since | null }
  | { type: "unsubscribe" }
  | { type: "ping"; n: number }
  | { type: "pong"; n: number };

// ── 内层 Link 帧：Host → 客户端 ──

export type HostFrame =
  | { type: "hello_ok"; version: number; host: HostInfo; granted: string[]; limits: Limits }
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id?: number; code: ErrorCode; message: string }
  | { type: "subscribed"; epoch: string; seq: number; resumed: boolean; gap: boolean; replayed: number }
  | { type: "event"; seq: number; name: string; payload: unknown }
  | { type: "ping"; n: number }
  | { type: "pong"; n: number }
  | { type: "bye"; code: ErrorCode; message: string };

// ── link.describe 的结果 ──

export interface LinkCatalog {
  version: 1;
  groups: Array<{ id: string; title: string; methods: string[] }>;
  link_methods: string[];
  events: Array<{ name: string; session_routed: boolean }>;
}

// ── 中继层帧（relay-server，不属于 Aide Link，仅为完整起见）──

export type RelayClientFrame =
  /** Link v1 只用 device_id 寻址（二维码里的 `id`）；`code` 形态是旧协议 v2 的。 */
  | { type: "connect"; device_id: string }
  | { type: "keepalive" };

export type RelayHostFrame = { type: "connect_error"; reason: "unknown_code" | "device_offline" | "superseded" | (string & {}) };

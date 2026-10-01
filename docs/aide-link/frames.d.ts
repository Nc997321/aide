/**
 * Aide Link v1 的帧类型（叙述版见 ../aide-link-protocol.md；Rust 真相源见
 * src-tauri/crates/aide-link/src/frame.rs——二者由 aide-link 的 `typescript_parity` 测试守着同步）。
 *
 * 这只是类型声明，不含运行时代码；手机端（PWA / ArkTS）按它实现即可。
 */

export const LINK_PROTOCOL_VERSION: 1;

// ── 通用 ──

export type ErrorCode =
  | "unsupported_version"
  | "bad_code"
  | "expired_code"
  | "bad_token"
  | "too_many_attempts"
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
export interface DeviceInfo { name?: string }
export interface HostInfo { id: string; name: string; os: string; arch: string; version: string }
export interface Limits { max_frame_bytes: number; max_in_flight: number }
/** 续传位置：哪一代 Host（epoch）的第几号事件。 */
export interface Since { epoch: string; seq: number }

// ── 客户端 → Host ──

export type ClientFrame =
  | { type: "hello"; versions: number[]; client?: ClientInfo }
  | { type: "pair"; code: string; device?: DeviceInfo }
  | { type: "auth"; token: string }
  | { type: "call"; id: number; method: string; params?: Record<string, unknown> }
  | { type: "subscribe"; sessions?: string[] | null; since?: Since | null }
  | { type: "unsubscribe" }
  | { type: "ping"; n: number }
  | { type: "pong"; n: number };

// ── Host → 客户端 ──

export type HostFrame =
  | { type: "hello_ok"; version: number; host: HostInfo; auth: Array<"pair" | "token">; limits: Limits }
  | { type: "hello_err"; code: ErrorCode; supported: number[] }
  | { type: "paired"; device_id: string; token: string; granted: string[] }
  | { type: "authed"; granted: string[] }
  | { type: "auth_error"; code: ErrorCode; message: string }
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
  | { type: "connect"; code: string }
  | { type: "connect"; device_id: string; token: string }
  | { type: "keepalive" };

export type RelayHostFrame = { type: "connect_error"; reason: "unknown_code" | "device_offline" | "superseded" | (string & {}) };

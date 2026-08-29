// L1 持久层门面。依赖红线：persistence → 仅 @/api。
export { readSessionMeta, writeSessionMeta } from "./sessionMeta";
export type { SessionMeta, SessionMetaPatch } from "./sessionMeta";
/**
 * 会话身份模块门面（组织文件，上层）。应用只 import 这里，不深入子层。
 *
 * 三层（目录从上到下 = 抽象→具体 = 依赖方→被依赖方，符合"抽象上、实现在下"）：
 *   gate/        L3 门控——发送前确认的纯判定（零依赖、零副作用）
 *   identity/    L2 身份——会话供应商/模型单一真相源（依赖 persistence + 注册表 + utils）
 *   persistence/ L1 持久——元数据读写收口（仅依赖 @/api）
 *
 * 依赖红线（单向，违反即目录层面可见）：
 *   gate → 无；identity → persistence + useSessionProviders 注册表 + utils + @/api；persistence → @/api。
 * 层内不反向依赖、不跨层直连（identity 不绕过 persistence 写盘，gate 不碰状态）。
 */
export { useSessionIdentity } from "./sessionIdentity/identity";
export type { Identity } from "./sessionIdentity/identity";
export { needsConfirm, buildConfirmDecision } from "./sessionIdentity/gate";
export type { ConfirmChanged, ConfirmDecision } from "./sessionIdentity/gate";
export { readSessionMeta, writeSessionMeta } from "./sessionIdentity/persistence";
export type { SessionMeta, SessionMetaPatch } from "./sessionIdentity/persistence";
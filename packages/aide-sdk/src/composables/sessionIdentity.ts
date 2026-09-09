/**
 * 会话身份模块门面（组织文件，上层）。应用只 import 这里，不深入子层。
 *
 * 四层（目录从上到下 = 抽象→具体 = 依赖方→被依赖方，符合"抽象上、实现在下"）：
 *   gate/        L3 门控——发送前确认的判定（规则下沉 Rust，本层只调用 + 裁剪结果）
 *   identity/    L2 身份——拆成两层：
 *                  store  仓库（全局一份，按 sid）：这条会话是什么身份
 *                  view   视图（每面板一份）      ：这个面板正在看哪条会话
 *   persistence/ L1 持久——元数据读写收口（仅依赖 @/api）
 *
 * 依赖红线（单向，违反即目录层面可见）：
 *   gate → @/api；view → store；store → persistence + useSessionProviders 注册表 + utils + @/api；
 *   persistence → @/api。
 * 层内不反向依赖、不跨层直连（identity 不绕过 persistence 写盘，gate 不碰状态）。
 */
export {
  sessionIdentityStore,
  provideSessionIdentityView,
  useSessionIdentityView,
} from "./sessionIdentity/identity";
export type { Identity, SessionIdentityStore, SessionIdentityView } from "./sessionIdentity/identity";
export { buildConfirmDecision } from "./sessionIdentity/gate";
export type { ConfirmDecision } from "./sessionIdentity/gate";
export { readSessionMeta, writeSessionMeta } from "./sessionIdentity/persistence";
export type { SessionMeta, SessionMetaPatch } from "./sessionIdentity/persistence";

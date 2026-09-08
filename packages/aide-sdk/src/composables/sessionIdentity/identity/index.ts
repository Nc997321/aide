// L2 身份层门面：拆成「仓库（全局，按 sid）」+「视图（每面板一份）」两层。
//
// 依赖红线：identity → persistence + useSessionProviders 注册表 + utils 纯函数 + @/api。
// store 不知道谁在看，view 只持有"我在看谁"；两者单向：view → store。
export { sessionIdentityStore } from "./store";
export type { Identity, SessionIdentityStore } from "./store";
export { provideSessionIdentityView, useSessionIdentityView } from "./view";
export type { SessionIdentityView } from "./view";
export { resolveEffectiveModel, resolveEffectiveProvider } from "./resolver";
export { restoreModel } from "./restoreModel";

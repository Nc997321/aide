// L2 身份层门面。依赖红线：identity → persistence + useSessionProviders 注册表 + utils 纯函数 + @/api。
export { useSessionIdentity } from "./useSessionIdentity";
export type { Identity } from "./useSessionIdentity";
export { resolveEffectiveModel, resolveEffectiveProvider } from "./resolver";
export { restoreModel } from "./restoreModel";
// L3 门控层门面。依赖红线：gate → 无依赖（纯函数）。
export { needsConfirm, buildConfirmDecision } from "./confirmGate";
export type { Identity, ConfirmChanged, ConfirmDecision } from "./confirmGate";
// L3 门控层门面。依赖红线：gate → api（判定规则在 Rust，本层只调用）。
export { buildConfirmDecision } from "./confirmGate";
export type { ConfirmDecision } from "./confirmGate";

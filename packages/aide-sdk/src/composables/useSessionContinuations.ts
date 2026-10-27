import { reactive } from "vue";
import type { SessionContinued } from "../api";

/** Host 已落盘后的事件镜像；来源关系的权威仍是 session_handoff。 */
export const sessionContinuations = reactive<Record<string, SessionContinued>>({});

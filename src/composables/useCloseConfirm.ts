/**
 * 关最后一扇窗口时的询问卡片（「关闭 Aide 窗口？」）。
 *
 * 判定在 Rust（lib.rs 的 CloseRequested → commands/app.rs 的 decide_close）：用户选过「不再询问」
 * 或没有托盘时 Rust 直接收进托盘 / 退出，不会走到这里；要问时向**本窗口**发 `close-requested`，
 * 这里弹卡片、把选择落成动作（隐藏本窗口 / quit_app）。勾了「不再询问」就把选择存下
 * （set_close_behavior），设置 → 通用 可以改回。
 */
import { api, listen } from "@/api";
import type { CloseBehavior } from "@aide/sdk/types";
import CloseConfirm from "@/components/CloseConfirm.vue";
import { useModal } from "./useModal";
import { useSessionState } from "./useSessionState";
import { useWindowControls } from "./useWindowControls";

export const CLOSE_REQUESTED_EVENT = "close-requested";

type Choice = { action: "tray" | "quit"; remember: boolean };

/** 本窗口在跑的会话数（生成中 / 等权限）：退出会打断它们，卡片上点出来。 */
function runningCount(): number {
  return Object.values(useSessionState().state).filter((s) => s === "running" || s === "attention").length;
}

let asking = false;

/** 弹一次卡片并执行选择。连按两次 X 只弹一张。 */
export async function askAndClose(): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    const choice = await useModal().custom<Choice>({
      title: "关闭 Aide 窗口？",
      component: CloseConfirm,
      props: { running: runningCount() },
      width: "sm",
    });
    if (!choice) return;
    if (choice.remember) {
      const behavior: CloseBehavior = choice.action;
      await api.setCloseBehavior(behavior).catch((e) => console.warn("[close] 记住选择失败:", e));
    }
    if (choice.action === "quit") await api.quitApp();
    else await useWindowControls().hide();
  } finally {
    asking = false;
  }
}

/** App 挂载时装一次；返回解除监听。 */
export function installCloseConfirm(): Promise<() => void> {
  return listen(CLOSE_REQUESTED_EVENT, () => void askAndClose());
}

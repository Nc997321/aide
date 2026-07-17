import { reactive } from "vue";

export type ToastKind = "success" | "danger" | "info";

export interface ToastState {
  visible: boolean;
  text: string;
  kind: ToastKind;
}

/**
 * 轻量瞬时提示的状态管理：在相对定位的容器里挂一个 `<AToast :state="toastState" />`，
 * showToast 后到时自动消隐；连续触发会重置计时，后一条顶掉前一条。
 * 纯展示、不堆叠——同一面板同时只存在一条提示（新提示即最新事实）。
 */
export function useToast(defaultMs = 2600) {
  const state = reactive<ToastState>({ visible: false, text: "", kind: "info" });
  let timer: number | undefined;

  function showToast(text: string, kind: ToastKind = "info", ms = defaultMs) {
    state.text = text;
    state.kind = kind;
    state.visible = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.visible = false;
    }, ms);
  }

  return { toastState: state, showToast };
}

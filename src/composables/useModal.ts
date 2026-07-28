import { ref, shallowRef, readonly, type Component } from "vue";

export interface CustomModalRequest<T> {
  title: string;
  component: Component;
  props?: Record<string, unknown>;
  width?: "sm" | "md" | "lg";
}

const visible = ref(false);
const mode = ref<"prompt" | "confirm" | "choice" | "notice" | "custom">("confirm");
const title = ref("");
const message = ref("");
const inputValue = ref("");
const placeholder = ref("");
const confirmLabel = ref("确定");
/** choice 模式的第二动作按钮（如「放弃修改」），confirm/prompt 模式不显示 */
const altLabel = ref("");
const danger = ref(false);
const component = shallowRef<Component | null>(null);
const componentProps = ref<Record<string, unknown>>({});
const width = ref<"sm" | "md" | "lg">("md");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let resolver: ((v: any) => void) | null = null;

export function useModal() {
  /** Show a text-input prompt. Returns the entered string, or null if cancelled. */
  function prompt(
    promptTitle: string,
    promptPlaceholder?: string,
    label?: string,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      resolver = resolve;
      mode.value = "prompt";
      title.value = promptTitle;
      message.value = "";
      inputValue.value = "";
      placeholder.value = promptPlaceholder || "";
      confirmLabel.value = label || "创建";
      danger.value = false;
      visible.value = true;
    });
  }

  /** Show a confirmation dialog. Returns true if confirmed, false if cancelled. */
  function confirm(
    confirmTitle: string,
    confirmMessage: string,
    label?: string,
    isDanger?: boolean,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      resolver = resolve;
      mode.value = "confirm";
      title.value = confirmTitle;
      message.value = confirmMessage;
      inputValue.value = "";
      placeholder.value = "";
      confirmLabel.value = label || "确定";
      danger.value = isDanger || false;
      visible.value = true;
    });
  }

  /**
   * 三选对话框：主动作 / 次动作 / 取消。返回 "confirm" | "alt" | "cancel"。
   * 用于「保存并关闭 / 放弃修改 / 取消」这类不能二值化的抉择。
   */
  function choice(
    choiceTitle: string,
    choiceMessage: string,
    labels: { confirmLabel: string; altLabel: string; danger?: boolean },
  ): Promise<"confirm" | "alt" | "cancel"> {
    return new Promise((resolve) => {
      resolver = resolve;
      mode.value = "choice";
      title.value = choiceTitle;
      message.value = choiceMessage;
      inputValue.value = "";
      placeholder.value = "";
      confirmLabel.value = labels.confirmLabel;
      altLabel.value = labels.altLabel;
      danger.value = labels.danger || false;
      visible.value = true;
    });
  }

  /**
   * 单按钮告知对话框（替代 window.alert）。只有一个"知道了"按钮，
   * 点确定 / 关 overlay / Esc 都 resolve（没有"取消"语义）。返回 void。
   * 用于只能告知、无需用户抉择的场景（如错误提示）。
   */
  function notice(noticeTitle: string, noticeMessage: string, label?: string): Promise<void> {
    return new Promise((resolve) => {
      resolver = resolve;
      mode.value = "notice";
      title.value = noticeTitle;
      message.value = noticeMessage;
      inputValue.value = "";
      placeholder.value = "";
      confirmLabel.value = label || "知道了";
      danger.value = false;
      visible.value = true;
    });
  }

  /**
   * Open a modal that renders an arbitrary Vue component.
   * The component receives props via `props` and must emit `submit(payload)` or `cancel`.
   * Returns the submitted payload (T) or null on cancel.
   */
  function custom<T>(request: CustomModalRequest<T>): Promise<T | null> {
    return new Promise((resolve) => {
      resolver = resolve;
      mode.value = "custom";
      title.value = request.title;
      message.value = "";
      inputValue.value = "";
      placeholder.value = "";
      confirmLabel.value = "确定";
      altLabel.value = "";
      danger.value = false;
      component.value = request.component;
      componentProps.value = request.props ?? {};
      width.value = request.width ?? "md";
      visible.value = true;
    });
  }

  function resolveCustom(payload: unknown) {
    visible.value = false;
    resolver?.(payload);
    resolver = null;
  }

  function submit() {
    if (mode.value === "custom") return;
    visible.value = false;
    if (mode.value === "prompt") {
      resolver?.(inputValue.value.trim() || null);
    } else if (mode.value === "choice") {
      resolver?.("confirm");
    } else if (mode.value === "notice") {
      resolver?.(undefined);
    } else {
      resolver?.(true);
    }
    resolver = null;
  }

  /** choice 模式的次动作 */
  function submitAlt() {
    visible.value = false;
    resolver?.("alt");
    resolver = null;
  }

  function cancel() {
    visible.value = false;
    if (mode.value === "prompt") {
      resolver?.(null);
    } else if (mode.value === "choice") {
      resolver?.("cancel");
    } else if (mode.value === "notice") {
      resolver?.(undefined);
    } else if (mode.value === "custom") {
      resolver?.(null);
    } else {
      resolver?.(false);
    }
    resolver = null;
  }

  return {
    visible: readonly(visible),
    mode: readonly(mode),
    title: readonly(title),
    message: readonly(message),
    inputValue,
    placeholder: readonly(placeholder),
    confirmLabel: readonly(confirmLabel),
    altLabel: readonly(altLabel),
    danger: readonly(danger),
    component,
    componentProps: readonly(componentProps),
    width: readonly(width),
    prompt,
    confirm,
    choice,
    notice,
    custom,
    resolveCustom,
    submit,
    submitAlt,
    cancel,
  };
}

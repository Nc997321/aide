import { ref, readonly } from "vue";

const visible = ref(false);
const mode = ref<"prompt" | "confirm">("confirm");
const title = ref("");
const message = ref("");
const inputValue = ref("");
const placeholder = ref("");
const confirmLabel = ref("确定");
const danger = ref(false);

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

  function submit() {
    visible.value = false;
    if (mode.value === "prompt") {
      resolver?.(inputValue.value.trim() || null);
    } else {
      resolver?.(true);
    }
    resolver = null;
  }

  function cancel() {
    visible.value = false;
    if (mode.value === "prompt") {
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
    danger: readonly(danger),
    prompt,
    confirm,
    submit,
    cancel,
  };
}

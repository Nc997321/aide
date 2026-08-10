import { ref } from "vue";
import { useSettings } from "./useSettings";

/** 引导步骤。done 为终态——advance 到 done 触发 complete()。 */
export type Step = "welcome" | "workspace" | "login" | "model" | "done";

const ORDER: Step[] = ["welcome", "workspace", "login", "model", "done"];

// 模块级单例：整个 app 共享同一份向导可见性与当前步状态。
const visible = ref(false);
const step = ref<Step>("welcome");

export function useOnboarding() {
  const { settings, update } = useSettings();

  /** 首启动门控入口：仅未 onboarded 时弹向导（老用户不弹）。停在 welcome。 */
  function open() {
    if (settings.onboarded) return;
    step.value = "welcome";
    visible.value = true;
  }

  /** 上下文兜底/再入口：直达指定步，无视 onboarded 守卫。 */
  function openAt(s: Step) {
    step.value = s;
    visible.value = true;
  }

  /** 推进到下一步；到 done 触发 complete()。skip() 同义（跳过当前步 = 推进）。 */
  function advance() {
    const i = ORDER.indexOf(step.value);
    if (i < ORDER.length - 1) step.value = ORDER[i + 1];
    if (step.value === "done") {
      // complete() 同步部分先隐藏，再异步落盘 onboarded=true
      void complete();
    }
  }

  function back() {
    const i = ORDER.indexOf(step.value);
    if (i > 0 && step.value !== "done") step.value = ORDER[i - 1];
  }

  function skip() {
    advance();
  }

  /** 完成：同步隐藏向导，再异步持久化 onboarded=true（落盘失败也不影响本次体验）。 */
  async function complete() {
    visible.value = false;
    await update({ onboarded: true });
  }

  /** "跳过整个引导"：直接 complete（不推进其余步骤）。 */
  function skipAll() {
    void complete();
  }

  return { visible, step, open, openAt, advance, back, skip, skipAll, complete };
}
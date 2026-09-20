// 面板宽度的**DOM 绑定**：读当前档的宽度 → 写 CSS 变量；拖动 → clamp 后写回。
//
// 为什么宽度真相不在这里：同一个右栏有两档宽度（窄工具 tab 340 / 浏览器宽档 ≈窗口一半），
// 值要跨 tab 往返记住、还要随窗口 resize 收敛——那是**面板状态**，主人是 useRightPanel。
// 本模块因此只认三个输入（cssVar / direction / source），档位与上下限由 source 提供。
import { getCurrentScope, onScopeDispose, ref, watchEffect } from "vue";

/** 某档的宽度规则。`initial` / `max` 允许是函数：宽档要看当前窗口宽度现算。 */
export interface WidthLimits {
  initial: number | (() => number);
  min: number;
  max: number | (() => number);
}

/** 宽度来源：档位名、各档边界、已记的值。实现方是面板状态的主人。 */
export interface WidthSource {
  /** 当前生效的档位名（**响应式读取**——切档时本模块的 watchEffect 会自动重跑）。 */
  active(): string;
  limits(name: string): WidthLimits;
  /** 某档已记的宽度；0 = 没记过，用 initial。 */
  get(name: string): number;
  /** 写回某档宽度（拖动过程中每次移动都写，切档往返才不会丢）。 */
  set(name: string, px: number): void;
}

/** 单档宽度源：给没有档位需求的地方（如左侧栏）用，内部自带一个 ref 记值。 */
export function staticWidthSource(limits: { initial: number; min: number; max: number }): WidthSource {
  const px = ref(0);
  return {
    active: () => "default",
    limits: () => limits,
    get: () => px.value,
    set: (_name, value) => {
      px.value = value;
    },
  };
}

export interface ResizableOptions {
  cssVar: string;
  direction: "left" | "right";
  source: WidthSource;
}

export function useResizable(options: ResizableOptions) {
  const isDragging = ref(false);

  /** 该档的实际边界：max < min（窗口过窄）时按 min 收——宁可压破聊天底线，也不把面板压到不可用。 */
  function boundsOf(name: string): { min: number; max: number } {
    const limits = options.source.limits(name);
    const max = typeof limits.max === "function" ? limits.max() : limits.max;
    return { min: limits.min, max: Math.max(limits.min, max) };
  }

  function currentPx(name: string): number {
    const limits = options.source.limits(name);
    const remembered = options.source.get(name);
    const raw =
      remembered > 0
        ? remembered
        : typeof limits.initial === "function"
          ? limits.initial()
          : limits.initial;
    const { min, max } = boundsOf(name);
    return Math.max(min, Math.min(max, raw));
  }

  /** 把当前档的宽度落到 CSS 变量。档位变化 / 窗口 resize 时重跑。 */
  function apply() {
    const name = options.source.active();
    document.documentElement.style.setProperty(options.cssVar, `${currentPx(name)}px`);
  }

  function onMousedown(e: MouseEvent) {
    isDragging.value = true;
    const startX = e.clientX;
    const name = options.source.active();
    const startSize = currentPx(name);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const raw = options.direction === "left" ? startSize + delta : startSize - delta;
      const { min, max } = boundsOf(name);
      const px = Math.max(min, Math.min(max, raw));
      document.documentElement.style.setProperty(options.cssVar, `${px}px`);
      options.source.set(name, px);
    };

    const onUp = () => {
      isDragging.value = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // 档位变化（切 tab / 折叠 / 最大化）→ 重新落值；动态上限（宽档看窗口宽度）→ resize 时重新收敛。
  watchEffect(apply);
  window.addEventListener("resize", apply);
  // 组件卸载时摘掉 listener；非组件上下文（单测直调）没有 scope，跳过而不是报警告。
  if (getCurrentScope()) onScopeDispose(() => window.removeEventListener("resize", apply));

  return { onMousedown, isDragging, apply };
}

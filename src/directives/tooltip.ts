import type { Directive, DirectiveBinding } from "vue";

const TOOLTIP_CLASS = "aide-tooltip";
const SHOW_DELAY = 400;
const HIDE_DELAY = 100;
const VIEWPORT_PAD = 8;

interface TooltipState {
  el: HTMLElement;
  tip: HTMLElement | null;
  showTimer: ReturnType<typeof setTimeout> | null;
  hideTimer: ReturnType<typeof setTimeout> | null;
  text: string;
  onEnter: (e: MouseEvent) => void;
  onLeave: () => void;
  onDown: () => void;
}

const stateMap = new WeakMap<HTMLElement, TooltipState>();

/** 在鼠标附近放一枚主题化提示（`.aide-tooltip`），挨着视口边缘时收进来、下方放不下就翻到上方。 */
function showTip(text: string, clientX: number, clientY: number): HTMLElement {
  const tip = document.createElement("div");
  tip.className = TOOLTIP_CLASS;
  tip.textContent = text;
  document.body.appendChild(tip);

  // Position after paint so we can measure
  requestAnimationFrame(() => {
    if (!tip.isConnected) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = clientX;
    let y = clientY + 18;

    // Clamp horizontal
    if (x + rect.width + VIEWPORT_PAD > vw) {
      x = vw - rect.width - VIEWPORT_PAD;
    }
    if (x < VIEWPORT_PAD) x = VIEWPORT_PAD;

    // Flip above cursor if no room below
    if (y + rect.height + VIEWPORT_PAD > vh) {
      y = clientY - rect.height - 8;
    }

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add("visible");
  });
  return tip;
}

function createTip(state: TooltipState, e: MouseEvent) {
  if (!state.text) return;
  removeTip(state);
  state.tip = showTip(state.text, e.clientX, e.clientY);
}

function removeTip(state: TooltipState) {
  if (state.tip) {
    state.tip.remove();
    state.tip = null;
  }
}

function clearTimers(state: TooltipState) {
  if (state.showTimer) {
    clearTimeout(state.showTimer);
    state.showTimer = null;
  }
  if (state.hideTimer) {
    clearTimeout(state.hideTimer);
    state.hideTimer = null;
  }
}

function setup(el: HTMLElement, text: string) {
  // Remove native title to avoid double tooltip
  el.removeAttribute("title");
  // 全局 title 接管（installTitleTooltips）见到它就让路：祖先的 title 不该叠在它的提示上
  el.dataset.aideTooltip = "";

  const state: TooltipState = {
    el,
    tip: null,
    showTimer: null,
    hideTimer: null,
    text,
    onEnter(e: MouseEvent) {
      clearTimers(state);
      state.showTimer = setTimeout(() => createTip(state, e), SHOW_DELAY);
    },
    onLeave() {
      clearTimers(state);
      state.hideTimer = setTimeout(() => removeTip(state), HIDE_DELAY);
    },
    onDown() {
      clearTimers(state);
      removeTip(state);
    },
  };

  el.addEventListener("mouseenter", state.onEnter);
  el.addEventListener("mouseleave", state.onLeave);
  el.addEventListener("mousedown", state.onDown);
  stateMap.set(el, state);
}

function teardown(el: HTMLElement) {
  const state = stateMap.get(el);
  if (!state) return;
  clearTimers(state);
  removeTip(state);
  el.removeEventListener("mouseenter", state.onEnter);
  el.removeEventListener("mouseleave", state.onLeave);
  el.removeEventListener("mousedown", state.onDown);
  delete el.dataset.aideTooltip;
  stateMap.delete(el);
}

export const vTooltip: Directive<HTMLElement, string> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<string>) {
    if (binding.value) setup(el, binding.value);
  },

  updated(el: HTMLElement, binding: DirectiveBinding<string>) {
    const state = stateMap.get(el);
    if (state) {
      state.text = binding.value || "";
    } else if (binding.value) {
      setup(el, binding.value);
    }
  },

  unmounted(el: HTMLElement) {
    teardown(el);
  },
};

/**
 * 把全应用的原生 `title` 提示换成主题化的 `.aide-tooltip`（与 v-tooltip 同一外观）。
 *
 * 为什么是全局委托而不是逐处改成 v-tooltip：原生 title 散在几十个组件里，还有运行时才
 * 出现的（知识库渲染出的链接、第三方组件），逐处替换永远改不完，新写的又会漏。这里在
 * 悬停时接管：
 *  - 鼠标进入带 title 的元素 → 暂存 title 并从 DOM 摘掉（原生提示就不会弹），延时后显示主题提示；
 *  - 离开 → 还回 title。平时 DOM 里的 title 原样在，读屏与测试断言不受影响；
 *  - 悬停期间框架重写了 title（响应式更新）→ 以新值为准，提示文字跟着换；
 *  - 挂了 v-tooltip 的元素（`data-aide-tooltip`）优先，祖先的 title 不再叠上去。
 *
 * 返回卸载函数（测试用；应用里装一次、不卸）。
 */
export function installTitleTooltips(doc: Document = document): () => void {
  let host: Element | null = null;
  let stash = "";
  let tip: HTMLElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;
  let lastX = 0;
  let lastY = 0;

  const hide = () => {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    tip?.remove();
    tip = null;
  };

  const release = () => {
    hide();
    observer?.disconnect();
    observer = null;
    if (host) {
      // 悬停期间框架可能已写回新 title——那是更新的值，不覆盖
      if (!host.hasAttribute("title") && stash) host.setAttribute("title", stash);
      host = null;
      stash = "";
    }
  };

  const capture = (el: Element) => {
    host = el;
    stash = el.getAttribute("title") ?? "";
    el.removeAttribute("title");
    observer = new MutationObserver(() => {
      const next = el.getAttribute("title");
      if (next === null) return; // 我们自己摘掉的那一下
      stash = next;
      el.removeAttribute("title");
      if (!tip) return;
      if (next) tip.textContent = next;
      else hide();
    });
    observer.observe(el, { attributes: true, attributeFilter: ["title"] });
    showTimer = setTimeout(() => {
      showTimer = null;
      if (host === el && el.isConnected && stash) tip = showTip(stash, lastX, lastY);
    }, SHOW_DELAY);
  };

  const onOver = (e: MouseEvent) => {
    lastX = e.clientX;
    lastY = e.clientY;
    const target = e.target instanceof Element ? e.target : null;
    const titled = target?.closest("[title]") ?? null;
    // 还在当前元素里，且没有更近的带 title 子元素 → 什么都不变
    if (host && host.isConnected && target && host.contains(target) && (!titled || !host.contains(titled))) return;
    release();
    if (!titled || !titled.getAttribute("title")) return;
    const managed = target?.closest("[data-aide-tooltip]");
    if (managed && titled.contains(managed)) return; // v-tooltip 离鼠标更近，让给它
    capture(titled);
  };

  const onOut = (e: MouseEvent) => {
    if (!e.relatedTarget) release(); // 鼠标离开窗口
  };
  const onMove = (e: MouseEvent) => {
    lastX = e.clientX;
    lastY = e.clientY;
  };

  doc.addEventListener("mouseover", onOver, true);
  doc.addEventListener("mouseout", onOut, true);
  doc.addEventListener("mousemove", onMove, true);
  doc.addEventListener("mousedown", hide, true);
  doc.addEventListener("wheel", hide, { capture: true, passive: true });
  doc.addEventListener("keydown", hide, true);
  window.addEventListener("blur", release);

  return () => {
    release();
    doc.removeEventListener("mouseover", onOver, true);
    doc.removeEventListener("mouseout", onOut, true);
    doc.removeEventListener("mousemove", onMove, true);
    doc.removeEventListener("mousedown", hide, true);
    doc.removeEventListener("wheel", hide, true);
    doc.removeEventListener("keydown", hide, true);
    window.removeEventListener("blur", release);
  };
}

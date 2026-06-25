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

function createTip(state: TooltipState, e: MouseEvent) {
  if (!state.text) return;
  removeTip(state);

  const tip = document.createElement("div");
  tip.className = TOOLTIP_CLASS;
  tip.textContent = state.text;
  document.body.appendChild(tip);
  state.tip = tip;

  // Position after paint so we can measure
  requestAnimationFrame(() => {
    if (!state.tip) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = e.clientX;
    let y = e.clientY + 18;

    // Clamp horizontal
    if (x + rect.width + VIEWPORT_PAD > vw) {
      x = vw - rect.width - VIEWPORT_PAD;
    }
    if (x < VIEWPORT_PAD) x = VIEWPORT_PAD;

    // Flip above cursor if no room below
    if (y + rect.height + VIEWPORT_PAD > vh) {
      y = e.clientY - rect.height - 8;
    }

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.classList.add("visible");
  });
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

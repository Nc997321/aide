import { ref } from "vue";
import {
  nextThinkingTip,
  slotTip,
  type TipFeature,
  type TipSlot,
  type TipState,
  type UsageTip,
} from "@/components/ChatPanel/usageTips";

/**
 * 使用小提示的计数状态（模块级单例，各分屏/输入框共用一份）。文案与选择规则在
 * components/ChatPanel/usageTips.ts，这里只管「看过几次 / 用过什么」的记账与持久化。
 *
 * 落 localStorage：这是逐台机器的「教过没」记账，丢了顶多再教一遍，不值得进 Host
 * 设置（且 GUI 换连 WSL/SSH Host 时用户还是同一个人，不该重教）。读写一律 try/catch
 * ——私密窗口/存储被禁时退化成只在本次运行内计数。
 */
const STORAGE_KEY = "aide.usageTips.v1";

function load(): TipState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { shown: {}, used: [] };
    const v = JSON.parse(raw) as Partial<TipState>;
    return {
      shown: v.shown && typeof v.shown === "object" ? { ...v.shown } : {},
      used: Array.isArray(v.used) ? [...v.used] : [],
    };
  } catch {
    return { shown: {}, used: [] };
  }
}

const state = ref<TipState>(load());

function save() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state.value));
  } catch { /* 存不下就只在本次运行内生效 */ }
}

/** 一条提示出场了一次（调用方负责「一次」的粒度：一次轮播 / 一次忙碌期 / 一次菜单打开）。 */
function markShown(id: string) {
  state.value = { ...state.value, shown: { ...state.value.shown, [id]: (state.value.shown[id] ?? 0) + 1 } };
  save();
}

/** 用户点了「知道了」：这条直接退役。 */
function dismiss(id: string) {
  state.value = { ...state.value, shown: { ...state.value.shown, [id]: Number.MAX_SAFE_INTEGER } };
  save();
}

/** 用户用过某功能 → 讲它的提示全部退役。 */
function markUsed(feature: TipFeature) {
  if (state.value.used.includes(feature)) return;
  state.value = { ...state.value, used: [...state.value.used, feature] };
  save();
}

export function useUsageTips() {
  return {
    state,
    markShown,
    markUsed,
    dismiss,
    /** 某时机此刻该说的那条（响应式：在 computed 里调用会跟着计数变化）。 */
    slotTip: (slot: TipSlot): UsageTip | null => slotTip(slot, state.value),
    nextThinkingTip: (excludeId: string | null = null): UsageTip | null => nextThinkingTip(state.value, excludeId),
  };
}

/** 测试用：清空计数并从存储重读。 */
export function __resetUsageTipsForTest() {
  state.value = load();
}

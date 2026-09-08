import { computed, inject, provide, ref, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { sessionIdentityStore } from "./store";
import type { ModelOption } from "../../../types/chat";

/**
 * L2b 会话身份视图（**每个面板一份**）。
 *
 * 只回答一件事：**这个面板正在看哪条会话**，并把仓库（L2a）里那条会话的身份
 * 投影成下拉/选中值。它不持有任何跨面板共享的数据。
 *
 * 拆分动机：`currentSid` / `pendingDraft` 此前和会话数据一起放在模块级单例里，
 * 而分屏布局下多个面板同时挂载（`App.vue` 的 PaneLayout 用 v-show 保活），
 * 谁最后切面板谁就改全局 → 所有面板的下拉都跟着最后一个 currentSid 走，
 * 在 A 面板选模型还会写进 B 会话的 binding。每面板一份之后这些都不再可能。
 *
 * 依赖红线：view → store。store 不反向依赖 view。
 */

export interface SessionIdentityView {
  /** 本面板正在看的会话 id；null = 空白面板（未创建会话）。 */
  currentSid: Ref<string | null>;
  /** 本面板的生效供应商 / 模型 / 下拉选项 / 门控基线（全部按 currentSid 投影）。 */
  effectiveProvider: ComputedRef<string>;
  effectiveModel: ComputedRef<string>;
  displayModels: ComputedRef<ModelOption[]>;
  lastProvider: ComputedRef<string | null>;
  /** 切到某条会话：置 currentSid + 恢复身份。返回 false = 期间又切走了，
   *  调用方应放弃后续赋值（异步交错的唯一守卫点）。 */
  focusSession(sid: string): Promise<boolean>;
  /** 面板空出（无会话 / pending 会话）：清 currentSid。 */
  clearCurrent(): void;
  /** 定名搬迁（tempId → realId）：只把 currentSid 跟到 realId，不重读盘。 */
  adoptSid(sid: string): void;
  /** 用户手选模型：有 sid 写仓库草稿；空白面板写本面板的草稿（无 sid 可绑）。 */
  setUserChoice(model: string): void;
}

/** 新建一份视图（工厂）。面板根组件经 provideSessionIdentityView 提供，
 *  子组件经 useSessionIdentityView 取用；测试可直连本工厂。 */
export function createSessionIdentityView(): SessionIdentityView {
  const currentSid = ref<string | null>(null);
  /** 空白面板（无会话）时用户手选的模型——不绑 sid（会话还没创建），
   *  首条发送后落到 pending 会话。null = 未选（不用空串表达）。 */
  const pendingDraft = ref<string | null>(null);
  /** 单调递增：focusSession 的异步返回用它判断自己是否还是"最新一次"切换。 */
  let resolveSeq = 0;

  const effectiveProvider = computed<string>(() =>
    sessionIdentityStore.effectiveProviderOf(currentSid.value),
  );

  const displayModels = computed<ModelOption[]>(() => {
    const sid = currentSid.value;
    // 空白面板/新建 pending（currentSid null）用全局 activeProvider 列表——下拉要能选模型
    return sid ? sessionIdentityStore.displayModelsOf(sid) : sessionIdentityStore.activeProviderModels();
  });

  const effectiveModel = computed<string>(() => {
    const sid = currentSid.value;
    if (!sid) {
      // 空白面板：pendingDraft（须在全局列表里）> 列表首项
      const list = sessionIdentityStore.activeProviderModels();
      if (pendingDraft.value && list.some((m) => m.value === pendingDraft.value)) return pendingDraft.value;
      return list[0]?.value ?? "";
    }
    return sessionIdentityStore.effectiveModelOf(sid);
  });

  const lastProvider = computed<string | null>(() =>
    sessionIdentityStore.lastProviderOf(currentSid.value),
  );

  async function focusSession(sid: string): Promise<boolean> {
    const seq = ++resolveSeq;
    currentSid.value = sid;
    await sessionIdentityStore.resolve(sid);
    return seq === resolveSeq;
  }

  function clearCurrent(): void {
    currentSid.value = null;
  }

  function adoptSid(sid: string): void {
    currentSid.value = sid;
  }

  function setUserChoice(model: string): void {
    const sid = currentSid.value;
    if (!sid) {
      pendingDraft.value = model || null;
      return;
    }
    sessionIdentityStore.setUserChoice(sid, model);
  }

  return {
    currentSid,
    effectiveProvider,
    effectiveModel,
    displayModels,
    lastProvider,
    focusSession,
    clearCurrent,
    adoptSid,
    setUserChoice,
  };
}

const VIEW_KEY: InjectionKey<SessionIdentityView> = Symbol("aide.sessionIdentityView");

/** 面板根组件（ChatPanel）调用：创建本面板的视图并提供给子树。 */
export function provideSessionIdentityView(): SessionIdentityView {
  const view = createSessionIdentityView();
  provide(VIEW_KEY, view);
  return view;
}

/** 子组件（ChatInputBox）调用：取本面板的视图。
 *  没有 provide 时（组件被独立挂载 / 单测）自建一份，保证组件始终可用。 */
export function useSessionIdentityView(): SessionIdentityView {
  return inject(VIEW_KEY, createSessionIdentityView, true);
}

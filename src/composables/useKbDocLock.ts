// 知识库文档编辑锁的状态机（桌面端，与 useKnowledgeBase 同范式）。
//
// 单独抽成 composable 而不是塞进 KbDocumentView 的原因：
//  1. 锁的生命周期跨越「取锁 → 心跳续租 → 失去/释放」三个阶段，与视图渲染无关，
//     塞组件里会让模板逻辑和定时器管理搅在一起；
//  2. API 以参数注入（不直接 import kbClient），状态机可以脱离网络单测——
//     心跳续租、迟到的旧持有人心跳、锁丢失这类时序行为恰恰是最值得测的部分。
//
// 心跳节奏：30s 一跳，服务端 KB_LOCK_TTL_SECONDS 默认 300s（api/mod.rs 的路由注释
// 也写明了前端要按 TTL 间隔打心跳）——10 轮容错，网络抖动不至于误判失锁。
import { computed, getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import type { KbLockView } from "@/components/KnowledgeBase/kbClient";

/** 注入的锁 API。生产环境传 kb 的三个方法；测试传 mock。 */
export interface KbLockApi {
  acquire(id: string): Promise<KbLockView>;
  heartbeat(id: string): Promise<{ renewed: boolean }>;
  release(id: string): Promise<{ released: boolean }>;
}

export type KbLockPhase = "idle" | "acquiring" | "held" | "conflict" | "lost";

export interface KbLockState {
  phase: KbLockPhase;
  /** phase=conflict 时的持锁人昵称，提示「正被 X 编辑中」。 */
  holderName: string | null;
}

export interface KbDocLock {
  state: Ref<KbLockState>;
  held: Ref<boolean>;
  lost: Ref<boolean>;
  /** 进入编辑（取锁）。拿到锁返回 true；被别人持有返回 false（state 落 conflict）。 */
  enter: (docId: string) => Promise<boolean>;
  /** 退出编辑（释放锁 + 停心跳）。幂等，未持锁时是空操作。 */
  exit: () => Promise<void>;
  dispose: () => void;
}

const HEARTBEAT_MS = 30_000;

export function useKbDocLock(api: KbLockApi, heartbeatMs = HEARTBEAT_MS): KbDocLock {
  const state = ref<KbLockState>({ phase: "idle", holderName: null });

  const held = computed(() => state.value.phase === "held");
  const lost = computed(() => state.value.phase === "lost");

  let timer: ReturnType<typeof setInterval> | null = null;
  let docId: string | null = null;

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => void tick(), heartbeatMs);
  }

  async function tick(): Promise<void> {
    // docId 为空 = 已退出编辑，只是定时器还没来得及清（tick 在 await 中被排队）
    if (!docId || state.value.phase !== "held") return;
    try {
      const r = await api.heartbeat(docId);
      if (!r.renewed) {
        // 锁已经不在自己手上（TTL 过期被别人取走）。
        // 后端文档写明：此时必须立刻告知用户，不能假装还在编辑。
        stopTimer();
        docId = null;
        state.value = { phase: "lost", holderName: null };
        return;
      }
    } catch {
      // 心跳网络失败（服务重启 / 断网）：跳过这一轮继续等。
      // 不主动判失锁——误报「失去锁」打断的是正在打字的人；
      // 迟报的代价由保存接口兜底（PUT 会再查一次锁，冲突返回 409），
      // 真丢了锁也会在 TTL 后被服务端回收，不会死锁。
    }
  }

  async function enter(id: string): Promise<boolean> {
    if (docId === id && state.value.phase === "held") return true;
    await exit();

    docId = id;
    state.value = { phase: "acquiring", holderName: null };
    try {
      const view = await api.acquire(id);
      if (view.held) {
        state.value = { phase: "held", holderName: null };
        startTimer();
        return true;
      }
      // 没拿到锁：conflict 态不算占用，docId 清空让 exit() 不去释放别人的锁
      docId = null;
      state.value = {
        phase: "conflict",
        holderName: view.holder?.displayName ?? "其他成员",
      };
      return false;
    } catch (e) {
      // 网络失败 / 403 等：复位到 idle 让用户可以重试。
      // 错误本身抛给调用方显示（KbDocumentView 会把它写进 error 提示）。
      docId = null;
      state.value = { phase: "idle", holderName: null };
      throw e;
    }
  }

  async function exit(): Promise<void> {
    const id = docId;
    stopTimer();
    docId = null;
    state.value = { phase: "idle", holderName: null };
    if (!id) return;
    try {
      await api.release(id);
    } catch {
      // 释放失败（服务已停 / 网络断）：TTL 到期后服务端会回收，这里不用硬撑
    }
  }

  function dispose(): void {
    stopTimer();
    void exit();
  }

  // 在组件作用域内使用时自动清理；脱离组件（单测）直接调用则跳过
  if (getCurrentScope()) onScopeDispose(dispose);

  return { state, held, lost, enter, exit, dispose };
}

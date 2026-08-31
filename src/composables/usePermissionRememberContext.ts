// 「允许并记住」弹窗上下文：跟随真实权限请求拉取规则快照，显式三态 +
// 代际号竞态守卫 + 持久化（现拉最新规则库 → 语义过滤 → 批量写入）。
//
// 从 ChatPanel 旧三件套（rememberScope/rememberView/rememberWsRoot + async
// watch）收口而来，修三个根源缺陷：
//  ① 新请求首帧继承上一请求的 ready 快照（旧 watch 首个 await 前未复位，
//    预览行先按旧快照渲染再抖动收缩）→ 现在 watch 入口**同步**置 loading；
//  ② async watch 无竞态守卫（请求 A 慢 B 快时 A 的结果晚到覆盖 B）→ 现在
//    每次请求 ++seq，过期 await 结果一律丢弃（仿 useGotoDefinition 的
//    requestSeq 惯例）；
//  ③ 落盘去重按形状精确匹配拦不住语义冗余、且用挂起期快照察觉不到弹窗
//    挂起期间规则库的变动 → 现在 persistRemember **总是现拉**最新规则库再
//    filterRememberableDrafts 语义过滤。
//
// 刻意不做的两件事（注释即边界）：
//  - 不 watch workspacePath：它是会话级 prop（弹窗所属会话自己的工作区，
//    不随活动工作区变化），挂起期间不变；每次拉取/落盘开始时读取一次并
//    钉住（pinnedWs），watch 它反而会为旧请求拉新工作区的规则。
//  - 不订阅 permissions-changed 做挂起期刷新：点击时现拉已消灭写侧陈旧
//    风险，预览侧与落盘的瞬时偏差仅展示层问题（P2）。

import { ref, watch } from "vue";
import type { Ref } from "vue";
import { permissionsApi as defaultApi } from "../api/permissions";
import type {
  PermissionScope,
  PermissionRule,
  PermissionRuleDraft,
  PermissionSettingsView,
} from "../types/permissions";
import { filterRememberableDrafts } from "../utils/permissionRuleDerivation";

/** 快照拉取 + 批量写入的最小 api 面（测试注入桩件用）。 */
type RememberApi = Pick<typeof defaultApi, "get" | "createMany">;

/** 弹窗「允许并记住」上下文（PermissionDialog 的 rememberContext prop）：
 *  - loading：快照未就绪 / 无挂起请求（后者弹窗以 permission=null 渲染空态，
 *    本状态不产生 UI）→ 预览区占位行、记住按钮不渲染；
 *  - ready：快照就绪。scope=null 表示无可持久化作用域（local/user 皆不可写），
 *    同样不显示记住 UI；
 *  - failed：拉取失败 → 不显示记住 UI，普通允许不受影响。 */
export type RememberContextState =
  | { status: "loading" }
  | { status: "ready"; rules: PermissionRule[]; scope: PermissionScope | null }
  | { status: "failed" };

/** persistRemember 的回执（不抛异常——调用方据此分派 toast 文案）。 */
export type RememberPersistResult =
  | { outcome: "persisted"; scope: PermissionScope; count: number }
  /** 现有规则已语义覆盖全部 draft，未写入（预览侧同步过滤后正常不会出现）。 */
  | { outcome: "all-covered" }
  /** 现拉视图无可编辑作用域（弹窗挂起期间作用域变得不可写），未写入。 */
  | { outcome: "no-editable-scope" }
  /** 现拉/写入失败：fail-closed 跳过持久化，调用方仍放行本次。 */
  | { outcome: "failed"; error: string };

export interface UsePermissionRememberContext {
  state: Ref<RememberContextState>;
  persistRemember: (target: {
    scope: PermissionScope;
    rules: PermissionRuleDraft[];
  }) => Promise<RememberPersistResult>;
}

/** 就绪视图中可持久化的作用域：项目本地优先，不可写回退用户全局，皆不可写
 *  返回 null（弹窗据此不显示记住 UI）。语义自 ChatPanel 旧 watch 迁入。 */
function resolveRememberScope(view: PermissionSettingsView): PermissionScope | null {
  const local = view.scopes.find((s) => s.scope === "local");
  const user = view.scopes.find((s) => s.scope === "user");
  return local?.editable ? "local" : user?.editable ? "user" : null;
}

/** scope 在该视图中是否可写。 */
function isEditable(view: PermissionSettingsView, scope: PermissionScope): boolean {
  return view.scopes.some((s) => s.scope === scope && s.editable);
}

export function usePermissionRememberContext(opts: {
  /** 弹窗所显**真实**权限请求 id（sendConfirm 合成请求不算——它不该触发快照
   *  拉取）；null = 无挂起请求。 */
  requestId: () => string | null;
  /** 弹窗所属会话工作区；每次拉取/落盘开始时读取一次并钉住。 */
  workspacePath: () => string | undefined;
  api?: RememberApi;
}): UsePermissionRememberContext {
  const api = opts.api ?? defaultApi;
  const state = ref<RememberContextState>({ status: "loading" });
  // 代际号 + 钉住的工作区：非响应式（不进 state——它们是拉取的簿记，不是 UI 状态）。
  let seq = 0;
  let pinnedWs: string | undefined;

  watch(
    opts.requestId,
    async (id) => {
      pinnedWs = opts.workspacePath();
      const mySeq = ++seq; // 作废一切在途结果（含上一请求尚未返回的 get）
      // 同步复位 loading：watch flush 先于组件重渲染，上一请求的 ready 快照
      // 不得带进新请求首帧（旧实现「先全量后收缩」闪烁的根因）。
      state.value = { status: "loading" };
      if (!id) return;
      try {
        const view = await api.get(pinnedWs);
        if (mySeq !== seq) return; // 过期请求（更早发起、更晚返回）→ 丢弃
        state.value = {
          status: "ready",
          rules: view.rules,
          scope: resolveRememberScope(view),
        };
      } catch {
        if (mySeq !== seq) return;
        state.value = { status: "failed" };
      }
    },
    { immediate: true },
  );

  async function persistRemember(target: {
    scope: PermissionScope;
    rules: PermissionRuleDraft[];
  }): Promise<RememberPersistResult> {
    try {
      // 总是现拉最新规则库：不用挂起期快照——弹窗挂起期间规则库可能被改
      // （设置面板/队列上一条的写入），陈旧快照会让语义过滤漏判、写入冗余。
      const view = await api.get(pinnedWs);
      // 弹窗回传的 scope 仅作偏好：现拉视图里已不可写则按新视图回退。
      const scope = isEditable(view, target.scope)
        ? target.scope
        : resolveRememberScope(view);
      if (!scope) return { outcome: "no-editable-scope" };
      const fresh = filterRememberableDrafts(target.rules, view.rules);
      if (fresh.length === 0) return { outcome: "all-covered" };
      await api.createMany(scope, fresh, pinnedWs);
      return { outcome: "persisted", scope, count: fresh.length };
    } catch (e) {
      // fail-closed：现拉/写入失败跳过持久化，本次仍放行（调用方 toast 提示）。
      return { outcome: "failed", error: String((e as Error)?.message ?? e) };
    }
  }

  return { state, persistRemember };
}
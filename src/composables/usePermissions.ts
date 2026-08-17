import { reactive, ref, readonly } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { permissionsApi as defaultApi } from "../api/permissions";
import type {
  PermissionScope,
  PermissionRule,
  PermissionRuleDraft,
  PermissionSettingsView,
  PermissionExplanationView,
  ScopeAvailability,
} from "../types/permissions";

export interface PermissionDraft {
  scope: PermissionScope;
  rule: PermissionRuleDraft;
  /** Non-null when editing an existing rule; null when creating a new one. */
  editingId: string | null;
}

function emptyDraft(scope: PermissionScope): PermissionDraft {
  return {
    scope,
    rule: { effect: "ask", tool: "", matcher: { kind: "tool" } },
    editingId: null,
  };
}

// 模块级全局 listener 单例：Rust 侧每次权限写成功广播 `permissions-changed`
//（带新 revision）。面板 v-show 常驻挂载、只在挂载/切工作区时 load，外部入口
//（如 ChatPanel 的「允许并记住」createMany）写入后靠这个事件触发重拉。
// revision 比较跳过自己写入后的回环（applyView 已更新，payload 不大于本地）。
type ExternalRefetcher = { refetch: (revision: number) => void };
let extRefetcher: ExternalRefetcher | null = null;
let extListenerPromise: Promise<UnlistenFn> | null = null;

function ensureExternalListener(): void {
  if (extListenerPromise) return;
  extListenerPromise = listen<number>("permissions-changed", (e) => {
    extRefetcher?.refetch(e.payload);
  }).catch(() => {
    extListenerPromise = null; // 注册失败（如测试环境无 Tauri）可重试
    return (() => {}) as UnlistenFn;
  });
}

export function usePermissions(api = defaultApi) {
  const rules = ref<PermissionRule[]>([]);
  /** 最近一次 load 的工作区——外部变更事件重拉时复用（不依赖调用方再传参）。 */
  let currentProject: string | undefined;
  const revision = ref(0);
  const scopes = ref<ScopeAvailability[]>([]);
  const lastSavedRevision = ref(0);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const draft = reactive<PermissionDraft>(emptyDraft("user"));

  function beginCreate(scope: PermissionScope) {
    Object.assign(draft, emptyDraft(scope));
  }

  function beginEdit(rule: PermissionRule) {
    draft.scope = rule.scope;
    draft.rule = {
      effect: rule.effect,
      tool: rule.tool,
      matcher: rule.matcher,
    };
    draft.editingId = rule.id;
  }

  function resetDraft() {
    Object.assign(draft, emptyDraft("user"));
  }

  function applyView(view: PermissionSettingsView) {
    rules.value = view.rules;
    revision.value = view.revision;
    scopes.value = view.scopes;
  }

  async function load(project?: string): Promise<void> {
    currentProject = project ?? currentProject;
    error.value = null;
    try {
      const view = await api.get(project ?? currentProject);
      applyView(view);
      lastSavedRevision.value = view.revision;
    } catch (e) {
      error.value = String(e);
      throw e;
    }
  }

  async function saveDraft(project?: string): Promise<void> {
    error.value = null;
    saving.value = true;
    try {
      let view: PermissionSettingsView;
      if (draft.editingId !== null) {
        view = project
          ? await api.update(draft.scope, draft.editingId, draft.rule, project)
          : await api.update(draft.scope, draft.editingId, draft.rule);
      } else {
        view = project
          ? await api.create(draft.scope, draft.rule, project)
          : await api.create(draft.scope, draft.rule);
      }
      applyView(view);
      lastSavedRevision.value = view.revision;
      resetDraft();
    } catch (e) {
      error.value = String(e);
      // Keep draft unchanged, keep existing list, re-throw so the UI can toast.
      throw e;
    } finally {
      saving.value = false;
    }
  }

  async function deleteRule(id: string, project?: string): Promise<void> {
    error.value = null;
    saving.value = true;
    try {
      // Use the rule's own scope, not draft.scope — the rule being deleted may
      // sit in a different scope than the draft currently being edited.
      const rule = rules.value.find((r) => r.id === id);
      const scope = rule?.scope ?? draft.scope;
      const view = project
        ? await api.remove(scope, id, project)
        : await api.remove(scope, id);
      applyView(view);
      lastSavedRevision.value = view.revision;
    } catch (e) {
      error.value = String(e);
      throw e;
    } finally {
      saving.value = false;
    }
  }

  async function explain(
    tool: string,
    input: unknown,
  ): Promise<PermissionExplanationView> {
    error.value = null;
    try {
      return await api.explain(tool, input);
    } catch (e) {
      error.value = String(e);
      throw e;
    }
  }

  // 注册为外部变更的刷新目标（单面板场景只有一个实例，后注册覆盖先注册无害）。
  extRefetcher = {
    // 参数名避开 `revision`——遮蔽实例 ref 后 `revision.value` 会读到 undefined。
    refetch: (payload) => {
      if (payload > revision.value) {
        void load().catch(() => {
          /* 刷新失败静默：下一次事件/操作会再触发 */
        });
      }
    },
  };
  ensureExternalListener();

  return {
    /** Reactive state */
    rules: readonly(rules),
    revision: readonly(revision),
    scopes: readonly(scopes),
    lastSavedRevision: readonly(lastSavedRevision),
    saving: readonly(saving),
    error: readonly(error),
    draft,

    /** Draft management */
    beginCreate,
    beginEdit,
    resetDraft,

    /** Async operations */
    load,
    saveDraft,
    deleteRule,
    explain,
  };
}

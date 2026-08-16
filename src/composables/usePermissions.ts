import { reactive, ref, readonly } from "vue";
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

export function usePermissions(api = defaultApi) {
  const rules = ref<PermissionRule[]>([]);
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
    error.value = null;
    try {
      const view = await api.get(project);
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

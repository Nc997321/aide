import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  PermissionScope,
  PermissionRuleDraft,
  PermissionSettingsView,
  PermissionExplanationView,
} from "../types/permissions";

export const permissionsApi = {
  get(invoke = tauriInvoke): Promise<PermissionSettingsView> {
    return invoke("get_permission_settings");
  },

  create(
    scope: PermissionScope,
    rule: PermissionRuleDraft,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return invoke("create_permission_rule", { scope, rule });
  },

  update(
    scope: PermissionScope,
    id: string,
    rule: PermissionRuleDraft,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return invoke("update_permission_rule", { scope, id, rule });
  },

  remove(
    scope: PermissionScope,
    id: string,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return invoke("delete_permission_rule", { scope, id });
  },

  explain(
    tool: string,
    input: unknown,
    invoke = tauriInvoke,
  ): Promise<PermissionExplanationView> {
    return invoke("explain_permission_decision", {
      invocation: { tool, input },
    });
  },
};

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  PermissionScope,
  PermissionRuleDraft,
  PermissionSettingsView,
  PermissionExplanationView,
} from "../types/permissions";

export const permissionsApi = {
  /** `project` = 显式工作区根（「允许并记住」把 scope 可用性/去重钉在弹窗所属
   *  会话的工作区上，避免切工作区后按当前工作区解析）；缺省 = Rust 侧当前活动工作区。 */
  get(project?: string, invoke = tauriInvoke): Promise<PermissionSettingsView> {
    return project
      ? invoke("get_permission_settings", { project })
      : invoke("get_permission_settings");
  },

  create(
    scope: PermissionScope,
    rule: PermissionRuleDraft,
    project?: string,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return project
      ? invoke("create_permission_rule", { scope, rule, project })
      : invoke("create_permission_rule", { scope, rule });
  },

  update(
    scope: PermissionScope,
    id: string,
    rule: PermissionRuleDraft,
    project?: string,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return project
      ? invoke("update_permission_rule", { scope, id, rule, project })
      : invoke("update_permission_rule", { scope, id, rule });
  },

  remove(
    scope: PermissionScope,
    id: string,
    project?: string,
    invoke = tauriInvoke,
  ): Promise<PermissionSettingsView> {
    return project
      ? invoke("delete_permission_rule", { scope, id, project })
      : invoke("delete_permission_rule", { scope, id });
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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { permissionsApi } from "./permissions";
import type { PermissionScope, PermissionRuleDraft } from "../types/permissions";

describe("permissionsApi", () => {
  const mockInvoke = vi.fn();

  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("get calls invoke with 'get_permission_settings' and no args", async () => {
    mockInvoke.mockResolvedValue({ revision: 1, scopes: [], rules: [] });
    await permissionsApi.get(undefined, mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("get_permission_settings");
  });

  it("get with explicit project passes { project }", async () => {
    mockInvoke.mockResolvedValue({ revision: 1, scopes: [], rules: [] });
    await permissionsApi.get("C:/ws-a", mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("get_permission_settings", {
      project: "C:/ws-a",
    });
  });

  it("create calls invoke with 'create_permission_rule' and { scope, rule }", async () => {
    mockInvoke.mockResolvedValue({ revision: 2, scopes: [], rules: [] });
    const draft: PermissionRuleDraft = {
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
    };
    await permissionsApi.create("project", draft, undefined, mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("create_permission_rule", {
      scope: "project",
      rule: draft,
    });
  });

  it("create with explicit project passes { scope, rule, project }", async () => {
    mockInvoke.mockResolvedValue({ revision: 2, scopes: [], rules: [] });
    const draft: PermissionRuleDraft = {
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
    };
    await permissionsApi.create("local", draft, "C:/ws-a", mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("create_permission_rule", {
      scope: "local",
      rule: draft,
      project: "C:/ws-a",
    });
  });

  it("update calls invoke with 'update_permission_rule' and { scope, id, rule }", async () => {
    mockInvoke.mockResolvedValue({ revision: 3, scopes: [], rules: [] });
    const draft: PermissionRuleDraft = {
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm -rf" },
    };
    await permissionsApi.update("user", "rule-1", draft, mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("update_permission_rule", {
      scope: "user",
      id: "rule-1",
      rule: draft,
    });
  });

  it("remove calls invoke with 'delete_permission_rule' and { scope, id }", async () => {
    mockInvoke.mockResolvedValue({ revision: 4, scopes: [], rules: [] });
    await permissionsApi.remove("local", "rule-42", mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("delete_permission_rule", {
      scope: "local",
      id: "rule-42",
    });
  });

  it("explain calls invoke with 'explain_permission_decision' and { invocation }", async () => {
    mockInvoke.mockResolvedValue({
      finalDecision: "deny",
      winner: null,
      chain: [],
      reason: "no matching rule",
    });
    const input = { command: "rm -rf /" };
    await permissionsApi.explain("Bash", input, mockInvoke);
    expect(mockInvoke).toHaveBeenCalledWith("explain_permission_decision", {
      invocation: { tool: "Bash", input },
    });
  });
});

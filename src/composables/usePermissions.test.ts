import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePermissions } from "./usePermissions";
import type {
  PermissionSettingsView,
} from "../types/permissions";

const SAMPLE_VIEW: PermissionSettingsView = {
  revision: 5,
  scopes: [
    {
      scope: "user",
      editable: true,
      reason: "",
      storagePath: "/home/user/.aide/claude/settings.json",
      description: "对所有工作区生效",
    },
  ],
  rules: [
    {
      id: "r1",
      scope: "user",
      order: 0,
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
      source: { label: "用户设置", readOnly: false },
    },
  ],
};

const UPDATED_VIEW: PermissionSettingsView = {
  revision: 6,
  scopes: SAMPLE_VIEW.scopes,
  rules: [
    ...SAMPLE_VIEW.rules,
    {
      id: "r2",
      scope: "user",
      order: 1,
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm" },
      source: { label: "用户设置", readOnly: false },
    },
  ],
};

function mockApi(overrides: Record<string, any> = {}) {
  return {
    get: vi.fn().mockResolvedValue(SAMPLE_VIEW),
    create: vi.fn().mockResolvedValue(UPDATED_VIEW),
    update: vi.fn().mockResolvedValue(UPDATED_VIEW),
    remove: vi.fn().mockResolvedValue({
      revision: 7,
      scopes: SAMPLE_VIEW.scopes,
      rules: [SAMPLE_VIEW.rules[0]],
    }),
    explain: vi.fn().mockResolvedValue({
      finalDecision: "allow",
      winner: SAMPLE_VIEW.rules[0],
      chain: [],
      reason: "matched rule r1",
    }),
    ...overrides,
  };
}

describe("usePermissions", () => {
  beforeEach(() => {
    // Reset state between tests by creating fresh composable each time
  });

  it("load populates rules, revision, scopes and bumps lastSavedRevision", async () => {
    const api = mockApi();
    const p = usePermissions(api);
    expect(p.rules.value).toHaveLength(0);
    expect(p.revision.value).toBe(0);
    expect(p.lastSavedRevision.value).toBe(0);

    await p.load();

    expect(p.rules.value).toHaveLength(1);
    expect(p.revision.value).toBe(5);
    expect(p.lastSavedRevision.value).toBe(5);
    expect(p.scopes.value).toHaveLength(1);
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("successful saveDraft (create) replaces rules/revision and bumps lastSavedRevision", async () => {
    const api = mockApi();
    const p = usePermissions(api);
    await p.load();

    p.beginCreate("user");
    p.draft.rule = {
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm" },
    };

    await p.saveDraft();

    expect(p.rules.value).toHaveLength(2);
    expect(p.revision.value).toBe(6);
    expect(p.lastSavedRevision.value).toBe(6);
    expect(p.draft.editingId).toBeNull(); // reset after save
    expect(api.create).toHaveBeenCalledOnce();
  });

  it("successful saveDraft (update) calls api.update and bumps lastSavedRevision", async () => {
    const api = mockApi();
    const p = usePermissions(api);
    await p.load();

    p.beginEdit(SAMPLE_VIEW.rules[0]);
    p.draft.rule.effect = "deny";

    await p.saveDraft();

    expect(p.rules.value).toHaveLength(2);
    expect(p.revision.value).toBe(6);
    expect(p.lastSavedRevision.value).toBe(6);
    expect(p.draft.editingId).toBeNull();
    expect(api.update).toHaveBeenCalledWith("user", "r1", {
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
    });
  });

  it("edited draft is preserved when save fails", async () => {
    const api = mockApi({
      create: vi.fn().mockRejectedValue(new Error("disk locked")),
    });
    const p = usePermissions(api);
    await p.load();

    p.beginCreate("user");
    p.draft.rule = {
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm" },
    };
    const draftBefore = { ...p.draft };

    await expect(p.saveDraft()).rejects.toThrow("disk locked");

    // Draft unchanged
    expect(p.draft.editingId).toBe(draftBefore.editingId);
    expect(p.draft.rule.effect).toBe("deny");
    // Rules and revision unchanged
    expect(p.rules.value).toHaveLength(1);
    expect(p.revision.value).toBe(5);
    expect(p.lastSavedRevision.value).toBe(5);
    // Error is set
    expect(p.error.value).toBe("Error: disk locked");
  });

  it("deleteRule calls api.remove and updates state", async () => {
    const api = mockApi();
    const p = usePermissions(api);
    await p.load();

    await p.deleteRule("r1");

    expect(api.remove).toHaveBeenCalledWith("user", "r1");
    expect(p.rules.value).toHaveLength(1);
    expect(p.revision.value).toBe(7);
  });

  it("explain returns the explanation view", async () => {
    const api = mockApi();
    const p = usePermissions(api);

    const result = await p.explain("Bash", { command: "pnpm test" });

    expect(result.finalDecision).toBe("allow");
    expect(result.winner?.id).toBe("r1");
    expect(api.explain).toHaveBeenCalledWith("Bash", { command: "pnpm test" });
  });

  it("beginCreate sets up a fresh draft with the given scope", () => {
    const p = usePermissions(mockApi());
    p.beginCreate("project");
    expect(p.draft.scope).toBe("project");
    expect(p.draft.editingId).toBeNull();
    expect(p.draft.rule.effect).toBe("ask");
    expect(p.draft.rule.tool).toBe("");
  });

  it("beginEdit populates draft from an existing rule", () => {
    const p = usePermissions(mockApi());
    p.beginEdit(SAMPLE_VIEW.rules[0]);
    expect(p.draft.scope).toBe("user");
    expect(p.draft.editingId).toBe("r1");
    expect(p.draft.rule.effect).toBe("allow");
    expect(p.draft.rule.tool).toBe("Bash");
  });

  it("resetDraft clears the draft back to defaults", () => {
    const p = usePermissions(mockApi());
    p.beginCreate("local");
    p.draft.rule.effect = "deny";
    p.resetDraft();
    expect(p.draft.scope).toBe("user");
    expect(p.draft.editingId).toBeNull();
    expect(p.draft.rule.effect).toBe("ask");
  });
});

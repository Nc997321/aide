// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PermissionsSettings from "../PermissionsSettings.vue";
import type { PermissionSettingsView, PermissionExplanationView } from "@/types/permissions";

const { api, customMock, confirmMock, showToastMock } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    explain: vi.fn(),
  },
  customMock: vi.fn(),
  confirmMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("@/api/permissions", () => ({ permissionsApi: api }));
vi.mock("@/composables/useModal", () => ({
  useModal: () => ({
    custom: customMock,
    confirm: confirmMock,
    cancel: vi.fn(),
    visible: { value: false },
    mode: { value: "" },
    title: { value: "" },
    message: { value: "" },
  }),
}));
vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ showToast: showToastMock, toastState: { current: { text: "", kind: "info", id: 0 } } }),
}));

const VIEW: PermissionSettingsView = {
  revision: 3,
  scopes: [
    { scope: "user", editable: true, reason: "", storagePath: "/home/.aide/settings.json", description: "对所有工作区生效" },
    { scope: "project", editable: false, reason: "尚未打开项目", storagePath: null, description: "适合提交到 Git" },
    { scope: "local", editable: false, reason: "尚未打开项目", storagePath: null, description: "仅本机" },
    { scope: "managed", editable: false, reason: "受管策略只读", storagePath: "/managed/settings.json", description: "管理员配置" },
  ],
  rules: [
    { id: "r1", scope: "user", order: 0, effect: "allow", tool: "Bash", matcher: { kind: "bash", mode: "prefix", value: "pnpm test" }, source: { label: "user", readOnly: false } },
  ],
};

function mountSettings() {
  return mount(PermissionsSettings, { global: { stubs: { ThemedSelect: true } } });
}

describe("PermissionsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(VIEW);
    customMock.mockResolvedValue(null);
    confirmMock.mockResolvedValue(false);
    api.create.mockResolvedValue(VIEW);
    api.update.mockResolvedValue(VIEW);
    api.remove.mockResolvedValue(VIEW);
    api.explain.mockResolvedValue({
      finalDecision: "deny",
      winner: null,
      chain: [{ ruleId: "l", scope: "local", matched: true, specificity: 3, status: "overridden_by_deny" }],
      reason: "Denied by managed rule",
    } as PermissionExplanationView);
  });

  it("loads and renders scope tabs + the user rule card", async () => {
    const w = mountSettings();
    await flushPromises();
    expect(api.get).toHaveBeenCalledOnce();
    expect(w.findAll(".scope-tab").map((x) => x.text())).toEqual(["用户全局", "项目共享", "项目本地", "受管策略"]);
    expect(w.text()).toContain("pnpm test");
    // managed scope selected → no add button; user (default) → add button visible
    expect(w.find(".primary-btn").exists()).toBe(true);
  });

  it("create: custom modal resolves with a draft → api.create → success toast", async () => {
    const draft = { effect: "allow" as const, tool: "Bash", matcher: { kind: "bash", mode: "prefix", value: "pnpm lint" } };
    customMock.mockResolvedValueOnce(draft);
    const w = mountSettings();
    await flushPromises();
    await w.get(".primary-btn").trigger("click");
    await flushPromises();
    expect(customMock).toHaveBeenCalledOnce();
    expect(api.create).toHaveBeenCalledWith("user", draft);
    expect(showToastMock).toHaveBeenCalledWith("权限规则已保存", "success");
  });

  it("delete: confirm resolves true → api.remove → success toast", async () => {
    confirmMock.mockResolvedValue(true);
    const w = mountSettings();
    await flushPromises();
    await w.get('[data-action="delete-rule"]').trigger("click");
    await flushPromises();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(api.remove).toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith("规则已删除", "success");
  });

  it("save failure: danger toast + the editor modal re-opens with the same draft", async () => {
    const draft = { effect: "allow" as const, tool: "Bash", matcher: { kind: "bash", mode: "prefix", value: "pnpm lint" } };
    customMock.mockResolvedValueOnce(draft).mockResolvedValueOnce(null); // re-open → cancel
    api.create.mockRejectedValueOnce(new Error("disk locked"));
    const w = mountSettings();
    await flushPromises();
    await w.get(".primary-btn").trigger("click");
    await flushPromises();
    expect(api.create).toHaveBeenCalledOnce();
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("保存失败"), "danger");
    // re-opened for retry (custom called twice: initial + retry)
    expect(customMock).toHaveBeenCalledTimes(2);
  });

  it("explanation panel renders an overridden_by_deny chain entry", async () => {
    const w = mountSettings();
    await flushPromises();
    // DecisionPanel: set the command input + click 解释
    const input = w.find(".decision-panel .text-input");
    await input.setValue("rm -rf build");
    const explainBtn = w.findAll(".decision-panel .btn-secondary").slice(-1)[0] ?? w.findAll(".decision-panel button").pop()!;
    await explainBtn.trigger("click");
    await flushPromises();
    expect(api.explain).toHaveBeenCalled();
    expect(w.text()).toContain("被拒绝规则覆盖");
  });
});
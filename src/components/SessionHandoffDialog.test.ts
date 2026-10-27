// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
const { prepare, start } = vi.hoisted(() => ({ prepare: vi.fn(), start: vi.fn() }));
vi.mock("@aide/sdk/api", () => ({ api: { prepareSessionHandoff: prepare, continueSessionHandoff: start } }));
import Dialog from "./SessionHandoffDialog.vue";
import { useProviders } from "@aide/sdk/composables/useProviders";
import { useSessionProviders } from "@aide/sdk/composables/useSessionProviders";
import { useSessionState } from "@aide/sdk/composables/useSessionState";
import { sessionIdentityStore } from "@aide/sdk/composables/sessionIdentity";
import type { ProviderConfig } from "@aide/sdk/types";
const providers = useProviders();
const target = { provider: "ollama", model: "qwen3", effort: "low" };
beforeEach(() => {
  prepare.mockReset(); start.mockReset();
  providers.allProviders.value = [
    { id: "ollama", name: "Ollama", knownModels: ["qwen3"], effortLevel: "LOW" },
    { id: "other", name: "Other", knownModels: ["deepseek"], effortLevel: "MAX" },
  ] as ProviderConfig[];
  providers.activeProviderId.value = "ollama";
  useSessionProviders().setProvider("source", "cpa");
  useSessionState().setSessionState("source", "stopped");
  sessionIdentityStore.setUserChoice("source", "gpt-6.1-sol");
});
const props = { sourceId: "source", sourceTitle: "原任务" };
describe("交接预览", () => {
  it("生成后先预览，用户修改的版本才交给新会话", async () => {
    prepare.mockResolvedValue({ id: "draft", summary: "原摘要" });
    start.mockResolvedValue({ childId: "new" });
    const w = mount(Dialog, { props });
    await w.get("textarea").setValue("接着做测试");
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect(prepare).toHaveBeenCalledWith("source", "接着做测试", target);
    expect(start).not.toHaveBeenCalled();
    await w.get("textarea").setValue("补充关键约束");
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect(start).toHaveBeenCalledWith("draft", "补充关键约束", target);
    expect(w.emitted("submit")?.[0]).toEqual([{ childId: "new" }]);
  });
  it("旧会话关闭并切换供应商后，摘要和新会话不带 CPA 的 GPT；预览期间再次切换也生效", async () => {
    prepare.mockResolvedValue({ id: "draft", summary: "旧任务上下文" });
    start.mockResolvedValue({ childId: "new" });
    const w = mount(Dialog, { props });
    expect(w.text()).toContain("Ollama / qwen3");
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect(prepare).toHaveBeenCalledWith("source", "", target);
    providers.activeProviderId.value = "other";
    await flushPromises();
    expect(w.text()).toContain("Other / deepseek");
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect(start).toHaveBeenCalledWith("draft", "旧任务上下文", { provider: "other", model: "deepseek", effort: "max" });
  });
  it("生成失败不会建新会话，创建失败保留用户修改供重试", async () => {
    prepare.mockRejectedValueOnce("供应商不可用");
    const w = mount(Dialog, { props });
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain("供应商不可用");
    expect(start).not.toHaveBeenCalled();
    prepare.mockResolvedValueOnce({ id: "draft", summary: "摘要" });
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    await w.get("textarea").setValue("编辑后");
    start.mockRejectedValueOnce("启动失败");
    await w.get("footer button:last-child").trigger("click");
    await flushPromises();
    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("编辑后");
    expect(w.emitted("submit")).toBeUndefined();
  });
});

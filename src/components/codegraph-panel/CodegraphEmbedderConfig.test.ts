// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import CodegraphEmbedderConfig from "./CodegraphEmbedderConfig.vue";

const { setCodegraphEmbedderMock } = vi.hoisted(() => ({
  setCodegraphEmbedderMock: vi.fn(async () => undefined),
}));

const settings = reactive({
  codegraphEmbedder: {
    backend: "http",
    baseUrl: "http://localhost:11434",
    apiKeyConfigured: true,
    model: "nomic-embed-text",
    format: "ollama",
    dim: 768,
    scoreThreshold: 0.4 as number | undefined,
  },
});

function resetEmbedder() {
  settings.codegraphEmbedder = {
    backend: "http",
    baseUrl: "http://localhost:11434",
    apiKeyConfigured: true,
    model: "nomic-embed-text",
    format: "ollama",
    dim: 768,
    scoreThreshold: 0.4,
  };
}

vi.mock("../../composables/useSettings", () => ({
  useSettings: () => ({
    settings,
    setCodegraphEmbedder: setCodegraphEmbedderMock,
  }),
}));

beforeEach(() => {
  resetEmbedder();
  vi.clearAllMocks();
});

/** 最近一次整块回写的 payload（改任一字段 → 完整 codegraphEmbedder 回写）。 */
function lastPayload(): { scoreThreshold?: number } & Record<string, unknown> {
  return setCodegraphEmbedderMock.mock.calls.at(-1)![0];
}

describe("CodegraphEmbedderConfig", () => {
  it("改服务地址 → 整块回写完整配置（其余字段原值随行）", async () => {
    const w = mount(CodegraphEmbedderConfig);
    const urlInput = w.find<HTMLInputElement>("input[placeholder*='11434']");
    await urlInput.setValue("http://remote:11434");
    await flushPromises();
    expect(lastPayload()).toEqual(
      expect.objectContaining({
        baseUrl: "http://remote:11434",
        model: "nomic-embed-text",
        dim: 768,
        format: "ollama",
      }),
    );
  });

  it("阈值空输入 = undefined（保留「后端自动」语义，不被 coerce 成 0）", async () => {
    const w = mount(CodegraphEmbedderConfig);
    const threshold = w.find<HTMLInputElement>("input[placeholder='自动']");
    (threshold.element as HTMLInputElement).value = "";
    await threshold.trigger("input");
    await flushPromises();
    expect(lastPayload().scoreThreshold).toBeUndefined();
  });

  it("阈值负数归 undefined（watch 归一）", async () => {
    const w = mount(CodegraphEmbedderConfig);
    const threshold = w.find<HTMLInputElement>("input[placeholder='自动']");
    (threshold.element as HTMLInputElement).value = "-0.2";
    await threshold.trigger("input");
    await flushPromises();
    expect(lastPayload().scoreThreshold).toBeUndefined();
  });

  it("输入 API Key 后「替换」= set mutation + 清空输入框", async () => {
    const w = mount(CodegraphEmbedderConfig);
    const keyInput = w.find<HTMLInputElement>("input[type='password']");
    await keyInput.setValue("sk-new-key");
    const replaceBtn = w.findAll("button").find((b) => b.text() === "替换")!;
    await replaceBtn.trigger("click");
    await flushPromises();
    expect(setCodegraphEmbedderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({}),
      { action: "set", value: "sk-new-key" },
    );
    expect(w.find<HTMLInputElement>("input[type='password']").element.value).toBe("");
  });

  it("「清除」= clear mutation（apiKeyConfigured 态才出现）", async () => {
    const w = mount(CodegraphEmbedderConfig);
    const clearBtn = w.findAll("button").find((b) => b.text() === "清除")!;
    await clearBtn.trigger("click");
    await flushPromises();
    expect(setCodegraphEmbedderMock).toHaveBeenLastCalledWith(
      expect.objectContaining({}),
      { action: "clear" },
    );
  });

  it("fastembed 模式不渲染 http 专属字段（服务地址 / Key / 格式）", () => {
    settings.codegraphEmbedder = { ...resetEmbedder(), backend: "fastembed" } as never;
    const w = mount(CodegraphEmbedderConfig);
    expect(w.find<HTMLInputElement>("input[placeholder*='11434']").exists()).toBe(false);
    expect(w.find<HTMLInputElement>("input[type='password']").exists()).toBe(false);
  });
});
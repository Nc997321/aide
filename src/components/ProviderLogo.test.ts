// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ProviderLogo from "./ProviderLogo.vue";
import { providerLogo } from "@aide/sdk/utils/providerLogos";

describe("ProviderLogo", () => {
  it("火山方舟保留商标的四层路径与蓝青配色", () => {
    const logo = providerLogo("volcengine");
    const w = mount(ProviderLogo, { props: { kind: "volcengine" } });
    expect(w.findAll("path").map(p => ({ path: p.attributes("d"), color: p.attributes("fill") }))).toEqual(logo?.paths);
    expect(w.findAll("path")).toHaveLength(4);
    w.unmount();
  });
  it("CPA 中转使用 OpenAI 图标，不再显示存量字母 C", () => {
    const logo = providerLogo("cpa_gpt");
    expect(logo).toBeDefined();

    const w = mount(ProviderLogo, { props: { kind: "cpa_gpt", text: "C" } });
    expect(w.find("svg.aide-provider-logo").exists()).toBe(true);
    expect(w.find("path").attributes("d")).toBe(logo?.path);
    expect(w.find(".aide-iconchar").exists()).toBe(false);
    w.unmount();
  });

  it("OpenAI 单色图标使用主题前景色，适配深浅主题", () => {
    const w = mount(ProviderLogo, { props: { kind: "cpa_gpt", text: "C" } });
    expect(w.find("svg").classes()).toContain("aide-provider-logo--mono");
    expect(w.find("path").attributes("fill")).toBe("currentColor");
    w.unmount();
  });

  it("品牌图标沿用调用方指定的尺寸", () => {
    const w = mount(ProviderLogo, { props: { kind: "cpa_gpt", text: "C", size: 24 } });
    expect(w.find("svg").attributes()).toMatchObject({ width: "24", height: "24" });
    w.unmount();
  });

  it.each(["custom", "unknown_provider"])("%s 保留自定义字母回退", (kind) => {
    const w = mount(ProviderLogo, { props: { kind, text: "X" } });
    expect(w.find("svg.aide-provider-logo").exists()).toBe(false);
    expect(w.find(".aide-iconchar").text()).toBe("X");
    w.unmount();
  });
});

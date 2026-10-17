// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ComposerPlusMenu from "./ComposerPlusMenu.vue";

function open(props: Record<string, unknown>) {
  const w = mount(ComposerPlusMenu, {
    props,
    attachTo: document.body,
    global: { directives: { tooltip: () => {} } },
  });
  return w;
}

describe("ComposerPlusMenu · 新建子会话", () => {
  it("不能派的会话里没有这一项", async () => {
    const w = open({ subsession: null });
    await w.find(".cplus").trigger("click");
    expect(document.body.textContent).not.toContain("新建子会话");
    w.unmount();
  });

  it("能派：显示在跑数，点了发 subsession", async () => {
    const w = open({ subsession: { running: 1, max: 4 } });
    await w.find(".cplus").trigger("click");
    const item = [...document.querySelectorAll<HTMLButtonElement>(".cplus-item")].find((b) =>
      b.textContent?.includes("新建子会话"),
    )!;
    expect(item.textContent).toContain("在跑 1/4");
    item.click();
    expect(w.emitted("pick")?.[0]).toEqual(["subsession"]);
    w.unmount();
  });

  it("满额：置灰，点了不发", async () => {
    const w = open({ subsession: { running: 4, max: 4 } });
    await w.find(".cplus").trigger("click");
    const item = [...document.querySelectorAll<HTMLButtonElement>(".cplus-item")].find((b) =>
      b.textContent?.includes("新建子会话"),
    )!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("4/4 已满");
    item.click();
    expect(w.emitted("pick")).toBeFalsy();
    w.unmount();
  });
});

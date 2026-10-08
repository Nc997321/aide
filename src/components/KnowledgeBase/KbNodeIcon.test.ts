// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import KbNodeIcon from "./KbNodeIcon.vue";

const kindOf = (props: Record<string, unknown>) =>
  mount(KbNodeIcon, { props }).find("svg").attributes("data-kind");

describe("KbNodeIcon", () => {
  it("文件夹", () => expect(kindOf({ folder: true })).toBe("folder"));
  it("text/html（含 charset 参数）画网页图标", () => {
    expect(kindOf({ mime: "text/html" })).toBe("html");
    expect(kindOf({ mime: "text/html; charset=utf-8" })).toBe("html");
  });
  it("markdown / 缺省 mime / 未知 mime 兜底画 markdown，不留白", () => {
    expect(kindOf({ mime: "text/markdown" })).toBe("markdown");
    expect(kindOf({})).toBe("markdown");
    expect(kindOf({ mime: "application/x-weird" })).toBe("markdown");
  });
});

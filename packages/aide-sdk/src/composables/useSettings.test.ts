// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useSettings } from "./useSettings";

describe("useSettings defaults", () => {
  it("onboarded 默认 false（settings 分层：前端 defaults 必须含，否则后端 serde 默认挡死）", () => {
    const { settings } = useSettings();
    expect(settings.onboarded).toBe(false);
  });

  it("codegraphEnabled 不在 AppSettings（开关已下沉工作区级，defaults 不得回流该字段）", () => {
    const { settings } = useSettings();
    expect("codegraphEnabled" in settings).toBe(false);
  });
});
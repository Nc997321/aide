// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useSettings } from "./useSettings";

describe("useSettings defaults", () => {
  it("onboarded 默认 false（settings 分层：前端 defaults 必须含，否则后端 serde 默认挡死）", () => {
    const { settings } = useSettings();
    expect(settings.onboarded).toBe(false);
  });

  it("codegraphEnabled 默认 true（settings 分层：前端 defaults 必须含，否则后端 serde 默认挡死）", () => {
    const { settings } = useSettings();
    expect(settings.codegraphEnabled).toBe(true);
  });
});
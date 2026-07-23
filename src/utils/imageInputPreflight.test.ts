import { describe, expect, it, vi } from "vitest";
import { checkImageInputSupport } from "./imageInputPreflight";

describe("checkImageInputSupport", () => {
  it("blocks only a definitive unsupported probe result", async () => {
    const probe = vi.fn(async () => ({ supported: false as const }));

    await expect(checkImageInputSupport(true, "glm-5.2", probe)).resolves.toBe(false);
    expect(probe).toHaveBeenCalledWith("glm-5.2");
  });

  it("does not probe without an image and lets unknown probe results continue", async () => {
    const probe = vi.fn(async () => ({ supported: null }));

    await expect(checkImageInputSupport(false, undefined, probe)).resolves.toBe(true);
    await expect(checkImageInputSupport(true, undefined, probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenLastCalledWith(undefined);
  });
});

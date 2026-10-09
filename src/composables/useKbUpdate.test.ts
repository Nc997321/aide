// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const kbMock = vi.hoisted(() => ({ updateStatus: vi.fn() }));
vi.mock("@/components/KnowledgeBase/kbClient", async (orig) => {
  const real = await orig<typeof import("@/components/KnowledgeBase/kbClient")>();
  return { ...real, kb: kbMock };
});

import { useKbUpdate } from "./useKbUpdate";
import { KbError } from "@/components/KnowledgeBase/kbClient";

beforeEach(() => {
  kbMock.updateStatus.mockReset();
  localStorage.clear();
});

describe("useKbUpdate", () => {
  it("服务端没有接口（404）→ unsupported；连不上 → null（不判）", async () => {
    const u = useKbUpdate({ baseUrl: () => "http://kb" });
    kbMock.updateStatus.mockRejectedValueOnce(new KbError("not_found", "x", 404));
    await u.refresh();
    expect(u.status.value).toBe("unsupported");
    kbMock.updateStatus.mockRejectedValueOnce(new KbError("network", "x", 0));
    await u.refresh();
    expect(u.status.value).toBeNull();
  });

  it("「检查更新」跳过服务端缓存", async () => {
    const u = useKbUpdate({ baseUrl: () => "http://kb" });
    kbMock.updateStatus.mockResolvedValue({ current: "0.6.0", latest: "0.6.1", repo: null, error: null });
    await u.refresh(true);
    expect(kbMock.updateStatus).toHaveBeenCalledWith(true);
  });

  it("「以后再说」按服务地址记，换一台服务不受影响", async () => {
    kbMock.updateStatus.mockResolvedValue({ current: "0.6.0", latest: "0.6.1", repo: null, error: null });
    const a = useKbUpdate({ baseUrl: () => "http://a" });
    a.dismiss("0.6.1");
    await a.refresh();
    expect(a.dismissedVersion.value).toBe("0.6.1");
    const b = useKbUpdate({ baseUrl: () => "http://b" });
    await b.refresh();
    expect(b.dismissedVersion.value).toBeNull();
  });
});

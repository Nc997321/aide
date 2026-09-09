import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfirmDecision } from "./confirmGate";
import { api } from "../../../api";

/**
 * L3 门控的分支覆盖。判定规则本身在 Rust（`compute_identity_drift`），这里只断言
 * 本层的三件事：两维都相同 → 不弹；任一维漂移 → 弹且把漂移维度与基线原样带出；
 * 判定调用失败 → 放行（不阻塞发送）。
 */

vi.mock("../../../api", () => ({
  api: { sessionIdentityDrift: vi.fn() },
}));

const driftMock = api.sessionIdentityDrift as unknown as ReturnType<typeof vi.fn>;

function stub(over: Partial<Awaited<ReturnType<typeof api.sessionIdentityDrift>>>): void {
  driftMock.mockResolvedValue({
    providerDrift: false,
    modelDrift: false,
    lastProvider: "p-a",
    lastModel: "m-1",
    ...over,
  });
}

beforeEach(() => {
  driftMock.mockReset();
});

describe("buildConfirmDecision（供应商 + 模型两维）", () => {
  it("两维都相同 → null（不弹）", async () => {
    stub({ providerDrift: false, modelDrift: false });
    await expect(buildConfirmDecision("s1", "p-a", "m-1")).resolves.toBeNull();
  });

  it("供应商漂移 → 决策标注 providerDrift", async () => {
    stub({ providerDrift: true, modelDrift: false, lastProvider: "p-a", lastModel: "m-1" });
    await expect(buildConfirmDecision("s1", "p-b", "m-1")).resolves.toEqual({
      effective: "p-b",
      last: "p-a",
      effectiveModel: "m-1",
      lastModel: "m-1",
      providerDrift: true,
      modelDrift: false,
    });
  });

  it("仅模型漂移 → 决策标注 modelDrift（供应商没换）", async () => {
    stub({ providerDrift: false, modelDrift: true, lastProvider: "p-a", lastModel: "m-1" });
    await expect(buildConfirmDecision("s1", "p-a", "m-2")).resolves.toEqual({
      effective: "p-a",
      last: "p-a",
      effectiveModel: "m-2",
      lastModel: "m-1",
      providerDrift: false,
      modelDrift: true,
    });
  });

  it("两维都漂移 → 两个标记都为 true", async () => {
    stub({ providerDrift: true, modelDrift: true, lastProvider: "p-a", lastModel: "m-1" });
    await expect(buildConfirmDecision("s1", "p-b", "m-2")).resolves.toEqual({
      effective: "p-b",
      last: "p-a",
      effectiveModel: "m-2",
      lastModel: "m-1",
      providerDrift: true,
      modelDrift: true,
    });
  });

  it("判定调用失败 → null（门控故障不阻塞发送）", async () => {
    driftMock.mockRejectedValue(new Error("ipc down"));
    await expect(buildConfirmDecision("s1", "p-b", "m-2")).resolves.toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { judge, type ProbeResult, type VariantReport, type VariantSpec } from "./appIsolationVerdict";

const SPECS: VariantSpec[] = [
  { id: "control", label: "对照", control: true },
  { id: "sandbox", label: "沙箱" },
  { id: "sandbox-csp", label: "沙箱+CSP", strictCsp: true },
];

const r = (id: string, kind: ProbeResult["kind"], outcome: ProbeResult["outcome"]): ProbeResult => ({
  id,
  kind,
  outcome,
  detail: "",
});
const report = (...results: ProbeResult[]): VariantReport => ({ origin: "null", results });

const CONTROL_OK = report(r("parent-invoke-canary", "gate", "reachable"));
// Host 侧的执行记录：只有对照组的调用真的跑了。
const RAN = ["control:parent-invoke-canary"];
const SEALED = report(
  r("own-invoke-canary", "gate", "absent"),
  r("parent-invoke-canary", "gate", "blocked"),
  r("network", "net", "blocked"),
);

describe("judge", () => {
  it("对照调得通、被测全拦住 → 通过", () => {
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: SEALED, "sandbox-csp": SEALED }, RAN)).toEqual({
      verdict: "pass",
      reasons: [],
    });
  });

  it("被测 frame 调通任何一条 gate → 失败，并点名是哪条", () => {
    const leaky = report(r("own-invoke-canary", "gate", "reachable"));
    const j = judge(SPECS, { control: CONTROL_OK, sandbox: leaky, "sandbox-csp": SEALED }, RAN);
    expect(j.verdict).toBe("fail");
    expect(j.reasons[0]).toContain("own-invoke-canary");
  });

  it("对照也调不通 → 无结论（探针没牙，不能当通过）", () => {
    const j = judge(SPECS, { control: SEALED, sandbox: SEALED, "sandbox-csp": SEALED }, RAN);
    expect(j.verdict).toBe("inconclusive");
  });

  it("被测页面没加载出来 → 失败（投递方式不可用），不是通过", () => {
    const j = judge(SPECS, { control: CONTROL_OK, sandbox: null, "sandbox-csp": SEALED }, RAN);
    expect(j.verdict).toBe("fail");
    expect(j.reasons[0]).toContain("没加载");
  });

  it("自行联网只在严格 CSP 变体下算失败", () => {
    const online = report(r("parent-invoke-canary", "gate", "blocked"), r("network", "net", "reachable"));
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: online, "sandbox-csp": SEALED }, RAN).verdict).toBe("pass");
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: SEALED, "sandbox-csp": online }, RAN).verdict).toBe("fail");
  });

  it("超时与 info 类结果不影响结论", () => {
    const slow = report(r("own-invoke-canary", "gate", "timeout"), r("local-storage", "info", "reachable"));
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: slow, "sandbox-csp": SEALED }, RAN).verdict).toBe("pass");
  });

  it("frame 超时但 Host 侧有它的执行记录 → 失败（回应送不回子 frame，不代表没执行）", () => {
    const slow = report(r("own-invoke-canary", "gate", "timeout"));
    const j = judge(SPECS, { control: CONTROL_OK, sandbox: SEALED, "sandbox-csp": slow }, [
      ...RAN,
      "sandbox-csp:own-invoke-canary",
    ]);
    expect(j.verdict).toBe("fail");
    expect(j.reasons[0]).toContain("实际执行了");
  });

  it("没取到执行记录 → 无结论", () => {
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: SEALED, "sandbox-csp": SEALED }, null).verdict).toBe(
      "inconclusive",
    );
  });

  it("对照调通了却没有执行记录 → 无结论（记录不可信）", () => {
    expect(judge(SPECS, { control: CONTROL_OK, sandbox: SEALED, "sandbox-csp": SEALED }, []).verdict).toBe(
      "inconclusive",
    );
  });
});

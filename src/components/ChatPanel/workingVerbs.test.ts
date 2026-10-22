import { describe, expect, it } from "vitest";
import { WORKING_VERBS, pickWorkingVerb } from "./workingVerbs";

describe("workingVerbs", () => {
  it("词库不说「思考」，免得和模型的「正在思考…」撞", () => {
    for (const v of WORKING_VERBS) expect(v).not.toMatch(/思|想|考/);
  });

  it("和上一轮的不重复", () => {
    for (const r of [0, 0.5, 0.999999]) {
      const prev = WORKING_VERBS[0];
      expect(pickWorkingVerb(prev, () => r)).not.toBe(prev);
    }
  });

  it("rand 取到边界也落在词库里", () => {
    expect(WORKING_VERBS).toContain(pickWorkingVerb(null, () => 0.9999999999));
  });
});

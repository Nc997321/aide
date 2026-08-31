import { describe, it, expect } from "vitest";
import { planWatchRefresh } from "./fileTreeWatch";

const ROOT = "C:\\proj";

describe("planWatchRefresh", () => {
  it("空 payload → 全量刷新", () => {
    expect(planWatchRefresh([], ROOT, [ROOT])).toEqual({ full: true, dirs: [] });
  });

  it("root 直接受影响 → 全量刷新", () => {
    expect(planWatchRefresh([ROOT], ROOT, [ROOT])).toEqual({ full: true, dirs: [] });
  });

  it("命中已展开目录自身 → 原地刷新该目录（保留原始大小写）", () => {
    const plan = planWatchRefresh(["C:\\proj\\SUB"], ROOT, [ROOT, "C:\\proj\\Sub"]);
    expect(plan).toEqual({ full: false, dirs: ["C:\\proj\\Sub"] });
  });

  it("改动目录未展开、其父已展开 → 刷新父目录（新目录由此冒出来）", () => {
    const plan = planWatchRefresh(["C:\\proj\\src\\newdir"], ROOT, [ROOT, "C:\\proj\\src"]);
    expect(plan).toEqual({ full: false, dirs: ["C:\\proj\\src"] });
  });

  it("改动落在完全折叠区域（父与自身都未展开）→ 忽略", () => {
    // node_modules 内部深层的构建风暴不可见，不得触发任何刷新
    const plan = planWatchRefresh(["C:\\proj\\node_modules\\pkg\\dist"], ROOT, [ROOT]);
    expect(plan).toEqual({ full: false, dirs: [] });
  });

  it("多目录混合：命中的进入 plan（含退化到 root 的父刷新）", () => {
    // src 已展开 → 刷 src；hidden 只到 root 一层可见 → 刷 root
    const plan = planWatchRefresh(
      ["C:\\proj\\src", "C:\\proj\\hidden"],
      ROOT,
      [ROOT, "C:\\proj\\src"],
    );
    expect(plan).toEqual({ full: false, dirs: ["C:\\proj\\src", "C:\\proj"] });
  });

  it("跨根事件（watcher 未重定目标的旧工作区收尾）→ 忽略", () => {
    const plan = planWatchRefresh(["C:\\other\\sub"], ROOT, [ROOT]);
    expect(plan).toEqual({ full: false, dirs: [] });
  });

  it("正斜杠风格归一：树用反斜杠、事件用正斜杠也能命中", () => {
    const plan = planWatchRefresh(["C:/proj/src"], "C:\\proj", ["C:\\proj\\src"]);
    expect(plan).toEqual({ full: false, dirs: ["C:\\proj\\src"] });
  });

  it("子树防穿越：src2 与已展开的 src 只是同前缀，互不影响", () => {
    // src2 未展开、父 = root ∈ 已展开 → 退化为刷 root（新条目从 root 冒出）
    const plan = planWatchRefresh(["C:\\proj\\src2"], ROOT, [ROOT, "C:\\proj\\src"]);
    expect(plan).toEqual({ full: false, dirs: ["C:\\proj"] });
  });
});
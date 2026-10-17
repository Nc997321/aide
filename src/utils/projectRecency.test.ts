import { describe, it, expect } from "vitest";
import { orderByRecency, collapseProjects } from "./projectRecency";

const ps = [
  { key: "a", t: 0 },
  { key: "b", t: 300 },
  { key: "c", t: 0 },
  { key: "d", t: 100 },
  { key: "e", t: 200 },
];
const keys = (l: { key: string }[]) => l.map((p) => p.key);

describe("项目按最近活动排序", () => {
  it("发过会话的按时间倒序在前；没发过的保持原顺序排后面", () => {
    expect(keys(orderByRecency(ps, (p) => p.t))).toEqual(["b", "e", "d", "a", "c"]);
  });

  it("只露前 N 个，其余计入 hidden", () => {
    const r = collapseProjects(orderByRecency(ps, (p) => p.t), 2, () => false);
    expect(keys(r.shown)).toEqual(["b", "e"]);
    expect(r.hidden).toBe(3);
  });

  it("当前项目排在 N 之后也照样露出，位置不变", () => {
    const r = collapseProjects(orderByRecency(ps, (p) => p.t), 2, (p) => p.key === "a");
    expect(keys(r.shown)).toEqual(["b", "e", "a"]);
    expect(r.hidden).toBe(2);
  });
});

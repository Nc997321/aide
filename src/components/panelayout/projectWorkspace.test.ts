// 「工程」模式的默认归属不许落到日常目录上。
//
// 2026-10-11 修：日常目录可切成活动工作区之后，点「工程」会把活动工作区（= 日常）绑给新会话，
// 模式由归属派生 → 又被判回「日常」，表现为「切不到工程」。
import { describe, it, expect } from "vitest";
import { pickProjectWorkspace } from "./projectWorkspace";

const DAILY = { wsKey: "daily-key", wsPath: "/home/u/.aide/workspace" };
const isDaily = (k: string) => k === DAILY.wsKey;
const ws = (key: string, missing = false) => ({ key, name: `/p/${key}`, missing });

describe("pickProjectWorkspace", () => {
  it("活动工作区是普通工程：就用它", () => {
    const active = { wsKey: "a", wsPath: "/p/a" };
    expect(pickProjectWorkspace(active, [ws("b")], isDaily)).toEqual(active);
  });

  it("活动工作区是日常目录：不绑日常，改用列表里第一个可用的工程", () => {
    expect(pickProjectWorkspace(DAILY, [ws("gone", true), ws("b"), ws("c")], isDaily)).toEqual({
      wsKey: "b",
      wsPath: "/p/b",
    });
  });

  it("活动工作区是日常且没有任何工程：不绑（hero 上就地选），绝不回落日常", () => {
    expect(pickProjectWorkspace(DAILY, [], isDaily)).toBeUndefined();
    expect(pickProjectWorkspace(DAILY, [{ key: DAILY.wsKey, name: DAILY.wsPath }], isDaily)).toBeUndefined();
  });

  it("没有活动工作区：同样从列表里挑", () => {
    expect(pickProjectWorkspace(undefined, [ws("b")], isDaily)?.wsKey).toBe("b");
    expect(pickProjectWorkspace(undefined, [], isDaily)).toBeUndefined();
  });
});

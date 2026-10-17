import { describe, expect, it } from "vitest";
import { pickAnswer } from "./answerSlot";

describe("pickAnswer — 作答槽一次一张卡", () => {
  it("什么都没有", () => {
    expect(pickAnswer({ permission: false, permissionCount: 0, lsp: false })).toEqual({ kind: null, total: 0 });
  });

  it("权限与 LSP 询问同时在：只出权限卡，总数算上 LSP", () => {
    expect(pickAnswer({ permission: true, permissionCount: 2, lsp: true })).toEqual({ kind: "permission", total: 3 });
  });

  it("权限清空后 LSP 询问顶上来", () => {
    expect(pickAnswer({ permission: false, permissionCount: 0, lsp: true })).toEqual({ kind: "lsp", total: 1 });
  });

  it("有显示中的权限但计数缺失时至少算 1", () => {
    expect(pickAnswer({ permission: true, permissionCount: 0, lsp: false })).toEqual({ kind: "permission", total: 1 });
  });
});

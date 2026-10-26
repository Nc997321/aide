import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../transport", () => ({ getTransport: () => ({ invoke }) }));
import { api } from "../api";

describe("api.gitClone", () => {
  beforeEach(() => { invoke.mockReset(); });

  it("原样转发当前 Host 的显式克隆参数并返回路径，不登记工作区", async () => {
    invoke.mockResolvedValue("/projects/repo");
    const input = { url: "git@example.com:team/repo.git", parentPath: "/projects", directoryName: "repo" };
    await expect(api.gitClone(input)).resolves.toBe("/projects/repo");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_clone", input);
  });

  it("保留 Host 错误供表单展示", async () => {
    invoke.mockRejectedValue("目标目录已存在，未作任何更改");
    await expect(api.gitClone({ url: "https://example.com/repo.git", parentPath: "/projects", directoryName: "repo" }))
      .rejects.toBe("目标目录已存在，未作任何更改");
  });
});

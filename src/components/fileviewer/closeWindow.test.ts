// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { choiceMock } = vi.hoisted(() => ({ choiceMock: vi.fn() }));

vi.mock("@aide/sdk/api", () => ({
  api: {
    readFileContent: vi.fn(async (path: string) => `content of ${path}`),
    readFileBinary: vi.fn(async () => new ArrayBuffer(0)),
    writeFileContent: vi.fn(async () => undefined),
    lspDidSave: vi.fn(async () => undefined),
    getProjectInfo: vi.fn(async () => ({ root: "C:/proj" })),
    isWorkspaceTrusted: vi.fn(async () => true),
    loadNotifications: vi.fn(async () => []),
    saveNotifications: vi.fn(async () => undefined),
  },
}));
vi.mock("../../composables/useRecent", () => ({
  useRecent: () => ({ recordFile: vi.fn(async () => undefined) }),
}));
vi.mock("../../composables/useModal", () => ({
  useModal: () => ({ choice: choiceMock }),
}));

import { useFileViewer } from "../../composables/useFileViewer";
import { closeOtherWindows, requestCloseWindow } from "./closeWindow";

describe("文件窗口关闭", () => {
  beforeEach(() => {
    useFileViewer().__resetForTest();
    choiceMock.mockReset();
  });

  it("关闭其他：干净窗口直接关，保留被点的那个", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.open("b.ts");
    await v.open("c.ts");
    const keep = v.windows.value[1];
    await closeOtherWindows(keep.id);
    expect(v.windows.value.map((w) => w.id)).toEqual([keep.id]);
    expect(choiceMock).not.toHaveBeenCalled();
  });

  it("关闭其他：有未保存修改的逐个确认，取消即停、该窗口保留", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.open("b.ts");
    await v.open("c.ts");
    const [a, b, c] = v.windows.value;
    a.editContent = "changed";
    choiceMock.mockResolvedValueOnce("cancel");
    await closeOtherWindows(c.id);
    expect(choiceMock).toHaveBeenCalledTimes(1);
    // a 取消 → 停止，b 也还没关
    expect(v.windows.value.map((w) => w.id)).toEqual([a.id, b.id, c.id]);
  });

  it("放弃修改：不保存直接关", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const a = v.windows.value[0];
    a.editContent = "changed";
    choiceMock.mockResolvedValueOnce("alt");
    expect(await requestCloseWindow(a)).toBe(true);
    expect(v.windows.value).toHaveLength(0);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises, DOMWrapper } from "@vue/test-utils";

const { currentMock, targetsMock, openWindowMock, switchWindowMock, cloneMock } = vi.hoisted(() => ({
  currentMock: vi.fn(),
  targetsMock: vi.fn(),
  openWindowMock: vi.fn(),
  switchWindowMock: vi.fn(),
  cloneMock: vi.fn(),
}));

vi.mock("@aide/sdk", () => ({
  hostApi: { current: currentMock, openWindow: openWindowMock, switchWindow: switchWindowMock },
  remoteWorkspaceApi: { targets: targetsMock },
}));

vi.mock("@aide/sdk/api", () => ({ api: { gitClone: cloneMock } }));

import OpenFolderDialog from "./OpenFolderDialog.vue";

const local = { key: "local", label: "本机", os: "linux", home: "/home/u" };
const wsl = { key: "wsl:Debian", label: "WSL: Debian", os: "linux", home: "/home/d" };

async function mountIt(host = local) {
  currentMock.mockResolvedValue(host);
  const w = mount(OpenFolderDialog, {
    props: { visible: true },
    attachTo: document.body,
    global: { stubs: { DirTreePicker: true } },
  });
  await flushPromises();
  return w;
}
// 对话框经 Teleport 挂 body：一律从 document 查
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => q(sel)?.textContent?.trim();
const machineBtn = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".of-machine")).find((b) => b.textContent?.trim() === label)!;
async function click(el: HTMLElement | null) {
  el!.click();
  await flushPromises();
}

beforeEach(() => {
  targetsMock.mockReset().mockResolvedValue({ wsl: ["Debian"], ssh: [] });
  openWindowMock.mockReset().mockResolvedValue("host-wsl_Debian");
  switchWindowMock.mockReset().mockResolvedValue(undefined);
  cloneMock.mockReset().mockResolvedValue("/projects/repo");
  document.body.innerHTML = "";
});

describe("OpenFolderDialog：别的 Host 的两条路", () => {

  it("选本窗口自己的 Host：只有「打开并切换」，没有「在此窗口中打开」", async () => {
    const w = await mountIt();
    expect(q('[data-testid="of-open-here"]')).toBeNull();
    expect(text('[data-testid="of-open-confirm"]')).toBe("打开并切换");
    w.unmount();
  });

  it("选另一台 Host：并排两个按钮；「在新窗口中打开」开它的窗口", async () => {
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    expect(text('[data-testid="of-open-here"]')).toBe("在此窗口中打开");
    expect(text('[data-testid="of-open-confirm"]')).toBe("在新窗口中打开");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(openWindowMock).toHaveBeenCalledWith("wsl:Debian");
    expect(switchWindowMock).not.toHaveBeenCalled();
    expect(w.emitted("update:visible")?.at(-1)).toEqual([false]);
    w.unmount();
  });

  it("「在此窗口中打开」把本窗口换成它，不另开窗口", async () => {
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    await click(q('[data-testid="of-open-here"]'));
    expect(switchWindowMock).toHaveBeenCalledWith("wsl:Debian");
    expect(openWindowMock).not.toHaveBeenCalled();
    w.unmount();
  });

  it("切换失败如实显示，对话框不关", async () => {
    switchWindowMock.mockRejectedValue("本窗口已经连着这台 Host");
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    await click(q('[data-testid="of-open-here"]'));
    expect(text(".of-error")).toContain("已经连着");
    expect(w.emitted("update:visible")).toBeUndefined();
    w.unmount();
  });

  it("没有主窗口：远程窗口里「本机」也是一台别的 Host，可换回", async () => {
    const w = await mountIt(wsl);
    const labels = Array.from(document.body.querySelectorAll(".of-machine")).map((b) => b.textContent?.trim());
    expect(labels).toContain("本机");
    await click(machineBtn("本机"));
    await click(q('[data-testid="of-open-here"]'));
    expect(switchWindowMock).toHaveBeenCalledWith("local");
    w.unmount();
  });
});

const modeBtn = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".of-mode")).find((b) => b.textContent?.trim() === label)!;
const setInput = (selector: string, value: string) => new DOMWrapper(q(selector) as HTMLInputElement).setValue(value);

async function mountClone(host = local) {
  const w = await mountIt(host);
  await click(modeBtn("从 Git 克隆"));
  return w;
}

describe("OpenFolderDialog：从 Git 克隆", () => {
  it.each([local, wsl, { key: "ssh:devbox", label: "SSH: devbox", os: "linux", home: "/home/demo" }])(
    "$label 的目录树直接参与克隆区域 flex 布局，不受 fieldset 匿名盒约束",
    async (host) => {
      const w = await mountClone(host);
      const picker = w.findComponent({ name: "DirTreePicker" }).element;
      expect(picker.parentElement).toBe(q(".of-clone"));
      expect(picker.closest("fieldset")).toBeNull();
      w.unmount();
    },
  );

  it.each([
    ["https://example.com/team/repo.git", "repo"],
    ["git@example.com:team/repo.git", "repo"],
    ["ssh://git@example.com/team/repo.git/", "repo"],
    ["https://example.com/team/%E9%A1%B9%E7%9B%AE.git?ref=main", "项目"],
    ["https://example.com", ""],
  ])("从地址 %s 推断目录名", async (url, name) => {
    const w = await mountClone();
    await setInput('[data-testid="of-git-url"]', url);
    expect((q('[data-testid="of-git-name"]') as HTMLInputElement).value).toBe(name);
    expect(text('[data-testid="of-open-confirm"]')).toBe("克隆并打开");
    w.unmount();
  });

  it("手动改名后，更新地址不覆盖；保存父目录来自当前 Host", async () => {
    const w = await mountClone(wsl);
    await setInput('[data-testid="of-git-url"]', "https://example.com/team/repo.git");
    await setInput('[data-testid="of-git-name"]', "my-project");
    await setInput('[data-testid="of-git-url"]', "git@example.com:team/other.git");
    expect((q('[data-testid="of-git-name"]') as HTMLInputElement).value).toBe("my-project");
    expect(text('[data-testid="of-git-destination"]')).toContain("/home/d/my-project");
    expect(text(".of-hint")).toContain("WSL: Debian");
    w.unmount();
  });

  it("Windows 目标位置按 Host 系统显示，不使用 GUI 所在系统", async () => {
    const w = await mountClone({ ...local, os: "windows", home: "C:\\Projects" });
    await setInput('[data-testid="of-git-url"]', "https://example.com/team/repo.git");
    expect(text('[data-testid="of-git-destination"]')).toContain("C:\\Projects\\repo");
    w.unmount();
  });

  it("校验地址、目录名和父目录，不调用克隆", async () => {
    const w = await mountClone();
    await click(q('[data-testid="of-open-confirm"]'));
    expect(text(".of-error")).toContain("Git 仓库地址");
    await setInput('[data-testid="of-git-url"]', "https://example.com/team/repo.git");
    await setInput('[data-testid="of-git-name"]', "../repo");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(text(".of-error")).toContain("项目目录名");
    await setInput('[data-testid="of-git-name"]', "repo");
    w.findComponent({ name: "DirTreePicker" }).vm.$emit("update:modelValue", "");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(text(".of-error")).toContain("保存父目录");
    expect(cloneMock).not.toHaveBeenCalled();
    expect(w.emitted("confirm")).toBeUndefined();
    w.unmount();
  });

  it("克隆成功切回已有目录，再走 confirm；打开失败后只重试打开", async () => {
    const w = await mountClone();
    await setInput('[data-testid="of-git-url"]', " https://example.com/team/repo.git ");
    w.findComponent({ name: "DirTreePicker" }).vm.$emit("update:modelValue", "/projects");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(cloneMock).toHaveBeenCalledWith({ url: "https://example.com/team/repo.git", parentPath: "/projects", directoryName: "repo" });
    expect(w.emitted("confirm")).toEqual([["/projects/repo"]]);
    expect(q('[data-testid="of-git-url"]')).toBeNull();
    expect(text('[data-testid="of-open-confirm"]')).toBe("打开并切换");
    await w.setProps({ error: "打开目录失败" });
    await click(q('[data-testid="of-open-confirm"]'));
    expect(w.emitted("confirm")).toEqual([["/projects/repo"], ["/projects/repo"]]);
    expect(cloneMock).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it("失败保留输入和错误，不打开工作区", async () => {
    cloneMock.mockRejectedValue("认证失败，请配置 Git 凭据");
    const w = await mountClone();
    await setInput('[data-testid="of-git-url"]', "git@example.com:team/repo.git");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(text(".of-error")).toContain("认证失败");
    expect((q('[data-testid="of-git-url"]') as HTMLInputElement).value).toBe("git@example.com:team/repo.git");
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.emitted("update:visible")).toBeUndefined();
    expect((q('[data-testid="of-open-confirm"]') as HTMLButtonElement).disabled).toBe(false);
    w.unmount();
  });

  it("克隆期间禁止重复提交、关闭和切换 Host/模式", async () => {
    let finish!: (path: string) => void;
    cloneMock.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const w = await mountClone();
    await setInput('[data-testid="of-git-url"]', "https://example.com/team/repo.git");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(text(".of-progress")).toContain("正在克隆");
    expect((q('[data-testid="of-open-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q(".of-clone")?.hasAttribute("inert")).toBe(true);
    expect((q("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((q('[data-testid="of-git-url"]') as HTMLInputElement).matches(":disabled")).toBe(true);
    await click(q('[data-testid="of-open-confirm"]'));
    await click(q(".of-btn.cancel"));
    await click(q(".of-overlay"));
    await click(modeBtn("打开已有目录"));
    await click(machineBtn("WSL: Debian"));
    expect(cloneMock).toHaveBeenCalledTimes(1);
    expect(w.emitted("update:visible")).toBeUndefined();
    expect(q('[data-testid="of-git-url"]')).not.toBeNull();
    expect(openWindowMock).not.toHaveBeenCalled();
    finish("/projects/repo");
    await flushPromises();
    expect(w.emitted("confirm")).toEqual([["/projects/repo"]]);
    w.unmount();
  });

  it("选择其他 Host 仍只开它的窗口，不在本 Host 克隆", async () => {
    const w = await mountClone();
    await setInput('[data-testid="of-git-url"]', "https://example.com/team/repo.git");
    await click(machineBtn("WSL: Debian"));
    expect(q('[data-testid="of-git-url"]')).toBeNull();
    expect(modeBtn("从 Git 克隆")).toBeUndefined();
    await click(q('[data-testid="of-open-confirm"]'));
    expect(openWindowMock).toHaveBeenCalledWith("wsl:Debian");
    expect(cloneMock).not.toHaveBeenCalled();
    w.unmount();
  });
});

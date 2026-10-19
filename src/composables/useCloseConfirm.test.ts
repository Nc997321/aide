// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn(async () => {});
vi.mock("./useWindowControls", () => ({ useWindowControls: () => ({ hide }) }));

const setCloseBehavior = vi.fn(async (_b: string) => {});
const quitApp = vi.fn(async () => {});
vi.mock("@/api", () => ({
  api: { setCloseBehavior: (b: string) => setCloseBehavior(b), quitApp: () => quitApp() },
  listen: vi.fn(async () => () => {}),
}));

let answer: unknown = null;
const custom = vi.fn(async (_req: unknown) => answer);
vi.mock("./useModal", () => ({ useModal: () => ({ custom }) }));
vi.mock("@/components/CloseConfirm.vue", () => ({ default: { name: "CloseConfirm" } }));

import { askAndClose } from "./useCloseConfirm";
import { useSessionState } from "./useSessionState";

beforeEach(() => {
  vi.clearAllMocks();
  answer = null;
});

describe("关闭窗口询问", () => {
  it("取消：什么都不做", async () => {
    await askAndClose();
    expect(custom).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
    expect(setCloseBehavior).not.toHaveBeenCalled();
  });

  it("最小化到托盘：只藏本窗口，不记选择", async () => {
    answer = { action: "tray", remember: false };
    await askAndClose();
    expect(hide).toHaveBeenCalledOnce();
    expect(quitApp).not.toHaveBeenCalled();
    expect(setCloseBehavior).not.toHaveBeenCalled();
  });

  it("退出应用 + 不再询问：先记住再退出", async () => {
    answer = { action: "quit", remember: true };
    await askAndClose();
    expect(setCloseBehavior).toHaveBeenCalledWith("quit");
    expect(quitApp).toHaveBeenCalledOnce();
    expect(hide).not.toHaveBeenCalled();
  });

  it("卡片上点出正在跑的会话数", async () => {
    const s = useSessionState();
    s.setSessionState("a", "running");
    s.setSessionState("b", "attention");
    s.setSessionState("c", "waiting");
    await askAndClose();
    expect((custom.mock.calls[0][0] as { props: { running: number } }).props.running).toBe(2);
  });

  it("连按两次 ×：只弹一张", async () => {
    let release!: (v: unknown) => void;
    custom.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = askAndClose();
    await askAndClose();
    expect(custom).toHaveBeenCalledOnce();
    release(null);
    await first;
  });
});

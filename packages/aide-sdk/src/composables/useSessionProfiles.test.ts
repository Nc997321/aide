import { beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ api: { sessionProfile: read } }));
import { useSessionProfiles } from "./useSessionProfiles";
beforeEach(() => { useSessionProfiles().clearAll(); read.mockReset(); });
describe("会话能力档案缓存", () => {
  it("重开会话从 Host 恢复纯聊天，重复请求共用一次读取", async () => {
    read.mockResolvedValue("chat");
    const p = useSessionProfiles();
    await Promise.all([p.ensure("saved"), p.ensure("saved")]);
    expect(p.profiles.saved).toBe("chat");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("迟到的档案读取不能覆盖广播，定名后能力跟随真实 id", async () => {
    let finish!: (value: string) => void;
    read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const p = useSessionProfiles();
    const pending = p.ensure("temp");
    p.set("temp", "chat");
    finish("assistant");
    await pending;
    p.migrate("temp", "real");
    expect(p.profiles.real).toBe("chat");
    expect(p.profiles.temp).toBeUndefined();
  });
});

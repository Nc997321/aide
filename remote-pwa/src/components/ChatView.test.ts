import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setTransport, type AideTransport } from "@aide/sdk";
import { __resetForTest } from "@aide/sdk/chat";
import ChatView from "./ChatView.vue";

/**
 * ChatView 适配层测试：真 store（包内 useChatSession）+ 假传输。
 * 重逻辑（事件归一/分页/回收）在包内已测，这里只验适配行为：
 * 历史装载、发送参数、权限条应答、中断、新建会话的 id 生命周期。
 */

interface InvokeCall {
  command: string;
  params: Record<string, unknown>;
}

class MockTransport implements AideTransport {
  calls: InvokeCall[] = [];
  chatEventCb: ((e: { payload: Record<string, unknown> }) => void) | null = null;
  reconnectedCb: (() => void) | null = null;
  /** 按命令名定制应答；缺省返回 null */
  handlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  invoke<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, params: params ?? {} });
    const h = this.handlers.get(command);
    // JSON 边界对齐：真实传输回来时也是 unknown→门面声明类型
    return Promise.resolve((h ? h(params ?? {}) : null) as T);
  }

  listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
    if (event === "chat-event") {
      this.chatEventCb = cb as (e: { payload: Record<string, unknown> }) => void;
    }
    return Promise.resolve(() => {});
  }

  emitChatEvent(payload: Record<string, unknown>): void {
    this.chatEventCb?.({ payload });
  }

  onReconnected(cb: () => void): void {
    this.reconnectedCb = cb;
  }
  offReconnected(_cb: () => void): void {}
}

function mountChat(overrides?: {
  session?: { id: string | null; name: string };
  workspaceKey?: string | null;
  workspacePath?: string | null;
  /** 额外的命令应答（hydrate 在挂载时同步发起，必须在 mount 前就位） */
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>;
}) {
  const transport = new MockTransport();
  // 默认应答：历史空 + 凭证存在（过 canSendOrPrompt 门）
  transport.handlers.set("load_messages", () => ({ messages: [], nextOffsetBytes: 0, endOffsetBytes: 0 }));
  transport.handlers.set("claude_credentials_exist", () => true);
  for (const [k, v] of Object.entries(overrides?.handlers ?? {})) {
    transport.handlers.set(k, v);
  }
  setTransport(transport);
  const wrapper = mount(ChatView, {
    props: {
      session: overrides?.session ?? { id: "s1", name: "测试会话" },
      workspaceKey: overrides?.workspaceKey ?? null,
      workspacePath: overrides?.workspacePath ?? null,
      connState: "authed" as const,
      client: transport,
    },
  });
  return { wrapper, transport };
}

describe("ChatView（共享闭包适配）", () => {
  beforeEach(() => {
    __resetForTest(); // 包内全局单例（store/监听器）逐用例归零
  });

  it("挂载即 hydrate：历史消息经 load_messages 渲染为 markdown", async () => {
    const { wrapper } = mountChat({
      handlers: {
        load_messages: () => ({
          messages: [
            { role: "user", blocks: [{ type: "text", text: "你好" }], timestamp: 1 },
            { role: "assistant", blocks: [{ type: "text", text: "**你好！**" }], timestamp: 2 },
          ],
          nextOffsetBytes: 0,
          endOffsetBytes: 10,
        }),
      },
    });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("你好");
    });
    // markdown 渲染落地（**加粗** → <strong>）
    expect(wrapper.html()).toContain("<strong>你好！</strong>");
  });

  it("发送：本地气泡上屏 + send_message 带工作区路径", async () => {
    const { wrapper, transport } = mountChat({
      workspaceKey: "C--proj",
      workspacePath: "C:/proj",
    });
    await vi.waitFor(() => {
      expect(transport.calls.some((c) => c.command === "load_messages")).toBe(true);
    });
    const textarea = wrapper.find("textarea");
    await textarea.setValue("帮我跑下测试");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      const send = transport.calls.find((c) => c.command === "send_message");
      expect(send).toBeTruthy();
      expect(send?.params["prompt"]).toBe("帮我跑下测试");
      expect(send?.params["workspaceRoot"]).toBe("C:/proj");
    });
    expect(wrapper.text()).toContain("帮我跑下测试"); // 本地气泡
  });

  it("权限请求事件 → 极简条出现 → 允许应答 → permission_response 且条消失", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    transport.emitChatEvent({
      type: "permission_request",
      session_id: "s1",
      id: "perm-1",
      name: "Bash",
      input: { command: "rm -rf dist" },
    });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("Bash");
      expect(wrapper.text()).toContain("rm -rf dist");
    });
    await wrapper.find(".ch-perm-allow").trigger("click");
    await vi.waitFor(() => {
      const resp = transport.calls.find((c) => c.command === "permission_response");
      expect(resp?.params["id"]).toBe("perm-1");
      expect(resp?.params["approved"]).toBe(true);
    });
    await vi.waitFor(() => {
      expect(wrapper.find(".ch-perm").exists()).toBe(false);
    });
  });

  it("生成中显示中断钮，点击发 interrupt_session", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    // isBusy 由发送动作置位（真实时序）：先发出一条
    const textarea = wrapper.find("textarea");
    await textarea.setValue("跑个长任务");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => expect(wrapper.find(".ch-stop").exists()).toBe(true));
    await wrapper.find(".ch-stop").trigger("click");
    await vi.waitFor(() => {
      expect(transport.calls.some((c) => c.command === "interrupt_session")).toBe(true);
    });
  });

  it("新建会话：首发返回临时 sid → emit sessionBound；session_init → emit sessionFinalized", async () => {
    const { wrapper, transport } = mountChat({
      session: { id: null, name: "新会话" },
      workspaceKey: "C--proj",
      workspacePath: "C:/proj",
    });
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    const textarea = wrapper.find("textarea");
    await textarea.setValue("第一句话");
    await textarea.trigger("keydown", { key: "Enter" });

    let tempSid = "";
    await vi.waitFor(() => {
      expect(wrapper.emitted("sessionBound")).toBeTruthy();
      tempSid = (wrapper.emitted("sessionBound")![0] as [string])[0];
      expect(tempSid.length).toBeGreaterThan(0);
    });
    // 发送用的就是这个临时 sid
    const send = transport.calls.find((c) => c.command === "send_message");
    expect(send?.params["sessionId"]).toBe(tempSid);

    // 模拟 App 在 sessionBound 后把临时 id 绑回路由态（生产流程）
    await wrapper.setProps({ session: { id: tempSid, name: "新会话" } });

    // SDK 确认真实 id → 过户事件
    transport.emitChatEvent({ type: "session_init", session_id: tempSid, sdk_session_id: "real-9" });
    await vi.waitFor(() => {
      const fin = wrapper.emitted("sessionFinalized");
      expect(fin).toBeTruthy();
      expect(fin![0]).toEqual([{ tempId: tempSid, realId: "real-9" }]);
    });
  });
});

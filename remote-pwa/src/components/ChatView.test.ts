import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { setTransport, type AideTransport } from "@aide/sdk";
import { __resetForTest } from "@aide/sdk/chat";
import ChatView from "./ChatView.vue";

// canvas/ImageBitmap 在 jsdom 不可用：编码器打桩（编码逻辑自身在 imageEncode.test.ts 验）
vi.mock("../imageEncode", () => ({
  fileToAttachment: vi.fn(async (_file: File) => ({ data: "aGk=", mediaType: "image/png" })),
}));

/**
 * ChatView 适配层测试：真 store（包内 useChatSession）+ 假传输。
 * 重逻辑（事件归一/分页/回收）在包内已测，这里只验适配行为：
 * 历史装载、发送参数（含 initialEffort）、权限弹窗应答、中断、
 * effort 选择器、抽屉/供应商/新会话入口、id 生命周期。
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
  workspaceName?: string | null;
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
      workspaceName: overrides?.workspaceName ?? null,
      provider: { kind: "zhipu", icon: "Z", name: "测试供应商" },
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

  it("发送：send_message 带工作区路径与 initialEffort；user_message 广播回灌后气泡上屏", async () => {
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
      // 恒带当前档位（存活会话幂等；未起会话/离线随首条消息生效）
      expect(send?.params["initialEffort"]).toBe("high");
    });
    // 方案 C：发送方不本地画气泡——sidecar 广播 user_message 才上屏（模拟该时序）
    transport.emitChatEvent({ type: "user_message", session_id: "s1", text: "帮我跑下测试" });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("帮我跑下测试");
    });
  });

  it("权限请求事件 → 弹窗出现 → 允许应答 → permission_response 且弹窗消失", async () => {
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
    await wrapper.find(".pm-btn-allow").trigger("click");
    await vi.waitFor(() => {
      const resp = transport.calls.find((c) => c.command === "permission_response");
      expect(resp?.params["id"]).toBe("perm-1");
      expect(resp?.params["approved"]).toBe(true);
    });
    await vi.waitFor(() => {
      expect(wrapper.find(".pm-mask").exists()).toBe(false);
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

  it("离线时发送被拦截（输入保留，无 send_message）", async () => {
    const { wrapper, transport } = mountChat();
    await wrapper.setProps({ connState: "offline" });
    const textarea = wrapper.find("textarea");
    expect(textarea.attributes("disabled")).toBeDefined(); // 输入框禁用
    // 直接调组件内部路径也应有守卫：禁用态下 keydown 不发送
    await textarea.trigger("keydown", { key: "Enter" });
    expect(transport.calls.some((c) => c.command === "send_message")).toBe(false);
  });

  it("权限弹窗点拒绝：两步表单 → permission_response approved=false", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    transport.emitChatEvent({
      type: "permission_request",
      session_id: "s1",
      id: "perm-2",
      name: "Write",
      input: { file_path: "C:/proj/a.ts" },
    });
    await vi.waitFor(() => expect(wrapper.find(".pm-mask").exists()).toBe(true));
    // 第一步：点「拒绝」→ 按钮行换表单
    await wrapper.find(".pm-btn-deny").trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".pm-deny-form").exists()).toBe(true));
    // 第二步：确认拒绝（表单内同名按钮）
    await wrapper.find(".pm-deny-form .pm-btn-deny").trigger("click");
    await vi.waitFor(() => {
      const resp = transport.calls.find((c) => c.command === "permission_response");
      expect(resp?.params["approved"]).toBe(false);
    });
  });

  it("断线重连后触发整页重载（load_messages 再次调用）", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    const before = transport.calls.filter((c) => c.command === "load_messages").length;
    transport.reconnectedCb?.();
    await vi.waitFor(() => {
      expect(transport.calls.filter((c) => c.command === "load_messages").length).toBeGreaterThan(before);
    });
    expect(wrapper.text()).toContain("已重连");
  });

  it("空输入不发送", async () => {
    const { wrapper, transport } = mountChat();
    const textarea = wrapper.find("textarea");
    await textarea.setValue("   ");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(transport.calls.some((c) => c.command === "send_message")).toBe(false);
  });

  it("无工作区归属时发送：workspaceRoot 传 null（Rust 回落桌面活动工作区）", async () => {
    const { wrapper, transport } = mountChat(); // workspaceKey/Path 均 null
    const textarea = wrapper.find("textarea");
    await textarea.setValue("你好");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      const send = transport.calls.find((c) => c.command === "send_message");
      expect(send?.params["workspaceRoot"]).toBeNull();
    });
  });

  it("send_message 失败（断线拒收）：sysNote 落错误提示", async () => {
    const { wrapper, transport } = mountChat();
    transport.handlers.set("send_message", () => {
      throw new Error("未连接");
    });
    const textarea = wrapper.find("textarea");
    await textarea.setValue("离线消息");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("发送失败");
    });
  });

  it("权限输入超长时摘要截断到 120 字 + 省略号", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    const longCmd = "echo " + "x".repeat(200);
    transport.emitChatEvent({
      type: "permission_request",
      session_id: "s1",
      id: "perm-3",
      name: "Bash",
      input: { command: longCmd },
    });
    await vi.waitFor(() => {
      const el = wrapper.find(".pm-summary");
      expect(el.exists()).toBe(true);
      expect(el.text().length).toBe(121); // 120 + …
      expect(el.text().endsWith("…")).toBe(true);
    });
  });

  it("连接态灯色：connecting→warn 点；offline→离线横幅", async () => {
    const { wrapper } = mountChat();
    await wrapper.setProps({ connState: "connecting" });
    expect(wrapper.find(".pv-pill .dot").classes()).toContain("warn");
    await wrapper.setProps({ connState: "offline" });
    expect(wrapper.find(".ch-offbar").classes()).toContain("show");
    expect(wrapper.text()).toContain("设备离线");
  });

  it("permission 请求不带可摘要字段时摘要区不渲染", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    transport.emitChatEvent({
      type: "permission_request",
      session_id: "s1",
      id: "perm-4",
      name: "WebFetch",
      input: {}, // 无语义化字段
    });
    await vi.waitFor(() => expect(wrapper.find(".pm-mask").exists()).toBe(true));
    expect(wrapper.find(".pm-summary").exists()).toBe(false);
  });

  // ── v3：抽屉导航 + 供应商 pill + 新会话 ＋ ──

  it("顶栏 ☰ → emit openDrawer；＋ → emit newSession", async () => {
    const { wrapper } = mountChat();
    // ☰ 是第一个 .ch-back（新会话 ＋ 是第二个）
    const backs = wrapper.findAll(".ch-back");
    expect(backs.length).toBe(2);
    await backs[0].trigger("click");
    await backs[1].trigger("click");
    expect(wrapper.emitted("openDrawer")).toBeTruthy();
    expect(wrapper.emitted("newSession")).toBeTruthy();
  });

  it("顶栏供应商 pill：authed 点击 → emit openProviders；离线点击不 emit 只 toast", async () => {
    const { wrapper } = mountChat();
    await wrapper.find(".pv-pill").trigger("click");
    expect(wrapper.emitted("openProviders")).toBeTruthy();
    await wrapper.setProps({ connState: "offline" });
    await wrapper.find(".pv-pill").trigger("click");
    // 离线：只提示，不再 emit
    expect(wrapper.emitted("openProviders")!.length).toBe(1);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("设备离线，无法切换供应商");
    });
  });

  it("effort 选择器：点档位 → set_session_meta 持久化 + set_effort；chip 显示当前档", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => {
      expect(transport.calls.some((c) => c.command === "load_messages")).toBe(true);
    });
    // chip 默认档（session_effort 应答 null → 归一 high）
    expect(wrapper.find(".ef-chip").text()).toContain("思考");
    await wrapper.find(".ef-chip").trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".ef-pop").classes()).toContain("show"));
    // 选「快速」（low）：已有会话非临时 → meta patch 持久化 + 即时切换两连发
    const opts = wrapper.findAll(".ef-pop .ws-opt");
    expect(opts.length).toBe(3); // 三档制
    await opts[0].trigger("click");
    await vi.waitFor(() => {
      // 持久化走 meta patch：op:"set" 显式落值，provider/model 省略字段落 keep
      const persist = transport.calls.find((c) => c.command === "set_session_meta");
      expect(persist?.params["id"]).toBe("s1");
      expect(persist?.params["effort"]).toEqual({ op: "set", value: "low" });
    });
    await vi.waitFor(() => {
      const live = transport.calls.find((c) => c.command === "set_effort");
      expect(live?.params["sessionId"]).toBe("s1");
      expect(live?.params["effort"]).toBe("low");
    });
  });

  it("挂载读取会话档位：session_effort 应答归一显示（medium→思考）", async () => {
    const { wrapper } = mountChat({
      handlers: {
        session_effort: () => "medium", // 历史遗留档位归一映射
      },
    });
    await vi.waitFor(() => {
      expect(wrapper.find(".ef-chip").text()).toContain("思考");
    });
  });

  it("新会话空态：无消息时显示 logo + 发往工作区名，首条消息后消失", async () => {
    const { wrapper, transport } = mountChat({
      session: { id: null, name: "新会话" },
      workspaceName: "aide",
    });
    await vi.waitFor(() => expect(wrapper.find(".ch-empty").exists()).toBe(true));
    expect(wrapper.text()).toContain("发往工作区");
    expect(wrapper.text()).toContain("aide");
    const textarea = wrapper.find("textarea");
    await textarea.setValue("第一句话");
    await textarea.trigger("keydown", { key: "Enter" });
    // 气泡进临时 sid 的 store：先等 sessionBound，模拟 App 把 id 绑回路由态
    // （生产时序），messages 跟随 sidRef → 空态消失。
    let tempSid = "";
    await vi.waitFor(() => {
      expect(wrapper.emitted("sessionBound")).toBeTruthy();
      tempSid = (wrapper.emitted("sessionBound")![0] as [string])[0];
    });
    await wrapper.setProps({ session: { id: tempSid, name: "新会话" } });
    await vi.waitFor(() => {
      expect(wrapper.find(".ch-empty").exists()).toBe(false);
    });
  });

  it("顶栏 pill 渲染品牌 svg（kind 命中商标库）；custom kind 回退 icon 字符", async () => {
    const { wrapper } = mountChat();
    // zhipu → SDK 商标库品牌色（与桌面同库）
    expect(wrapper.find(".pv-pill svg.pl-svg").exists()).toBe(true);
    expect(wrapper.find(".pv-pill svg.pl-svg path").attributes("fill")).toBe("#3859FF");
    // custom（无商标条目）→ 回退 icon 字符
    await wrapper.setProps({ provider: { kind: "custom", icon: "C", name: "自建供应商" } });
    expect(wrapper.find(".pv-pill svg.pl-svg").exists()).toBe(false);
    expect(wrapper.find(".pv-pill .pl-glyph").text()).toBe("C");
    expect(wrapper.find(".pv-pill .pv-name").text()).toBe("自建供应商");
  });

  it("历史会话空态：hydrate 后仍无消息 → 防闪窗口后显示引导，可一键开抽屉", async () => {
    const { wrapper } = mountChat(); // 默认 load_messages 返回空 + session.id 非空
    // 800ms 防闪窗口内：不显示空态提示（hydrate 在途 messages 也为空）
    expect(wrapper.text()).not.toContain("此会话暂无消息");
    await new Promise((r) => setTimeout(r, 850));
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("此会话暂无消息");
    });
    await wrapper.find(".ch-empty-btn").trigger("click");
    expect(wrapper.emitted("openDrawer")).toBeTruthy();
  });

  // ── 图片发送 ──

  /** 往隐藏 file input 塞假文件并触发 change（jsdom 无 DataTransfer，defineProperty 直塞）。 */
  async function pickImages(
    wrapper: VueWrapper,
    files: File[],
  ): Promise<void> {
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: files });
    await input.trigger("change");
  }

  it("选图随消息发送：send_message 带 images，display 含 image 块，发送后预览清空", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => {
      expect(transport.calls.some((c) => c.command === "load_messages")).toBe(true);
    });
    await pickImages(wrapper, [new File(["x"], "a.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(wrapper.find(".ch-attach-item").exists()).toBe(true));
    const textarea = wrapper.find("textarea");
    await textarea.setValue("看这张图");
    await textarea.trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      const send = transport.calls.find((c) => c.command === "send_message");
      expect(send).toBeTruthy();
      expect(send?.params["images"]).toEqual([{ data: "aGk=", mediaType: "image/png" }]);
      // display 由闭包构造：image 块在前、text 块在后（其他端按此渲染气泡）
      const display = send?.params["display"] as Array<{ type: string; data?: string }>;
      expect(display[0]).toMatchObject({ type: "image", data: "aGk=", mediaType: "image/png" });
      expect(display[1]).toMatchObject({ type: "text", text: "看这张图" });
    });
    await vi.waitFor(() => expect(wrapper.find(".ch-attach-item").exists()).toBe(false));
  });

  it("无文字纯图片可发送：prompt 空串，模型只收图片块", async () => {
    const { wrapper, transport } = mountChat();
    await pickImages(wrapper, [new File(["x"], "a.png", { type: "image/png" })]);
    await vi.waitFor(() => expect(wrapper.find(".ch-attach-item").exists()).toBe(true));
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      const send = transport.calls.find((c) => c.command === "send_message");
      expect(send).toBeTruthy();
      expect(send?.params["prompt"]).toBe("");
      expect(send?.params["images"]).toEqual([{ data: "aGk=", mediaType: "image/png" }]);
    });
  });

  it("接收侧：user_message display 图片块在用户气泡渲染为 img", async () => {
    const { wrapper, transport } = mountChat();
    await vi.waitFor(() => expect(transport.chatEventCb).toBeTruthy());
    transport.emitChatEvent({
      type: "user_message",
      session_id: "s1",
      text: "看图",
      display: [
        { type: "image", data: "aGk=", mediaType: "image/png" },
        { type: "text", text: "看图" },
      ],
    });
    await vi.waitFor(() => {
      const imgs = wrapper.findAll(".m-bubble-user img.m-img");
      expect(imgs.length).toBe(1);
      expect(imgs[0].attributes("src")).toBe("data:image/png;base64,aGk=");
    });
  });

  it("编码中发送被拦（picking 守卫），编码完成后可发", async () => {
    const { wrapper, transport } = mountChat();
    // 让编码挂起：promise 手动放行
    let release!: (v: { data: string; mediaType: string }) => void;
    const { fileToAttachment } = vi.mocked(await import("../imageEncode"));
    fileToAttachment.mockImplementationOnce(
      () => new Promise((r) => (release = r)),
    );
    await pickImages(wrapper, [new File(["x"], "a.png", { type: "image/png" })]);
    // 编码挂起中：发送钮禁用，Enter 不发
    expect(wrapper.find(".ch-send").attributes("disabled")).toBeDefined();
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    expect(transport.calls.some((c) => c.command === "send_message")).toBe(false);
    release({ data: "aGk=", mediaType: "image/png" });
    await vi.waitFor(() => expect(wrapper.find(".ch-attach-item").exists()).toBe(true));
    await wrapper.find("textarea").setValue("看图");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await vi.waitFor(() => {
      expect(transport.calls.some((c) => c.command === "send_message")).toBe(true);
    });
  });
});

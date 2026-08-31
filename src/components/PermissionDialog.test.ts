// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import { nextTick } from "vue";
import PermissionDialog from "./PermissionDialog.vue";
import { useModal } from "../composables/useModal";
import type { PermissionRequest } from "../types/chat";
import type { PermissionRule, PermissionScope } from "../types/permissions";
import type { RememberContextState } from "../composables/usePermissionRememberContext";

// 组件的键盘 handler 挂 window——测试间不卸载会残留 listener：旧 listener 先
// preventDefault 事件，本测试的 listener 见 defaultPrevented 让路（生产语义正确，
// 测试里表现为「按键无效果」）。autoUnmount 每个测试后卸干净，杜绝跨测试污染。
enableAutoUnmount(afterEach);

const bashPermission = (): PermissionRequest => ({
  id: "p1",
  name: "Bash",
  input: { command: "ls -la" },
});

// ── rememberContext 契约 helpers ──
// rememberContext 必填（生产侧 ChatPanel 恒传）：不关心记住态的用例统一走
// mountDialog / mountAttached 注入 loading 默认；关心记住态的用例用 readyCtx
// 显式构造就绪快照。

/** loading 上下文（快照未就绪）。对象只读共享，弹窗不修改它。 */
const LOADING_CTX: RememberContextState = { status: "loading" };

/** ready 上下文：rules = 现有规则快照（默认空），scope = 可持久化作用域
 *  （默认 "local"；null = 无可写作用域，记住 UI 不显示）。 */
function readyCtx(
  rules: PermissionRule[] = [],
  scope: PermissionScope | null = "local",
): RememberContextState {
  return { status: "ready", rules, scope };
}

/** 统一 mount：默认注入 loading 上下文，props 覆盖式合并。 */
function mountDialog(props: Record<string, unknown>) {
  return mount(PermissionDialog, {
    props: { rememberContext: LOADING_CTX, ...props },
  });
}

/** 现有 Bash 前缀 allow 规则（快照构造用）。 */
function allowRule(value: string): PermissionRule {
  return {
    id: `r-${value}`,
    scope: "local",
    order: 0,
    effect: "allow",
    tool: "Bash",
    matcher: { kind: "bash", mode: "prefix", value },
    source: { label: "test", readOnly: false },
  };
}

describe("PermissionDialog — ordinary tool confirmation", () => {
  it("exposes only deny and allow (no always-allow button)", () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    expect(wrapper.find('[data-action="always-allow"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="allow"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
  });

  it("emits respond(approved=true) when allow is clicked (no always payload)", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="allow"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    // [id, approved, answers?, nextMode?] — no `always` slot.
    expect(events![0]).toEqual(["p1", true]);
  });

  it("deny click opens the reason input instead of responding immediately", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined(); // 尚未拒绝
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true); // 输入区展开
    expect(wrapper.find('[data-action="deny-submit"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny-back"]').exists()).toBe(true);
  });

  it("submitting with a reason emits respond with reason at the end", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("别删目录，改成移动");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, "别删目录，改成移动"]);
  });

  it("submitting with an empty reason is a plain deny (reason undefined)", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, undefined]);
  });

  it("Enter in the reason input submits the deny", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("改用相对路径");
    await wrapper.get('[data-action="deny-reason"]').trigger("keydown.enter");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, "改用相对路径"]);
  });

  it("back restores the button row without responding", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("放弃理由");
    await wrapper.get('[data-action="deny-back"]').trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true); // 恢复按钮行
  });

  it("a new request resets the deny input state", async () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("旧理由");
    await wrapper.setProps({ permission: { id: "p2", name: "Bash", input: { command: "ls" } } });
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false); // 复位到按钮态
  });
});

describe("PermissionDialog — 允许并记住", () => {
  it("ready 但无可持久化作用域（scope=null）时不显示记住按钮且无占位行", () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx([], null),
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    expect(wrapper.find(".perm-remember-hint").exists()).toBe(false);
  });

  it("ready 且可推导时显示记住按钮 + 规则行 + 段说明行", () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    const ruleInput = wrapper.find(".perm-remember-value");
    expect(ruleInput.exists()).toBe(true);
    expect((ruleInput.element as HTMLInputElement).value).toBe("ls -la");
    // 说明行：链式命令按段放行、已放行的段不再列出（防「拆段被误读成另一条命令」）
    expect(wrapper.find(".perm-remember-lead").text()).toContain("已放行的段不再列出");
  });

  it("点击记住按钮 emit 带 persistRule 的 respond", async () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
    });
    await wrapper.get('[data-action="remember"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe("p1");
    expect(events![0][1]).toBe(true);
    const persist = events![0][4] as {
      scope: string;
      rules: { tool: string; matcher: unknown }[];
    };
    expect(persist.scope).toBe("local");
    expect(persist.rules).toHaveLength(1);
    expect(persist.rules[0].tool).toBe("Bash");
    expect(persist.rules[0].matcher).toEqual({ kind: "bash", mode: "prefix", value: "ls -la" });
  });

  it("计划批准不显示记住按钮", () => {
    const wrapper = mountDialog({
      permission: { id: "p2", name: "ExitPlanMode", input: { plan: "do X" } },
      rememberContext: readyCtx(),
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    // loading + 非工具形态同样无占位行（rememberPossible 排除）
    const loadingWrapper = mountDialog({
      permission: { id: "p2", name: "ExitPlanMode", input: { plan: "do X" } },
      rememberContext: LOADING_CTX,
    });
    expect(loadingWrapper.find(".perm-remember-hint").exists()).toBe(false);
  });
});

describe("PermissionDialog — 允许并记住（多段 + 参数透明化）", () => {
  const pipePermission = (): PermissionRequest => ({
    id: "p4",
    name: "Bash",
    input: { command: "npx vitest run 2>&1 | tail -8" },
  });

  it("链式命令一次列出多条规则（每段一条）", () => {
    const wrapper = mountDialog({
      permission: pipePermission(),
      rememberContext: readyCtx(),
    });
    expect(wrapper.findAll(".perm-remember-rule")).toHaveLength(2); // npx vitest run + tail -8
  });

  it("编辑规则值后 emit 携带编辑后的值", async () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
    });
    await wrapper.find(".perm-remember-value").setValue("ls");
    await wrapper.get('[data-action="remember"]').trigger("click");
    const persist = wrapper.emitted("respond")![0][4] as {
      rules: { matcher: { value: string } }[];
    };
    expect(persist.rules[0].matcher.value).toBe("ls");
  });

  it("末尾数字参数（tail -8 形态）提示并可一键改宽", async () => {
    const wrapper = mountDialog({
      permission: pipePermission(),
      rememberContext: readyCtx(),
    });
    expect(wrapper.find(".perm-remember-note").text()).toContain("仅匹配字面参数");
    await wrapper.get(".perm-remember-simplify").trigger("click");
    const values = wrapper.findAll(".perm-remember-value");
    expect((values[1].element as HTMLInputElement).value).toBe("tail");
  });

  it("编辑成含控制符的值→行标红、按钮禁用", async () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
    });
    await wrapper.find(".perm-remember-value").setValue("ls; rm -rf /");
    expect(wrapper.find(".perm-remember-error").exists()).toBe(true);
    expect(
      (wrapper.get('[data-action="remember"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("编辑成空值→行标红「规则值不能为空」、按钮禁用", async () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
    });
    await wrapper.find(".perm-remember-value").setValue("   ");
    expect(wrapper.find(".perm-remember-error").text()).toBe("规则值不能为空");
    expect(
      (wrapper.get('[data-action="remember"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("非 Bash 规则（WebFetch）只读展示，无可编辑输入；点击记住原样透传 draft", async () => {
    const wrapper = mountDialog({
      permission: { id: "p5", name: "WebFetch", input: { url: "https://x.com/p" } },
      rememberContext: readyCtx(),
    });
    expect(wrapper.find(".perm-remember-static").exists()).toBe(true);
    expect(wrapper.find(".perm-remember-value").exists()).toBe(false);

    // 点击记住：非 Bash draft 原样透传（不带可编辑值改写）
    await wrapper.get('[data-action="remember"]').trigger("click");
    const persist = wrapper.emitted("respond")![0][4] as {
      scope: string;
      rules: { tool: string; matcher: unknown }[];
    };
    expect(persist.rules).toEqual([
      { effect: "allow", tool: "WebFetch", matcher: { kind: "field", field: "url", equals: "https://x.com/p" } },
    ]);
  });

  it("快照未就绪（loading）→ 占位行、无按钮无规则行；就绪后已覆盖段不出现", async () => {
    const wrapper = mountDialog({
      permission: {
        id: "p6",
        name: "Bash",
        input: { command: "cd /tmp/x && rm -f a.jar && grep foo" },
      },
      rememberContext: LOADING_CTX,
    });
    // loading：占位行 + 记住按钮/规则行都不渲染（就绪后随行一起出现）
    expect(wrapper.find(".perm-remember-hint").exists()).toBe(true);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    expect(wrapper.find(".perm-remember-rule").exists()).toBe(false);
    // 普通「允许/拒绝」不受 loading 影响
    expect(wrapper.find('[data-action="allow"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);

    await wrapper.setProps({
      rememberContext: readyCtx([allowRule("cd"), allowRule("grep")]),
    });
    await nextTick();

    // 就绪：cd/grep 段已被现有规则覆盖 → 只剩 rm 段一行，按钮随行出现
    expect(wrapper.find(".perm-remember-hint").exists()).toBe(false);
    const inputs = wrapper.findAll(".perm-remember-value");
    expect(inputs).toHaveLength(1);
    expect((inputs[0].element as HTMLInputElement).value).toBe("rm -f a.jar");
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);

    await wrapper.get('[data-action="remember"]').trigger("click");
    const persist = wrapper.emitted("respond")![0][4] as {
      rules: { matcher: { value: string } }[];
    };
    expect(persist.rules).toHaveLength(1);
    expect(persist.rules[0].matcher.value).toBe("rm -f a.jar");
  });

  it("ready 后规则集变化（队列下一请求的快照）：行收缩且输入框值与新行对齐（不残留旧行值）", async () => {
    // 回归：行集变化时 editableValues 必须随 rememberDrafts 重同步——否则 rm 行
    // 残留 cd 行的值，点「允许并记住」会把错误值写进规则库。
    const wrapper = mountDialog({
      permission: {
        id: "p6",
        name: "Bash",
        input: { command: "cd /tmp/x && rm -f a.jar && grep foo" },
      },
      rememberContext: readyCtx(),
    });
    expect(wrapper.findAll(".perm-remember-rule")).toHaveLength(3); // 空快照：全量段

    await wrapper.setProps({ rememberContext: readyCtx([allowRule("cd"), allowRule("grep")]) });
    await nextTick();

    const inputs = wrapper.findAll(".perm-remember-value");
    expect(inputs).toHaveLength(1); // 只剩未覆盖的 rm 段
    expect((inputs[0].element as HTMLInputElement).value).toBe("rm -f a.jar");

    await wrapper.get('[data-action="remember"]').trigger("click");
    const persist = wrapper.emitted("respond")![0][4] as {
      rules: { matcher: { value: string } }[];
    };
    expect(persist.rules).toHaveLength(1);
    expect(persist.rules[0].matcher.value).toBe("rm -f a.jar");
  });

  it("ready → loading（新请求）：规则行与按钮清空（旧快照不得泄漏进新请求首帧）", async () => {
    const wrapper = mountDialog({
      permission: {
        id: "p7",
        name: "Bash",
        input: { command: "rm -f a.jar" },
      },
      rememberContext: readyCtx(),
    });
    expect(wrapper.find(".perm-remember-rule").exists()).toBe(true);

    await wrapper.setProps({ permission: { id: "p8", name: "Bash", input: { command: "cargo check" } }, rememberContext: LOADING_CTX });
    await nextTick();

    expect(wrapper.find(".perm-remember-rule").exists()).toBe(false);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    // 新请求可推导 → 占位行出现（不再是旧行）
    expect(wrapper.find(".perm-remember-hint").exists()).toBe(true);
  });

  it("ready 且链式段全部被现有规则覆盖 → 无规则行无按钮（不出现「0 条写入却成功」）", () => {
    const wrapper = mountDialog({
      permission: {
        id: "p9",
        name: "Bash",
        input: { command: "pnpm test | grep x" },
      },
      rememberContext: readyCtx([allowRule("pnpm test"), allowRule("grep")]),
    });
    expect(wrapper.find(".perm-remember-rule").exists()).toBe(false);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    expect(wrapper.find(".perm-remember-hint").exists()).toBe(false); // ready 无占位
  });
});

describe("PermissionDialog — 进入编辑模式", () => {
  const editPermission = (): PermissionRequest => ({
    id: "p3",
    name: "Edit",
    input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
  });

  it("手动模式下编辑工具显示「进入编辑模式」、顶替「允许并记住」", () => {
    const wrapper = mountDialog({
      permission: editPermission(),
      rememberContext: readyCtx(),
      currentMode: "default",
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    // 会话级规则提示移入按钮 tooltip（v-tooltip 指令，非原生 title）
    expect(wrapper.get('[data-action="allow"]').attributes("title")).toBeUndefined();
  });

  it("文件工具「允许」/「进入编辑模式」按钮带会话级规则 tooltip", () => {
    const bindings = new Map<string, string>();
    const wrapper = mount(PermissionDialog, {
      props: {
        permission: editPermission(),
        rememberContext: readyCtx(),
        currentMode: "default",
      },
      global: {
        directives: {
          tooltip: {
            mounted(el: HTMLElement, binding: { value: string }) {
              if (binding.value) bindings.set(el.getAttribute("data-action") ?? "", binding.value);
            },
          },
        },
      },
    });
    expect(bindings.get("allow")).toBe("该文件本次会话不再询问");
    expect(bindings.get("edit-mode")).toBe("本会话所有文件编辑自动接受");
  });

  it("非文件工具（Bash）「允许」按钮无会话级规则 tooltip", () => {
    const bindings = new Map<string, string>();
    mount(PermissionDialog, {
      props: {
        permission: bashPermission(),
        rememberContext: readyCtx(),
        currentMode: "default",
      },
      global: {
        directives: {
          tooltip: {
            mounted(el: HTMLElement, binding: { value: string }) {
              if (binding.value) bindings.set(el.getAttribute("data-action") ?? "", binding.value);
            },
          },
        },
      },
    });
    expect(bindings.get("allow")).toBeUndefined();
  });

  it("点击「进入编辑模式」emit 带 nextMode=acceptEdits 的放行", async () => {
    const wrapper = mountDialog({
      permission: editPermission(),
      rememberContext: readyCtx(),
      currentMode: "default",
    });
    await wrapper.get('[data-action="edit-mode"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    expect(events![0]).toEqual(["p3", true, undefined, "acceptEdits"]);
  });

  it("非编辑工具（Bash）不显示，仍走「允许并记住」", () => {
    const wrapper = mountDialog({
      permission: bashPermission(),
      rememberContext: readyCtx(),
      currentMode: "default",
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
  });

  it("已在编辑/自动/最高权限模式时不显示（弹窗属 ask 规则例外，回到记住按钮）", () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions"]) {
      const wrapper = mountDialog({
        permission: editPermission(),
        rememberContext: readyCtx(),
        currentMode: mode,
      });
      expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
      expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    }
  });

  it("模式还没就位（空串）时按手动模式处理：显示", () => {
    const wrapper = mountDialog({ permission: editPermission(), currentMode: "" });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(true);
  });
});

describe("PermissionDialog — 折叠（计划批准 / 澄清提问）", () => {
  const planPermission = (): PermissionRequest => ({
    id: "pp1",
    name: "ExitPlanMode",
    input: { plan: "做这件事\n1. 第一步\n2. 第二步" },
  });
  const questionPermission = (): PermissionRequest => ({
    id: "qq1",
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "用哪个？",
          header: "选择",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    },
  });

  /** perm-body 的内联 display——v-show 直接设这个。jsdom 的 getComputedStyle 对
   *  v-show 的 display:none 不可靠（isVisible() 时真时假、且不遍历祖先），改读
   *  element.style.display 这条确定性信号：展开="" / 收起="none"。 */
  const bodyDisplay = (w: ReturnType<typeof mount>): string =>
    (w.find(".perm-body").element as HTMLElement).style.display;

  it("计划批准默认展开，点折叠按钮收起正文、再点展开", async () => {
    const wrapper = mountDialog({ permission: planPermission() });
    expect(bodyDisplay(wrapper)).toBe("");
    expect(wrapper.find(".perm-collapse-caret").text()).toBe("▾");
    expect(wrapper.find(".perm-collapse").attributes("aria-expanded")).toBe("true");
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("none");
    expect(wrapper.find(".perm-collapse-caret").text()).toBe("▴");
    expect(wrapper.find(".perm-collapse").attributes("aria-expanded")).toBe("false");
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("");
    expect(wrapper.find(".perm-collapse-caret").text()).toBe("▾");
  });

  it("澄清提问同样可折叠", async () => {
    const wrapper = mountDialog({ permission: questionPermission() });
    expect(wrapper.find(".perm-collapse").exists()).toBe(true);
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("none");
  });

  it("工具调用弹窗不渲染折叠按钮（弹窗本就矮，折叠无意义）", () => {
    const wrapper = mountDialog({ permission: bashPermission() });
    expect(wrapper.find(".perm-collapse").exists()).toBe(false);
  });

  it("新请求到达时折叠状态复位为展开", async () => {
    const wrapper = mountDialog({ permission: planPermission() });
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("none");
    await wrapper.setProps({
      permission: { id: "pp2", name: "ExitPlanMode", input: { plan: "另一份计划" } },
    });
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("");
    expect(wrapper.find(".perm-collapse-caret").text()).toBe("▾");
  });

  it("折叠时操作按钮随正文一起隐藏——先看上下文再展开决定", async () => {
    const wrapper = mountDialog({ permission: planPermission() });
    const actionsEl = () => wrapper.find(".perm-actions").element as HTMLElement;
    // 操作按钮在 perm-body 内；展开时正文块无 inline display
    expect((actionsEl().closest(".perm-body") as HTMLElement | null)?.style.display).toBe("");
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    // 正文 display:none ⇒ 其内操作按钮一并不可见
    expect(bodyDisplay(wrapper)).toBe("none");
    expect((actionsEl().closest(".perm-body") as HTMLElement | null)?.style.display).toBe("none");
  });

  it("计划批准「继续修改计划」同样支持拒绝理由", async () => {
    const wrapper = mountDialog({ permission: planPermission() });
    await wrapper.get('[data-action="deny"]').trigger("click");
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true);
    await wrapper.get('[data-action="deny-reason"]').setValue("不要动 X，只做 Y");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["pp1", false, undefined, undefined, undefined, "不要动 X，只做 Y"]);
  });

  it("澄清提问「跳过」不支持理由输入（保持原样）", () => {
    const wrapper = mountDialog({ permission: questionPermission() });
    // question 的拒绝按钮是「跳过」，点了直接 respond，不展开理由输入
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
    const skip = [...wrapper.findAll("button")].find((b) => b.text().includes("跳过"));
    expect(skip).toBeTruthy();
  });
});

describe("PermissionDialog — 键盘确认（Enter/Esc）", () => {
  // 键盘 handler 的守卫查 document（.perm-dock 数量 / 遮罩层类名）——必须
  //  attachTo body 让组件 DOM 进 document。卸载由文件级 enableAutoUnmount 兜底，
  //  这里只清手动 append 的 textarea / 遮罩 div。
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mountAttached(props: Record<string, unknown>) {
      return mount(PermissionDialog, {
      props: { rememberContext: LOADING_CTX, ...props },
      attachTo: document.body,
    });
  }

  function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  }
  /** jsdom 的 KeyboardEventInit 不收 isComposing，defineProperty 钉死模拟输入法组合态。 */
  function pressComposing(key: string, target: EventTarget = window): void {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    Object.defineProperty(e, "isComposing", { value: true });
    target.dispatchEvent(e);
  }

  /** 取第 index 条 respond emit——不用 events![i] 非空断言（X2/X3）：先断言总条数
   *  把契约说死，再用可选链取值，undefined 臂交给 toEqual 判等失败报出。 */
  function respondEvent(wrapper: ReturnType<typeof mount>, index: number, total: number) {
    const ev = wrapper.emitted("respond");
    expect(ev).toHaveLength(total);
    return ev?.[index];
  }

  const planPerm = (): PermissionRequest => ({ id: "pp1", name: "ExitPlanMode", input: { plan: "计划正文" } });
  const questionPerm = (): PermissionRequest => ({
    id: "qq1",
    name: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "用哪个？",
          header: "选择",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    },
  });
  const confirmPerm = (): PermissionRequest => ({
    id: "sc1",
    name: "__sendConfirm__",
    input: { title: "t", chip: "c", question: "q", info: "i", confirmLabel: "继续发送" },
  });

  // ── 四种形态的主动作 / 负面出口 ──

  it("工具调用：Enter = 允许（事件被消费）", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    const e = press("Enter");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["p1", true]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("工具调用：Esc = 展开理由输入（不直接拒绝），理由输入自动聚焦", async () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Escape");
    expect(wrapper.emitted("respond")).toBeUndefined();
    await nextTick();
    const input = wrapper.get('[data-action="deny-reason"]');
    expect(input.exists()).toBe(true);
    expect(document.activeElement).toBe(input.element);
  });

  it("计划批准：Enter = 批准 Auto 模式（事件被消费）", () => {
    const wrapper = mountAttached({ permission: planPerm() });
    const e = press("Enter");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["pp1", true, undefined, "auto"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("计划批准：Esc = 展开理由输入（事件被消费）", () => {
    const wrapper = mountAttached({ permission: planPerm() });
    const e = press("Escape");
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
  });

  it("澄清提问：未作答 Enter 无效果；作答后 Enter = 提交回答", async () => {
    const wrapper = mountAttached({ permission: questionPerm() });
    press("Enter");
    expect(wrapper.emitted("respond")).toBeUndefined(); // canSubmitQuestions 门

    const options = wrapper.findAll(".perm-option");
    expect(options).toHaveLength(3); // 2 个选项卡 + 1 张「其他…」
    await options[0]?.trigger("click");
    press("Enter");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["qq1", true, { "用哪个？": "A" }]);
  });

  it("澄清提问：Esc = 跳过", () => {
    const wrapper = mountAttached({ permission: questionPerm() });
    press("Escape");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["qq1", false]);
  });

  it("发送前确认：Enter = 继续发送", () => {
    const wrapper = mountAttached({ permission: confirmPerm() });
    press("Enter");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["sc1", true]);
  });

  it("发送前确认：Esc = 取消", () => {
    const wrapper = mountAttached({ permission: confirmPerm() });
    press("Escape");
    expect(respondEvent(wrapper, 0, 1)).toEqual(["sc1", false]);
  });

  // ── denyOpen 态的两键 ──

  it("理由输入态：window Enter = 提交拒绝（焦点不在输入框也提交）", async () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Escape"); // 开理由输入
    await nextTick();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true);
    press("Enter"); // 空理由 = 普通拒绝
    expect(respondEvent(wrapper, 0, 1)).toEqual(["p1", false, undefined, undefined, undefined, undefined]);
  });

  it("理由输入态：window Esc = 返回按钮态", async () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Escape");
    await nextTick();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true);
    press("Escape"); // 返回
    await nextTick(); // 手动 dispatch 不经 VTU trigger，DOM 更新要等下一轮 flush
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
  });

  it("焦点在理由输入框时 Esc 走输入框自己的 handler 返回（不双发）", async () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Escape");
    await nextTick();
    press("Escape", {}, wrapper.get('[data-action="deny-reason"]').element);
    await nextTick(); // 手动 dispatch 不经 VTU trigger，DOM 更新要等下一轮 flush
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
  });

  // ── 守卫分支 ──

  it("无待确认请求时按键不动作", () => {
    const wrapper = mountAttached({ permission: null });
    press("Enter");
    press("Escape");
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  it("焦点在 textarea：Enter/Esc 都让路（聊天输入 / xterm 场景）", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    press("Enter", {}, ta);
    press("Escape", {}, ta);
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
  });

  it("焦点在按钮上：Enter 让路给原生 click（防焦点在「允许」上双发）", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Enter", {}, wrapper.get('[data-action="allow"]').element);
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  it("焦点在普通元素（div）：Enter 正常触发主动作", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    const div = document.createElement("div");
    document.body.appendChild(div);
    press("Enter", {}, div);
    expect(respondEvent(wrapper, 0, 1)).toEqual(["p1", true]);
  });

  it("带修饰键（Ctrl/Shift/Alt/Meta）不动作", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Enter", { ctrlKey: true });
    press("Enter", { shiftKey: true });
    press("Escape", { altKey: true });
    press("Enter", { metaKey: true });
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
  });

  it("输入法组合中（isComposing）与按住重复（repeat）不动作", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    pressComposing("Enter");
    press("Enter", { repeat: true });
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  it("上游已消费（defaultPrevented）让路——一次按键只产生一个效果", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    e.preventDefault(); // 模拟 App capture 的 workbench Esc / palette 等先消费
    window.dispatchEvent(e);
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  it("遮罩层开着（设置面板 / 全局 modal）：按键属于遮罩，不穿透", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    const overlay = document.createElement("div");
    overlay.className = "settings-overlay";
    document.body.appendChild(overlay);
    press("Enter");
    press("Escape");
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
    overlay.remove();

    const { confirm, cancel, visible } = useModal();
    void confirm("标题", "内容");
    expect(visible.value).toBe(true);
    press("Enter");
    expect(wrapper.emitted("respond")).toBeUndefined();
    cancel();
  });

  it("两个弹窗并存（多窗格都待确认）：键盘不动作，强制鼠标（安全缺省）", () => {
    const w1 = mountAttached({ permission: bashPermission() });
    const w2 = mountAttached({ permission: { id: "p9", name: "Bash", input: { command: "pwd" } } });
    press("Enter");
    expect(w1.emitted("respond")).toBeUndefined();
    expect(w2.emitted("respond")).toBeUndefined();
    // 收掉一个后恢复唯一弹窗，键盘恢复响应
    w2.unmount();
    press("Enter");
    expect(respondEvent(w1, 0, 1)).toEqual(["p1", true]);
  });

  it("非 Enter/Escape 键不动作", () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("a");
    press("Tab");
    expect(wrapper.emitted("respond")).toBeUndefined();
  });

  // ── 文本输入 Enter 的 IME 守卫 ──

  it("自由文本输入：Enter 提交回答；输入法组合中 Enter（选词）不提交", async () => {
    const wrapper = mountAttached({ permission: questionPerm() });
    await wrapper.get(".perm-option--other").trigger("click");
    const input = wrapper.get(".perm-freetext");
    await input.setValue("用方案 A");
    pressComposing("Enter", input.element); // 选词确认
    expect(wrapper.emitted("respond")).toBeUndefined();
    press("Enter", {}, input.element); // 真正提交
    expect(respondEvent(wrapper, 0, 1)).toEqual(["qq1", true, { "用哪个？": "用方案 A" }]);
  });

  it("理由输入：输入法组合中 Enter（选词）不提交拒绝", async () => {
    const wrapper = mountAttached({ permission: bashPermission() });
    press("Escape");
    await nextTick();
    const input = wrapper.get('[data-action="deny-reason"]');
    await input.setValue("别删");
    pressComposing("Enter", input.element);
    expect(wrapper.emitted("respond")).toBeUndefined();
    press("Enter", {}, input.element);
    expect(respondEvent(wrapper, 0, 1)).toEqual(["p1", false, undefined, undefined, undefined, "别删"]);
  });

  // ── 点击路径补测（键盘测试绕过了这些 @click 内联 handler，补齐覆盖）──

  it("发送前确认：点击 取消 / 继续发送", async () => {
    const wrapper = mountAttached({ permission: confirmPerm() });
    const btns = wrapper.findAll(".perm-btn");
    expect(btns).toHaveLength(2);
    await btns[0]?.trigger("click"); // 取消
    await btns[1]?.trigger("click"); // 继续发送
    expect(respondEvent(wrapper, 0, 2)).toEqual(["sc1", false]);
    expect(respondEvent(wrapper, 1, 2)).toEqual(["sc1", true]);
  });

  it("计划批准：点击三个批准按钮（手动 / 自动接受 / Auto）", async () => {
    const wrapper = mountAttached({ permission: planPerm() });
    const buttons = wrapper.findAll(".perm-actions-primary .perm-btn");
    expect(buttons).toHaveLength(3);
    for (const b of buttons) await b.trigger("click");
    expect(respondEvent(wrapper, 0, 3)).toEqual(["pp1", true, undefined, undefined]);
    expect(respondEvent(wrapper, 1, 3)).toEqual(["pp1", true, undefined, "acceptEdits"]);
    expect(respondEvent(wrapper, 2, 3)).toEqual(["pp1", true, undefined, "auto"]);
  });

  // ── 按键提示 chip ──

  it("工具调用：允许/拒绝带 chip，允许并记住/进入编辑模式不带", () => {
    const wrapper = mountAttached({ permission: bashPermission(), rememberContext: readyCtx() });
    expect(wrapper.get('[data-action="allow"] .perm-btn-key').text()).toBe("Enter");
    expect(wrapper.get('[data-action="deny"] .perm-btn-key').text()).toBe("Esc");
    expect(wrapper.find('[data-action="remember"] .perm-btn-key').exists()).toBe(false);
  });

  it("计划批准：Auto 主按钮带 Enter chip，两个 outline 批准不带；理由态两键带 chip", async () => {
    const wrapper = mountAttached({ permission: planPerm() });
    const solid = wrapper.get(".perm-btn--solid");
    expect(solid.text()).toContain("批准，使用 Auto 模式");
    expect(solid.get(".perm-btn-key").text()).toBe("Enter");
    for (const outline of wrapper.findAll(".perm-actions-primary .perm-btn--outline")) {
      expect(outline.find(".perm-btn-key").exists()).toBe(false);
    }
    press("Escape");
    await nextTick();
    expect(wrapper.get('[data-action="deny-submit"] .perm-btn-key').text()).toBe("Enter");
    expect(wrapper.get('[data-action="deny-back"] .perm-btn-key').text()).toBe("Esc");
  });
});
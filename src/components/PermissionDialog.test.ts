// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import PermissionDialog from "./PermissionDialog.vue";
import type { PermissionRequest } from "../types/chat";

const bashPermission = (): PermissionRequest => ({
  id: "p1",
  name: "Bash",
  input: { command: "ls -la" },
});

describe("PermissionDialog — ordinary tool confirmation", () => {
  it("exposes only deny and allow (no always-allow button)", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    expect(wrapper.find('[data-action="always-allow"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="allow"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
  });

  it("emits respond(approved=true) when allow is clicked (no always payload)", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="allow"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    // [id, approved, answers?, nextMode?] — no `always` slot.
    expect(events![0]).toEqual(["p1", true]);
  });

  it("deny click opens the reason input instead of responding immediately", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined(); // 尚未拒绝
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true); // 输入区展开
    expect(wrapper.find('[data-action="deny-submit"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny-back"]').exists()).toBe(true);
  });

  it("submitting with a reason emits respond with reason at the end", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("别删目录，改成移动");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, "别删目录，改成移动"]);
  });

  it("submitting with an empty reason is a plain deny (reason undefined)", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, undefined]);
  });

  it("Enter in the reason input submits the deny", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("改用相对路径");
    await wrapper.get('[data-action="deny-reason"]').trigger("keydown.enter");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined, "改用相对路径"]);
  });

  it("back restores the button row without responding", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("放弃理由");
    await wrapper.get('[data-action="deny-back"]').trigger("click");
    expect(wrapper.emitted("respond")).toBeUndefined();
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true); // 恢复按钮行
  });

  it("a new request resets the deny input state", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    await wrapper.get('[data-action="deny-reason"]').setValue("旧理由");
    await wrapper.setProps({ permission: { id: "p2", name: "Bash", input: { command: "ls" } } });
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false); // 复位到按钮态
  });
});

describe("PermissionDialog — 允许并记住", () => {
  it("无 rememberScope 时不显示记住按钮", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
  });

  it("有 rememberScope 且可推导时显示记住按钮 + 规则行", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    const ruleInput = wrapper.find(".perm-remember-value");
    expect(ruleInput.exists()).toBe(true);
    expect((ruleInput.element as HTMLInputElement).value).toBe("ls -la");
  });

  it("点击记住按钮 emit 带 persistRule 的 respond", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
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
    const wrapper = mount(PermissionDialog, {
      props: {
        permission: { id: "p2", name: "ExitPlanMode", input: { plan: "do X" } },
        rememberScope: "local",
      },
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
  });
});

describe("PermissionDialog — 允许并记住（多段 + 参数透明化）", () => {
  const pipePermission = (): PermissionRequest => ({
    id: "p4",
    name: "Bash",
    input: { command: "npx vitest run 2>&1 | tail -8" },
  });

  it("链式命令一次列出多条规则（每段一条）", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: pipePermission(), rememberScope: "local" },
    });
    expect(wrapper.findAll(".perm-remember-rule")).toHaveLength(2); // npx vitest run + tail -8
  });

  it("编辑规则值后 emit 携带编辑后的值", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
    });
    await wrapper.find(".perm-remember-value").setValue("ls");
    await wrapper.get('[data-action="remember"]').trigger("click");
    const persist = wrapper.emitted("respond")![0][4] as {
      rules: { matcher: { value: string } }[];
    };
    expect(persist.rules[0].matcher.value).toBe("ls");
  });

  it("末尾数字参数（tail -8 形态）提示并可一键改宽", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: pipePermission(), rememberScope: "local" },
    });
    expect(wrapper.find(".perm-remember-note").text()).toContain("仅匹配字面参数");
    await wrapper.get(".perm-remember-simplify").trigger("click");
    const values = wrapper.findAll(".perm-remember-value");
    expect((values[1].element as HTMLInputElement).value).toBe("tail");
  });

  it("编辑成含控制符的值→行标红、按钮禁用", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
    });
    await wrapper.find(".perm-remember-value").setValue("ls; rm -rf /");
    expect(wrapper.find(".perm-remember-error").exists()).toBe(true);
    expect(
      (wrapper.get('[data-action="remember"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("非 Bash 规则（WebFetch）只读展示，无可编辑输入", () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        permission: { id: "p5", name: "WebFetch", input: { url: "https://x.com/p" } },
        rememberScope: "local",
      },
    });
    expect(wrapper.find(".perm-remember-static").exists()).toBe(true);
    expect(wrapper.find(".perm-remember-value").exists()).toBe(false);
  });
});

describe("PermissionDialog — 进入编辑模式", () => {
  const editPermission = (): PermissionRequest => ({
    id: "p3",
    name: "Edit",
    input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
  });

  it("手动模式下编辑工具显示「进入编辑模式」、顶替「允许并记住」", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), rememberScope: "local", currentMode: "default" },
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    // 会话级规则提示移入按钮 tooltip（v-tooltip 指令，非原生 title）
    expect(wrapper.get('[data-action="allow"]').attributes("title")).toBeUndefined();
  });

  it("文件工具「允许」/「进入编辑模式」按钮带会话级规则 tooltip", () => {
    const bindings = new Map<string, string>();
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), rememberScope: "local", currentMode: "default" },
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
      props: { permission: bashPermission(), rememberScope: "local", currentMode: "default" },
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
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), rememberScope: "local", currentMode: "default" },
    });
    await wrapper.get('[data-action="edit-mode"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    expect(events![0]).toEqual(["p3", true, undefined, "acceptEdits"]);
  });

  it("非编辑工具（Bash）不显示，仍走「允许并记住」", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local", currentMode: "default" },
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
  });

  it("已在编辑/自动/最高权限模式时不显示（弹窗属 ask 规则例外，回到记住按钮）", () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions"]) {
      const wrapper = mount(PermissionDialog, {
        props: { permission: editPermission(), rememberScope: "local", currentMode: mode },
      });
      expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
      expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    }
  });

  it("模式还没就位（空串）时按手动模式处理：显示", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), currentMode: "" },
    });
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
    const wrapper = mount(PermissionDialog, { props: { permission: planPermission() } });
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
    const wrapper = mount(PermissionDialog, { props: { permission: questionPermission() } });
    expect(wrapper.find(".perm-collapse").exists()).toBe(true);
    await wrapper.get(".perm-collapse").trigger("click");
    await nextTick();
    expect(bodyDisplay(wrapper)).toBe("none");
  });

  it("工具调用弹窗不渲染折叠按钮（弹窗本就矮，折叠无意义）", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    expect(wrapper.find(".perm-collapse").exists()).toBe(false);
  });

  it("新请求到达时折叠状态复位为展开", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: planPermission() } });
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
    const wrapper = mount(PermissionDialog, { props: { permission: planPermission() } });
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
    const wrapper = mount(PermissionDialog, { props: { permission: planPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(true);
    await wrapper.get('[data-action="deny-reason"]').setValue("不要动 X，只做 Y");
    await wrapper.get('[data-action="deny-submit"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["pp1", false, undefined, undefined, undefined, "不要动 X，只做 Y"]);
  });

  it("澄清提问「跳过」不支持理由输入（保持原样）", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: questionPermission() } });
    // question 的拒绝按钮是「跳过」，点了直接 respond，不展开理由输入
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="deny-reason"]').exists()).toBe(false);
    const skip = [...wrapper.findAll("button")].find((b) => b.text().includes("跳过"));
    expect(skip).toBeTruthy();
  });
});
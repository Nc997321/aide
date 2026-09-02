import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { PermissionRequest } from "@aide/sdk/types/chat";
import PermissionSheet from "./PermissionSheet.vue";

/**
 * PermissionSheet 形态分发测试（纯组件级，无传输）：
 * tool / plan / question 三形态渲染与应答打包、拒绝两步表单、
 * 编辑模式入口、AskUserQuestion 选择状态机、新请求复位。
 */

function mountSheet(permission: PermissionRequest | null, extra?: { queueCount?: number; currentMode?: string }) {
  return mount(PermissionSheet, {
    props: {
      permission,
      queueCount: extra?.queueCount,
      currentMode: extra?.currentMode,
    },
  });
}

function toolPerm(over?: Partial<PermissionRequest>): PermissionRequest {
  return { id: "p1", name: "Bash", input: { command: "cargo test" }, ...over };
}

describe("PermissionSheet（形态分发）", () => {
  // ── tool 形态 ──

  it("tool：eyebrow + 摘要 + JSON 折叠", () => {
    const w = mountSheet(toolPerm());
    expect(w.text()).toContain("工具调用请求");
    expect(w.text()).toContain("Bash");
    expect(w.find(".pm-summary").text()).toBe("cargo test");
    expect(w.find(".pm-json").exists()).toBe(true);
  });

  it("tool 允许：emit respond(id, true) 无附加参数", async () => {
    const w = mountSheet(toolPerm());
    await w.find(".pm-btn-allow").trigger("click");
    // emit 实参形状（4 参：id/approved/answers/nextMode，reason 位未传）
    expect(w.emitted("respond")![0]).toEqual(["p1", true, undefined, undefined]);
  });

  it("tool 拒绝：两步表单，理由随 emit；空理由 = undefined", async () => {
    const w = mountSheet(toolPerm());
    await w.find(".pm-btn-deny").trigger("click");
    expect(w.find(".pm-deny-form").exists()).toBe(true);
    // 空理由直接确认（5 参全形状：reason 位为 undefined）
    await w.find(".pm-deny-form .pm-btn-deny").trigger("click");
    expect(w.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, undefined]);
  });

  it("tool 拒绝填理由：reason 透传", async () => {
    const w = mountSheet(toolPerm());
    await w.find(".pm-btn-deny").trigger("click");
    await w.find(".pm-deny-input").setValue("别动 dist");
    await w.find(".pm-deny-form .pm-btn-deny").trigger("click");
    expect(w.emitted("respond")![0]).toEqual(["p1", false, undefined, undefined, "别动 dist"]);
  });
  it("编辑工具（Edit）在非编辑模式：显示「进入编辑模式」→ nextMode=acceptEdits", async () => {
    const w = mountSheet(toolPerm({ name: "Edit", input: { file_path: "a.ts" } }), { currentMode: "default" });
    const btn = w.find(".pm-btn-editmode");
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(w.emitted("respond")![0]).toEqual(["p1", true, undefined, "acceptEdits"]);
  });

  it("编辑工具在 acceptEdits / auto / bypassPermissions：无编辑模式按钮", async () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions"]) {
      const w = mountSheet(toolPerm({ name: "Edit" }), { currentMode: mode });
      expect(w.find(".pm-btn-editmode").exists()).toBe(false);
    }
  });

  it("非编辑工具（Bash）无论模式：无编辑模式按钮", () => {
    const w = mountSheet(toolPerm({ name: "Bash" }), { currentMode: "default" });
    expect(w.find(".pm-btn-editmode").exists()).toBe(false);
  });

  it("子代理请求：显示来源", () => {
    const w = mountSheet(toolPerm({ fromSubagent: { id: "a1", agentName: "Explore" } }));
    expect(w.text()).toContain("来自子代理 Explore");
  });

  it("queueCount > 1：显示排队数", () => {
    const w = mountSheet(toolPerm(), { queueCount: 3 });
    expect(w.text()).toContain("还有 2 条待确认");
  });

  it("无可摘要字段：摘要区不渲染；input=null：JSON 折叠不渲染", () => {
    const w = mountSheet(toolPerm({ input: {} }));
    expect(w.find(".pm-summary").exists()).toBe(false);
    expect(w.find(".pm-json").exists()).toBe(true); // input 非 null 仍有折叠
    const w2 = mountSheet(toolPerm({ input: null }));
    expect(w2.find(".pm-json").exists()).toBe(false);
  });

  it("摘要超长截断 120 字 + …", () => {
    const w = mountSheet(toolPerm({ input: { command: "x".repeat(200) } }));
    const t = w.find(".pm-summary").text();
    expect(t.length).toBe(121);
    expect(t.endsWith("…")).toBe(true);
  });

  // ── plan 形态 ──

  it("plan：markdown 渲染 + 批准 → nextMode=auto", async () => {
    const w = mountSheet(toolPerm({ name: "ExitPlanMode", input: { plan: "**第一步**：跑测试" } }));
    expect(w.text()).toContain("计划待批准");
    expect(w.find(".pm-plan").html()).toContain("<strong>第一步</strong>");
    const btn = w.find(".pm-btn-allow");
    expect(btn.text()).toContain("批准并执行");
    await btn.trigger("click");
    expect(w.emitted("respond")![0]).toEqual(["p1", true, undefined, "auto"]);
  });

  it("plan 拒绝按钮文案 = 继续修改计划", () => {
    const w = mountSheet(toolPerm({ name: "ExitPlanMode", input: { plan: "x" } }));
    expect(w.find(".pm-btn-deny").text()).toContain("继续修改计划");
  });

  // ── question 形态（AskUserQuestion 状态机）──

  function questionPerm(): PermissionRequest {
    return {
      id: "q1",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "用哪个方案？",
            header: "方案",
            options: [
              { label: "方案 A", description: "简单直接" },
              { label: "方案 B", description: "更灵活" },
            ],
          },
          {
            question: "要不要测试？",
            header: "测试",
            multiSelect: true,
            options: [{ label: "单测" }, { label: "集成测试" }],
          },
        ],
      },
    };
  }

  it("question：未答完时提交禁用；答完打包 answers（多选 join）", async () => {
    const w = mountSheet(questionPerm());
    expect(w.text()).toContain("需要澄清");
    const submit = w.find(".pm-btn-allow");
    expect(submit.attributes("disabled")).toBeDefined();

    // 题 1 单选：方案 B
    const q1opts = w.findAll(".pm-q")[0].findAll(".pm-opt");
    await q1opts[1].trigger("click");
    expect(submit.attributes("disabled")).toBeDefined(); // 题 2 未答仍禁用

    // 题 2 多选：单测 + 集成测试
    const q2opts = w.findAll(".pm-q")[1].findAll(".pm-opt");
    await q2opts[0].trigger("click");
    await q2opts[1].trigger("click");
    expect(submit.attributes("disabled")).toBeUndefined();

    await submit.trigger("click");
    expect(w.emitted("respond")![0]).toEqual([
      "q1",
      true,
      { "用哪个方案？": "方案 B", "要不要测试？": "单测, 集成测试" },
    ]);
  });

  it("question 单选切换：点另一项替换选中", async () => {
    const w = mountSheet(questionPerm());
    const q1opts = w.findAll(".pm-q")[0].findAll(".pm-opt");
    await q1opts[0].trigger("click");
    await q1opts[1].trigger("click");
    expect(q1opts[0].classes()).not.toContain("on");
    expect(q1opts[1].classes()).toContain("on");
  });

  it("question 自由文本：与其他选项互斥；空文本不满足提交", async () => {
    const w = mountSheet(questionPerm());
    const q1 = w.findAll(".pm-q")[0];
    await q1.findAll(".pm-opt")[0].trigger("click"); // 先选 A
    await q1.find(".pm-opt-free").trigger("click"); // 切「其他」
    expect(q1.findAll(".pm-opt")[0].classes()).not.toContain("on"); // A 被清
    expect(q1.find(".pm-opt-free").classes()).toContain("on");
    expect(q1.find(".pm-free-input").exists()).toBe(true);

    // 空 freeText：仍禁用（题 1 未满足）
    const submit = w.find(".pm-btn-allow");
    expect(submit.attributes("disabled")).toBeDefined();
    await q1.find(".pm-free-input").setValue("用 C 方案");
    expect(submit.attributes("disabled")).toBeDefined(); // 题 2 还没答
  });

  it("question 跳过：emit respond(id, false) 不带 answers", async () => {
    const w = mountSheet(questionPerm());
    await w.find(".pm-btn-ghost").trigger("click");
    expect(w.emitted("respond")![0]).toEqual(["q1", false]);
  });

  it("question 形态无拒绝表单入口（跳过不带理由）", () => {
    const w = mountSheet(questionPerm());
    expect(w.find(".pm-deny-form").exists()).toBe(false);
    // pm-btn-deny 不渲染（question 用「跳过」）
    expect(w.find(".pm-btn-deny").exists()).toBe(false);
  });

  // ── 复位 ──

  it("新请求到达：拒绝表单与理由复位", async () => {
    const w = mountSheet(toolPerm());
    await w.find(".pm-btn-deny").trigger("click");
    await w.find(".pm-deny-input").setValue("残留理由");
    // 下一条请求进来（id 变化）
    await w.setProps({ permission: toolPerm({ id: "p2", input: { command: "ls" } }) });
    expect(w.find(".pm-deny-form").exists()).toBe(false); // 表单收回
    expect(w.find(".pm-btn-deny").exists()).toBe(true); // 回到按钮行
  });
});

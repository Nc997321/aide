import { describe, it, expect } from "vitest";
import {
  approvedExtras,
  classifyPermissionResponse,
  describeDecisionMismatch,
  toPendingDecision,
} from "./permissionResponse.js";

const base = { session_id: "s1", id: "p1" };

describe("classifyPermissionResponse — 线形状归一", () => {
  it("标签形态四变体逐臂归一：可选字段在场/缺席都不丢信息", () => {
    const rules = [{ effect: "allow", tool: "Edit", matcher: { kind: "tool" } }];
    expect(classifyPermissionResponse({ ...base, response: { kind: "approve" } })).toEqual({
      ok: true,
      decision: { kind: "approve" },
    });
    expect(
      classifyPermissionResponse({
        ...base,
        response: { kind: "approve", nextMode: "auto", sessionRules: rules },
      }),
    ).toEqual({ ok: true, decision: { kind: "approve", nextMode: "auto", sessionRules: rules } });
    expect(classifyPermissionResponse({ ...base, response: { kind: "answer", answers: { q: "a" } } })).toEqual({
      ok: true,
      decision: { kind: "answer", answers: { q: "a" } },
    });
    expect(classifyPermissionResponse({ ...base, response: { kind: "deny" } })).toEqual({
      ok: true,
      decision: { kind: "deny" },
    });
    expect(classifyPermissionResponse({ ...base, response: { kind: "deny", message: "别删目录" } })).toEqual({
      ok: true,
      decision: { kind: "deny", message: "别删目录" },
    });
    expect(classifyPermissionResponse({ ...base, response: { kind: "unanswered" } })).toEqual({
      ok: true,
      decision: { kind: "unanswered" },
    });
    expect(
      classifyPermissionResponse({ ...base, response: { kind: "unanswered", reason: "确认超时，操作未执行" } }),
    ).toEqual({ ok: true, decision: { kind: "unanswered", reason: "确认超时，操作未执行" } });
  });

  it("不可判的形状返回判词而不是抛错（缺 answers 的 answer、未知 kind）", () => {
    const noAnswers = classifyPermissionResponse({ ...base, response: { kind: "answer" } });
    expect(noAnswers.ok).toBe(false);
    expect(noAnswers.ok === false && noAnswers.reason).toContain("answers");

    const unknown = classifyPermissionResponse({ ...base, response: { kind: "bogus" } });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.reason).toContain("kind");
  });

  it("扁平形态归一为 compat_flat：approved 按 truthiness（stdin 面无 schema，逐字节兼容旧行为）", () => {
    expect(classifyPermissionResponse({ ...base, approved: true })).toEqual({
      ok: true,
      decision: { kind: "compat_flat", approved: true },
    });
    expect(classifyPermissionResponse({ ...base, approved: false, message: "不需要" })).toEqual({
      ok: true,
      decision: { kind: "compat_flat", approved: false, message: "不需要" },
    });
    // 缺字段 / 非 boolean：旧行为就是假值 → approved:false，这里逐字节保持
    expect(classifyPermissionResponse({ ...base })).toEqual({
      ok: true,
      decision: { kind: "compat_flat", approved: false },
    });
    expect(classifyPermissionResponse({ ...base, approved: "yes" })).toEqual({
      ok: true,
      decision: { kind: "compat_flat", approved: true },
    });
    expect(classifyPermissionResponse({ ...base, approved: null })).toEqual({
      ok: true,
      decision: { kind: "compat_flat", approved: false },
    });
  });

  it("扁平形态的附随字段原样透传（放行三件套 + 拒绝理由）", () => {
    const rules = [{ effect: "allow", tool: "Write", matcher: { kind: "tool" } }];
    expect(
      classifyPermissionResponse({
        ...base,
        approved: true,
        answers: { q: "a" },
        nextMode: "auto",
        sessionRules: rules,
      }),
    ).toEqual({
      ok: true,
      decision: {
        kind: "compat_flat",
        approved: true,
        answers: { q: "a" },
        nextMode: "auto",
        sessionRules: rules,
      },
    });
  });
});

describe("describeDecisionMismatch — 决策与挂起请求类别的匹配矩阵", () => {
  it("answer 只对 AskUserQuestion 有效", () => {
    const answer = { kind: "answer", answers: { q: "a" } } as const;
    expect(describeDecisionMismatch(answer, "AskUserQuestion")).toBeNull();
    expect(describeDecisionMismatch(answer, "Bash")).toContain("AskUserQuestion");
  });

  it("approve 不能拿来应答问答（会丢作答，必须用 answer）", () => {
    const approve = { kind: "approve" } as const;
    expect(describeDecisionMismatch(approve, "Bash")).toBeNull();
    expect(describeDecisionMismatch(approve, "AskUserQuestion")).toContain("answer");
  });

  it("deny / unanswered 对任意工具都成立；兼容臂永不校验（既有行为不动）", () => {
    expect(describeDecisionMismatch({ kind: "deny" }, "AskUserQuestion")).toBeNull();
    expect(describeDecisionMismatch({ kind: "unanswered" }, "Bash")).toBeNull();
    expect(
      describeDecisionMismatch({ kind: "compat_flat", approved: true, answers: { q: "a" } }, "Write"),
    ).toBeNull();
    expect(describeDecisionMismatch({ kind: "compat_flat", approved: true }, "AskUserQuestion")).toBeNull();
  });
});

describe("approvedExtras — 放行附随只对放行臂有值", () => {
  it("approve 与 compat_flat(approved) 给附随；其余臂一律 null", () => {
    expect(approvedExtras({ kind: "approve", nextMode: "auto" })).toEqual({ nextMode: "auto" });
    expect(approvedExtras({ kind: "compat_flat", approved: true, nextMode: "auto" })).toEqual({
      nextMode: "auto",
    });
    expect(approvedExtras({ kind: "compat_flat", approved: true })).toEqual({});
    expect(approvedExtras({ kind: "compat_flat", approved: false })).toBeNull();
    expect(approvedExtras({ kind: "answer", answers: {} })).toBeNull();
    expect(approvedExtras({ kind: "deny" })).toBeNull();
    expect(approvedExtras({ kind: "unanswered" })).toBeNull();
  });
});

describe("toPendingDecision — 决策 → 应答载荷", () => {
  it("放行臂带 approved:true，answer 额外带 answers", () => {
    expect(toPendingDecision({ kind: "approve" })).toEqual({ approved: true });
    expect(toPendingDecision({ kind: "answer", answers: { q: "a" } })).toEqual({
      approved: true,
      answers: { q: "a" },
    });
  });

  it("deny 不带 deniedBy（缺席即人工语义，与 interrupt/abort 同一编码）", () => {
    expect(toPendingDecision({ kind: "deny" })).toEqual({ approved: false });
    expect(toPendingDecision({ kind: "deny", message: "别删" })).toEqual({
      approved: false,
      message: "别删",
    });
  });

  it("unanswered 带 deniedBy（外框据此换成官方非人工模板）", () => {
    expect(toPendingDecision({ kind: "unanswered" })).toEqual({
      approved: false,
      deniedBy: "unanswered",
    });
    expect(toPendingDecision({ kind: "unanswered", reason: "确认超时" })).toEqual({
      approved: false,
      deniedBy: "unanswered",
      message: "确认超时",
    });
  });

  it("compat_flat 原样透传（不追加 deniedBy——旧路径语义一个字不改）", () => {
    expect(toPendingDecision({ kind: "compat_flat", approved: false, message: "不需要" })).toEqual({
      approved: false,
      message: "不需要",
    });
    expect(toPendingDecision({ kind: "compat_flat", approved: true, answers: { q: "a" } })).toEqual({
      approved: true,
      answers: { q: "a" },
    });
  });
});

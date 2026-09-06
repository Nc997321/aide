import { describe, it, expect } from "vitest";
import {
  EDIT_TOOL_NAMES,
  PLAN_TOOL_NAME,
  QUESTION_TOOL_NAME,
  canEnterAutoMode,
  canSubmitQuestions,
  isEditToolName,
  judgePermissionKind,
  packQuestionAnswers,
  parseQuestions,
  permissionInputJson,
  permissionInputRows,
  permissionSummaryLine,
  toggleQuestionSelection,
  type QuestionSpec,
} from "./permissionShape";

// ── 形态判定 ──

describe("judgePermissionKind", () => {
  it("ExitPlanMode → plan；AskUserQuestion → question", () => {
    expect(judgePermissionKind("ExitPlanMode")).toBe("plan");
    expect(judgePermissionKind("AskUserQuestion")).toBe("question");
    expect(PLAN_TOOL_NAME).toBe("ExitPlanMode");
    expect(QUESTION_TOOL_NAME).toBe("AskUserQuestion");
  });

  it("其余（含空）→ tool", () => {
    expect(judgePermissionKind("Bash")).toBe("tool");
    expect(judgePermissionKind("")).toBe("tool");
    expect(judgePermissionKind(undefined)).toBe("tool");
    expect(judgePermissionKind(null)).toBe("tool");
  });
});

// ── AskUserQuestion：解析 / 选择 / 打包 ──

const qs = (): QuestionSpec[] => [
  {
    question: "用哪个方案？",
    header: "方案",
    multiSelect: false,
    options: [
      { label: "方案 A", description: "保守" },
      { label: "方案 B", description: "激进" },
    ],
  },
  {
    question: "要不要测试？",
    header: "测试",
    multiSelect: true,
    options: [
      { label: "单测", description: "" },
      { label: "集成测试", description: "" },
    ],
  },
];

describe("parseQuestions", () => {
  it("解析 input.questions", () => {
    expect(parseQuestions({ questions: qs() })).toEqual(qs());
  });

  it("形状不对返回 []（缺字段 / 非数组 / null）", () => {
    expect(parseQuestions({})).toEqual([]);
    expect(parseQuestions({ questions: "not-array" })).toEqual([]);
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions(undefined)).toEqual([]);
  });
});

describe("toggleQuestionSelection", () => {
  it("单选：覆盖当前选择", () => {
    expect(toggleQuestionSelection(["A"], "B")).toEqual(["B"]);
    expect(toggleQuestionSelection([], "A")).toEqual(["A"]);
  });

  it("多选：增删切换、保持其余", () => {
    expect(toggleQuestionSelection(["单测"], "集成测试", true)).toEqual(["单测", "集成测试"]);
    expect(toggleQuestionSelection(["单测", "集成测试"], "单测", true)).toEqual(["集成测试"]);
  });
});

describe("canSubmitQuestions", () => {
  it("零问题 → false（提交门关死）", () => {
    expect(canSubmitQuestions([], {}, {}, {})).toBe(false);
  });

  it("有未答题 → false；全答 → true", () => {
    const questions = qs();
    const selections = { 0: ["方案 B"] } as Record<number, string[]>;
    // 第 2 题未答
    expect(canSubmitQuestions(questions, selections, {}, {})).toBe(false);
    expect(canSubmitQuestions(questions, { ...selections, 1: ["单测"] }, {}, {})).toBe(true);
    // 多选 join 后也是已答
    expect(canSubmitQuestions(questions, { ...selections, 1: ["单测", "集成测试"] }, {}, {})).toBe(true);
  });

  it("自由文本：空白不算答、非空白算答（与选项互斥）", () => {
    const questions = qs();
    expect(canSubmitQuestions(questions, { 0: ["方案 B"], 1: [] }, { 1: "   " }, { 1: true })).toBe(false);
    expect(canSubmitQuestions(questions, { 0: ["方案 B"], 1: [] }, { 1: "都要" }, { 1: true })).toBe(true);
  });
});

describe("packQuestionAnswers", () => {
  it("question 文本 → 选项 label（多选 join ", "）/ 自由文本 trim", () => {
    const questions = qs();
    const selections = { 0: ["方案 B"], 1: ["单测", "集成测试"] };
    expect(packQuestionAnswers(questions, selections, {}, {})).toEqual({
      "用哪个方案？": "方案 B",
      "要不要测试？": "单测, 集成测试",
    });
    expect(packQuestionAnswers(questions, { 0: [], 1: [] }, { 0: "自己写" }, { 0: true })).toEqual({
      "用哪个方案？": "自己写",
      "要不要测试？": "",
    });
  });
});

// ── 进入自动模式判定 ──

describe("EDIT_TOOL_NAMES / isEditToolName / canEnterAutoMode", () => {
  it("四个内置编辑工具", () => {
    expect([...EDIT_TOOL_NAMES].sort()).toEqual(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
    expect(isEditToolName("Edit")).toBe(true);
    expect(isEditToolName("Bash")).toBe(false);
    expect(isEditToolName(undefined)).toBe(false);
    expect(isEditToolName(null)).toBe(false);
  });

  it("编辑工具 + 手动模式 → true；空串模式（清单未就位）按手动处理", () => {
    expect(canEnterAutoMode("Edit", "manual")).toBe(true);
    expect(canEnterAutoMode("Write", "")).toBe(true);
    expect(canEnterAutoMode("Write", undefined)).toBe(true);
  });

  it("已在自动/最高权限模式 → false（弹窗属 ask 规则例外，选项隐藏）", () => {
    for (const mode of ["auto", "bypassPermissions"]) {
      expect(canEnterAutoMode("Edit", mode)).toBe(false);
    }
  });

  it("非编辑工具恒 false（不论模式）", () => {
    expect(canEnterAutoMode("Bash", "manual")).toBe(false);
  });
});

// ── 工具输入展示 ──

describe("permissionInputRows", () => {
  it("Bash / Write / Edit / WebFetch 拆标签+值", () => {
    expect(permissionInputRows("Bash", { command: "ls -la" })).toEqual([{ label: "命令", value: "ls -la" }]);
    expect(permissionInputRows("Write", { file_path: "src/a.ts" })).toEqual([{ label: "文件", value: "src/a.ts" }]);
    expect(permissionInputRows("Edit", { file_path: "src/a.ts" })).toEqual([{ label: "文件", value: "src/a.ts" }]);
    expect(permissionInputRows("WebFetch", { url: "https://x.com" })).toEqual([{ label: "URL", value: "https://x.com" }]);
  });

  it("认不出的工具名返回 null（调用方退原始 JSON）", () => {
    expect(permissionInputRows("Glob", { pattern: "*.ts" })).toBeNull();
  });

  it("字段缺失退空串不炸", () => {
    expect(permissionInputRows("Bash", {})).toEqual([{ label: "命令", value: "" }]);
    expect(permissionInputRows("Bash", null)).toEqual([{ label: "命令", value: "" }]);
  });
});

describe("permissionSummaryLine", () => {
  it("按字段优先级取第一个 string 字段", () => {
    expect(permissionSummaryLine({ command: "cargo test" })).toBe("cargo test");
    expect(permissionSummaryLine({ file_path: "src/a.ts", command: "" })).toBe("src/a.ts"); // 空串跳过，取下一字段
    expect(permissionSummaryLine({ pattern: "*.ts" })).toBe("*.ts");
    expect(permissionSummaryLine({ url: "https://x.com" })).toBe("https://x.com");
  });

  it("超长截断加省略号；maxLen 可调", () => {
    const long = "a".repeat(150);
    expect(permissionSummaryLine({ command: long })).toBe("a".repeat(120) + "…");
    expect(permissionSummaryLine({ command: long }, 10)).toBe("a".repeat(10) + "…");
    expect(permissionSummaryLine({ command: "a".repeat(120) })).toBe("a".repeat(120)); // 恰好不截
  });

  it("无命中字段 / 非对象 → 空串", () => {
    expect(permissionSummaryLine({ foo: "bar" })).toBe("");
    expect(permissionSummaryLine({ command: 42 })).toBe("");
    expect(permissionSummaryLine(null)).toBe("");
    expect(permissionSummaryLine("text")).toBe("");
  });
});

describe("permissionInputJson", () => {
  it("对象 → pretty JSON", () => {
    expect(permissionInputJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("string 直返；截断由调用方自理", () => {
    expect(permissionInputJson("raw")).toBe("raw");
    expect(permissionInputJson({ a: 1 }).slice(0, 4)).toBe('{\n  ');
  });

  it("序列化异常退 String()", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => permissionInputJson(cyclic)).not.toThrow();
    expect(typeof permissionInputJson(cyclic)).toBe("string");
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

const mocks = vi.hoisted(() => ({
  pathTypes: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    pathTypes: mocks.pathTypes,
  },
}));

import {
  useInlineMention,
  findMentionTokens,
  joinPath,
  isAbsoluteishPath,
  resolveCandidate,
} from "./useInlineMention";

describe("findMentionTokens", () => {
  it("匹配行首 @token + 空格", () => {
    expect(findMentionTokens("@src/a.ts ")).toEqual([
      { token: "src/a.ts", atIdx: 0, endPos: 10 },
    ]);
  });

  it("匹配空格后的 @token", () => {
    expect(findMentionTokens("hi @src/a.ts ")).toEqual([
      { token: "src/a.ts", atIdx: 3, endPos: 13 },
    ]);
  });

  it("连续多个 @token 全部命中（不消耗前导空格）", () => {
    const r = findMentionTokens("@a.ts @b.ts ");
    expect(r).toHaveLength(2);
    expect(r[0].token).toBe("a.ts");
    expect(r[1].token).toBe("b.ts");
    expect(r[1].atIdx).toBe(6);
  });

  it("无尾随空格不匹配（未触发）", () => {
    expect(findMentionTokens("@src/a.ts")).toEqual([]);
  });

  it("不误吞邮箱 a@b.com", () => {
    expect(findMentionTokens("see a@b.com ")).toEqual([]);
  });

  it("@ 前为非空白字符不匹配", () => {
    expect(findMentionTokens("x@y ")).toEqual([]);
  });

  it("换行后行首 @token 命中（边界含换行）", () => {
    const r = findMentionTokens("x\n@p.ts ");
    expect(r).toEqual([{ token: "p.ts", atIdx: 2, endPos: 8 }]);
  });

  it("@@ 双 @ 不匹配", () => {
    expect(findMentionTokens("@@a.ts ")).toEqual([]);
  });
});

describe("joinPath", () => {
  it("按 base 分隔符拼接（正斜杠 base）", () => {
    expect(joinPath("C:/repo", "src/a.ts")).toBe("C:/repo/src/a.ts");
  });

  it("按 base 分隔符拼接（反斜杠 base，rel 内部统一为反斜杠）", () => {
    expect(joinPath("C:\\repo", "src/a.ts")).toBe("C:\\repo\\src\\a.ts");
  });

  it("剥前/后导分隔符", () => {
    expect(joinPath("C:/repo/", "/x.ts")).toBe("C:/repo/x.ts");
  });

  it("无 base 原样返回", () => {
    expect(joinPath("", "x.ts")).toBe("x.ts");
  });

  it("空 rel 返回 base 去尾分隔符", () => {
    expect(joinPath("C:/repo/", "")).toBe("C:/repo");
  });
});

describe("isAbsoluteishPath", () => {
  it.each([
    ["C:\\x", true],
    ["D:/repo/a", true],
    ["/usr/bin", true],
    ["\\\\server\\share", true],
    ["src/a.ts", false],
    ["a.ts", false],
  ])("%s -> %s", (p, expected) => {
    expect(isAbsoluteishPath(p)).toBe(expected);
  });
});

describe("resolveCandidate", () => {
  it("相对 token 拼 workspace", () => {
    expect(resolveCandidate("src/a.ts", "C:/repo")).toBe("C:/repo/src/a.ts");
  });

  it("绝对 token 不拼 workspace", () => {
    expect(resolveCandidate("C:\\x\\y.ts", "C:/repo")).toBe("C:\\x\\y.ts");
  });

  it("相对 token 无 workspace 用原文", () => {
    expect(resolveCandidate("src/a.ts", "")).toBe("src/a.ts");
  });
});

describe("useInlineMention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // vitest DOM 环境未暴露 InputEvent 构造器，而 onInput 只读 isComposing。
  const makeEvent = (isComposing = false): InputEvent =>
    ({ isComposing } as InputEvent);

  it("手打 @path+空格：命中则转芯片并从文本移除", async () => {
    mocks.pathTypes.mockResolvedValue(["file"]);
    const inputText = ref("@src/utils/paste.ts ");
    const addMention = vi.fn();
    const { onInput } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    onInput(makeEvent());
    await nextTick();
    await nextTick(); // 让 async scanAndConvert 跑完

    expect(mocks.pathTypes).toHaveBeenCalledWith(["C:/repo/src/utils/paste.ts"]);
    expect(addMention).toHaveBeenCalledWith("C:/repo/src/utils/paste.ts", false, undefined);
    expect(inputText.value).toBe("");
  });

  it("手打 @path:12-48：剥掉行号后缀再校验，芯片带回区间", async () => {
    mocks.pathTypes.mockResolvedValue(["file"]);
    const inputText = ref("@src/a.ts:12-48 ");
    const addMention = vi.fn();
    const { onInput } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    onInput(makeEvent());
    await nextTick();
    await nextTick();

    // path_types 只认真实路径——行号后缀必须先剥掉，否则校验必 misses
    expect(mocks.pathTypes).toHaveBeenCalledWith(["C:/repo/src/a.ts"]);
    expect(addMention).toHaveBeenCalledWith("C:/repo/src/a.ts", false, { start: 12, end: 48 });
    expect(inputText.value).toBe("");
  });

  it("不存在的路径保留纯文本、不转芯片", async () => {
    mocks.pathTypes.mockResolvedValue(["none"]);
    const inputText = ref("@nope/missing.ts ");
    const addMention = vi.fn();
    const { onInput } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    onInput(makeEvent());
    await nextTick();
    await nextTick();

    expect(addMention).not.toHaveBeenCalled();
    expect(inputText.value).toBe("@nope/missing.ts ");
  });

  it("多 token 一次批量 pathTypes", async () => {
    mocks.pathTypes.mockResolvedValue(["file", "dir"]);
    const inputText = ref("@a.ts @b ");
    const addMention = vi.fn();
    const { onInput } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    onInput(makeEvent());
    await nextTick();
    await nextTick();

    expect(mocks.pathTypes).toHaveBeenCalledWith(["C:/repo/a.ts", "C:/repo/b"]);
    expect(addMention).toHaveBeenNthCalledWith(1, "C:/repo/a.ts", false, undefined);
    expect(addMention).toHaveBeenNthCalledWith(2, "C:/repo/b", true, undefined);
    expect(inputText.value).toBe("");
  });

  it("IME 组合输入期间不转换", async () => {
    mocks.pathTypes.mockResolvedValue(["file"]);
    const inputText = ref("@a.ts ");
    const addMention = vi.fn();
    const { onInput } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    onInput(makeEvent(true));
    await nextTick();
    await nextTick();

    expect(mocks.pathTypes).not.toHaveBeenCalled();
    expect(addMention).not.toHaveBeenCalled();
    expect(inputText.value).toBe("@a.ts ");
  });

  it("scan() 主动触发：模拟 paste/drop 程序化插入 @path 文本后立即转换", async () => {
    // 粘贴/拖入走 insertAtCursor 程序化改 inputText，不触发 @input；
    // 调用方在插入后主动调 scan() 唤醒检测器。
    mocks.pathTypes.mockResolvedValue(["file"]);
    const inputText = ref("");
    const addMention = vi.fn();
    const { scan } = useInlineMention({
      inputText,
      textareaEl: ref(undefined),
      workspacePath: () => "C:/repo",
      addMention,
    });

    inputText.value = "@src/a.ts "; // 模拟 insertAtCursor 插入
    await scan();

    expect(mocks.pathTypes).toHaveBeenCalledWith(["C:/repo/src/a.ts"]);
    expect(addMention).toHaveBeenCalledWith("C:/repo/src/a.ts", false, undefined);
    expect(inputText.value).toBe("");
  });
});
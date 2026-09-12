import { describe, it, expect } from "vitest";
import {
  TAIL_MAX_CHARS,
  CHUNK_CHARS,
  STAGGER_CAP_MS,
  lastBlockBoundary,
  hasBlockMarkdown,
  stripInlineMarks,
  splitStreamingText,
  toAnimatedChunks,
} from "./streamSplit";

describe("lastBlockBoundary（围栏外的最后一个空行）", () => {
  it("没有空行 → 0", () => {
    expect(lastBlockBoundary("一段还在写的正文")).toBe(0);
    expect(lastBlockBoundary("")).toBe(0);
  });

  it("正文中间的空行 → 返回该空行的结束下标", () => {
    // 切点在空行的换行符之后，即 "第一段\n\n"
    expect(lastBlockBoundary("第一段\n\n第二段")).toBe("第一段\n\n".length);
  });

  it("多个空行 → 取最后一个", () => {
    expect(lastBlockBoundary("甲\n\n乙\n\n丙")).toBe("甲\n\n乙\n\n".length);
  });

  it("连续的多个空行按最后一个算", () => {
    expect(lastBlockBoundary("甲\n\n\n\n乙")).toBe("甲\n\n\n\n".length);
  });

  it("正文以空行收尾 → 返回末尾", () => {
    const text = "甲\n\n";
    expect(lastBlockBoundary(text)).toBe(text.length);
  });

  it("围栏内的空行不算段落边界", () => {
    // 代码块中间的空行若被当成边界，代码块会被劈成两个 <pre>
    expect(lastBlockBoundary("```\na\n\nb\n```")).toBe(0);
  });

  it("围栏关闭之后的空行算边界", () => {
    const text = "```\na\n\nb\n```\n\n尾巴";
    expect(lastBlockBoundary(text)).toBe(text.length - 2);
  });

  it("波浪号围栏同样识别", () => {
    expect(lastBlockBoundary("~~~\na\n\nb\n~~~")).toBe(0);
  });

  it("缩进不超过 3 空格仍算围栏", () => {
    expect(lastBlockBoundary("   ```\na\n\nb\n   ```")).toBe(0);
  });

  it("缩进 4 空格是代码块不是围栏 → 空行仍是边界", () => {
    // CommonMark：4 空格缩进是 indented code block，不是围栏
    expect(lastBlockBoundary("    ```\na\n\nb")).toBe("    ```\na\n\n".length);
  });

  it("未闭合的围栏一路吞掉后面的空行", () => {
    // 围栏开在切点之后，围栏内的空行不再算边界
    expect(lastBlockBoundary("甲\n\n```\n乙\n\n丙")).toBe("甲\n\n".length);
  });
});

describe("hasBlockMarkdown（块级标记 → 退回 markdown）", () => {
  it.each([
    ["代码围栏", "```rust\nlet a = 1;"],
    ["无序列表", "- 第一点"],
    ["星号列表", "* 第一点"],
    ["有序列表", "1. 第一点"],
    ["标题", "## 小标题"],
    ["引用", "> 引一句"],
    ["表格", "| 甲 | 乙 |"],
    ["分隔线", "---"],
    ["列表出现在第二行", "前言\n- 第一点"],
  ])("%s → true", (_name, text) => {
    expect(hasBlockMarkdown(text)).toBe(true);
  });

  it.each([
    ["纯散文", "这是一段普通的正文，没有块级标记。"],
    ["行内粗体", "这里是 **重点** 内容"],
    ["行内代码", "用 `pnpm build` 构建"],
    ["词内下划线不受影响", "变量名 snake_case_name 保留"],
    ["小数不是有序列表", "涨了 1.5 倍"],
    ["带空格的星号不是列表", "a * b 乘法"],
  ])("%s → false", (_name, text) => {
    expect(hasBlockMarkdown(text)).toBe(false);
  });
});

describe("stripInlineMarks（藏起行内标记符号）", () => {
  it("去掉粗体符号保留内容", () => {
    expect(stripInlineMarks("这里是 **重点** 内容")).toBe("这里是 重点 内容");
  });

  it("去掉反引号保留内容", () => {
    expect(stripInlineMarks("用 `pnpm build` 构建")).toBe("用 pnpm build 构建");
  });

  it("去掉删除线符号", () => {
    expect(stripInlineMarks("~~作废~~")).toBe("作废");
  });

  it("不误伤标识符里的下划线", () => {
    expect(stripInlineMarks("snake_case_name")).toBe("snake_case_name");
  });

  it("不误伤单个星号", () => {
    expect(stripInlineMarks("a * b")).toBe("a * b");
  });
});

describe("splitStreamingText（分段）", () => {
  it("首段还没有空行 → 全部是尾巴，可动画", () => {
    const r = splitStreamingText("第一段还在写");
    expect(r.frozen).toBe("");
    expect(r.tail).toBe("第一段还在写");
    expect(r.tailAnimated).toBe(true);
  });

  it("跨过段落边界 → 前缀定稿、尾巴是新的那段", () => {
    const r = splitStreamingText("第一段。\n\n第二段还在");
    expect(r.frozen).toBe("第一段。\n\n");
    expect(r.tail).toBe("第二段还在");
    expect(r.tailAnimated).toBe(true);
  });

  it("尾巴刚好写完（以空行收尾）→ 尾巴为空且不可动画", () => {
    const r = splitStreamingText("第一段。\n\n");
    expect(r.frozen).toBe("第一段。\n\n");
    expect(r.tail).toBe("");
    expect(r.tailAnimated).toBe(false);
  });

  it("空文本 → 无可动画内容", () => {
    const r = splitStreamingText("");
    expect(r).toEqual({ frozen: "", tail: "", tailAnimated: false });
  });

  it("尾巴含代码围栏 → 不可动画（退回 markdown）", () => {
    const r = splitStreamingText("前言。\n\n```rust\nlet a = 1;");
    expect(r.frozen).toBe("前言。\n\n");
    expect(r.tailAnimated).toBe(false);
  });

  it("尾巴含列表 → 不可动画", () => {
    expect(splitStreamingText("前言。\n\n- 第一点").tailAnimated).toBe(false);
  });

  it(`尾巴正好 ${TAIL_MAX_CHARS} 字 → 可动画`, () => {
    const r = splitStreamingText("x".repeat(TAIL_MAX_CHARS));
    expect(r.tail.length).toBe(TAIL_MAX_CHARS);
    expect(r.tailAnimated).toBe(true);
  });

  it(`尾巴超出 ${TAIL_MAX_CHARS} 字 → 不可动画（span 数会失控）`, () => {
    const r = splitStreamingText("x".repeat(TAIL_MAX_CHARS + 1));
    expect(r.tailAnimated).toBe(false);
  });

  it("前缀可以任意长，只有尾巴受长度限制", () => {
    const r = splitStreamingText("x".repeat(TAIL_MAX_CHARS * 3) + "\n\n短的尾巴");
    expect(r.tailAnimated).toBe(true);
    expect(r.frozen.length).toBe(TAIL_MAX_CHARS * 3 + 2);
  });

  it("前缀 + 尾巴拼起来恒等于原文（不丢字）", () => {
    for (const t of ["", "甲", "甲\n\n乙", "```\na\n\nb\n```", "甲\n\n- 列表", "尾"]) {
      const r = splitStreamingText(t);
      expect(r.frozen + r.tail).toBe(t);
    }
  });
});

describe("toAnimatedChunks（分块 + 错峰）", () => {
  it("空串 → 无块（上游尾巴清空时走这条）", () => {
    expect(toAnimatedChunks("")).toEqual([]);
  });

  it("按 CHUNK_CHARS 切块，末块可短于粒度", () => {
    expect(toAnimatedChunks("甲乙丙").map((c) => c.text)).toEqual(["甲乙", "丙"]);
  });

  it("块少时用基础错峰间隔", () => {
    const [a, b] = toAnimatedChunks("甲乙丙丁");
    expect(a.delay).toBe(0);
    expect(b.delay).toBe(12);
  });

  it("块多时错峰按上限压缩，总摊开不超过 STAGGER_CAP_MS", () => {
    const chunks = toAnimatedChunks("x".repeat(CHUNK_CHARS * 40)); // 40 块
    expect(chunks.length).toBe(40);
    expect(chunks[0].delay).toBe(0);
    // 末块延迟 = 39 × (200/40) ≈ 195ms，不越上限
    expect(chunks.at(-1)!.delay).toBeLessThanOrEqual(STAGGER_CAP_MS);
    expect(chunks.at(-1)!.delay).toBeGreaterThan(0);
  });

  it("单块 → 无错峰（延迟 0）", () => {
    expect(toAnimatedChunks("甲")).toEqual([{ text: "甲", delay: 0 }]);
  });
});

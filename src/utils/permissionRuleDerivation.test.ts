import { describe, it, expect } from "vitest";
import type { PermissionRule } from "@/types/permissions";
import {
  deriveRememberRule,
  describeRememberRule,
  stripTrailingNumericArg,
} from "./permissionRuleDerivation";

/** 构造一条 Bash 前缀 allow 规则（或 tool 级）。 */
function allowRule(value: string, toolLevel = false): PermissionRule {
  return {
    id: `r-${value}`,
    scope: "user",
    order: 0,
    effect: "allow",
    tool: "Bash",
    matcher: toolLevel
      ? { kind: "tool" }
      : { kind: "bash", mode: "prefix", value },
    source: { label: "user", readOnly: false },
  };
}

/** 全部 matcher 数组（方案 D：链式命令可一次记住多段）。 */
function mats(command: string, rules: readonly PermissionRule[] = []): unknown[] {
  return deriveRememberRule("Bash", { command }, rules).map((d) => d.matcher);
}

/** 单个 matcher（单条场景断言用）。 */
function oneMatcher(tool: string, input: unknown): unknown {
  const drafts = deriveRememberRule(tool, input);
  expect(drafts).toHaveLength(1);
  return drafts[0].matcher;
}

describe("deriveRememberRule Bash 前缀推导", () => {
  it("无控制符的命令→整条作前缀", () => {
    expect(mats("pnpm test --runInBand")).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm test --runInBand" },
    ]);
  });

  it("在未引用控制符处截断，链式命令每段各记一条", () => {
    expect(mats("pnpm test && npm run build")).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm test" },
      { kind: "bash", mode: "prefix", value: "npm run build" },
    ]);
    expect(mats("echo a; rm b")).toEqual([
      { kind: "bash", mode: "prefix", value: "echo a" },
      { kind: "bash", mode: "prefix", value: "rm b" },
    ]);
  });

  it("引号内的控制符不截断", () => {
    expect(mats("git commit -m 'fix: a; b'")).toEqual([
      { kind: "bash", mode: "prefix", value: "git commit -m 'fix: a; b'" },
    ]);
    expect(mats('echo "a|b"')).toEqual([
      { kind: "bash", mode: "prefix", value: 'echo "a|b"' },
    ]);
  });

  it("去前导空白；空命令或截断后为空→空数组", () => {
    expect(mats("   pnpm test")).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm test" },
    ]);
    expect(deriveRememberRule("Bash", { command: "" })).toEqual([]);
    expect(deriveRememberRule("Bash", { command: "&& echo hi" })).toEqual([]);
    expect(deriveRememberRule("Bash", {})).toEqual([]);
  });

  it("重定向 fd 吸收：2>/2>&1/1> 的 fd 数字不进前缀", () => {
    // 真实 bug：`ls dir 2>/dev/null` 点「记住」存出 `ls dir 2`，永远匹配不到 `ls dir`
    expect(mats("ls ~/.aide/claude/plugins/cache/ 2>/dev/null")).toEqual([
      { kind: "bash", mode: "prefix", value: "ls ~/.aide/claude/plugins/cache/" },
    ]);
    // 记住侧剥离 fd：`pnpm vue-tsc --noEmit` + 未覆盖的管道段 `tail -20` 各记一条
    expect(mats("pnpm vue-tsc --noEmit 2>&1 | tail -20")).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm vue-tsc --noEmit" },
      { kind: "bash", mode: "prefix", value: "tail -20" },
    ]);
    expect(mats("cargo test --lib 1>/tmp/out")).toEqual([
      { kind: "bash", mode: "prefix", value: "cargo test --lib" },
    ]);
    expect(mats("sort 0<in.txt")).toEqual([
      { kind: "bash", mode: "prefix", value: "sort" },
    ]);
  });

  it("fd 吸收的边界：数字是单词一部分或与操作符间有空格时不剥", () => {
    // `foo2` 是一个词，2 是参数（bash 语义同）
    expect(mats("echo foo2>file")).toEqual([
      { kind: "bash", mode: "prefix", value: "echo foo2" },
    ]);
    // `2 >` 有空格，2 是参数不是 fd
    expect(mats("cmd 2 > file")).toEqual([
      { kind: "bash", mode: "prefix", value: "cmd 2" },
    ]);
  });

  it("纯重定向命令截断后为空→空数组", () => {
    expect(deriveRememberRule("Bash", { command: "2>/dev/null" })).toEqual([]);
  });

  it("命令缺失/类型错→空数组", () => {
    expect(deriveRememberRule("Bash", undefined)).toEqual([]);
    expect(deriveRememberRule("Bash", { command: 123 })).toEqual([]);
  });
});

describe("deriveRememberRule 链式命令感知现有规则", () => {
  it("第一段已被现有前缀规则覆盖→记住未覆盖的后续段", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(
      mats("pnpm vitest run src/utils/permissionModeCycle.test.ts | grep -i allow", rules),
    ).toEqual([{ kind: "bash", mode: "prefix", value: "grep -i allow" }]);
  });

  it("无现有规则→记住全部段（每段一条）", () => {
    expect(mats("pnpm test && npm run build", [])).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm test" },
      { kind: "bash", mode: "prefix", value: "npm run build" },
    ]);
  });

  it("多段命令记住所有未覆盖段", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(mats("pnpm vitest run a.ts | grep x | wc -l", rules)).toEqual([
      { kind: "bash", mode: "prefix", value: "grep x" },
      { kind: "bash", mode: "prefix", value: "wc -l" },
    ]);
  });

  it("全部段已被覆盖（异常态）→回退第一段", () => {
    const rules = [allowRule("pnpm test"), allowRule("grep")];
    expect(mats("pnpm test | grep x", rules)).toEqual([
      { kind: "bash", mode: "prefix", value: "pnpm test" },
    ]);
  });

  it("引号内管道不算分隔符", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(mats("pnpm vitest run 'a|b' | grep x", rules)).toEqual([
      { kind: "bash", mode: "prefix", value: "grep x" },
    ]);
  });
});

describe("deriveRememberRule 文件工具→文件夹", () => {
  it("Write/Edit/MultiEdit 取 dirname 作 folder", () => {
    expect(oneMatcher("Write", { file_path: "C:/proj/src/a.ts" })).toEqual({
      kind: "path",
      field: "file_path",
      folder: "C:/proj/src",
    });
    expect(oneMatcher("Edit", { file_path: "/home/u/repo/b.rs" })).toEqual({
      kind: "path",
      field: "file_path",
      folder: "/home/u/repo",
    });
    expect(oneMatcher("MultiEdit", { file_path: "src/c.ts" })).toEqual({
      kind: "path",
      field: "file_path",
      folder: "src",
    });
  });

  it("NotebookEdit 用 notebook_path 字段", () => {
    expect(oneMatcher("NotebookEdit", { notebook_path: "/nb/x.ipynb" })).toEqual({
      kind: "path",
      field: "notebook_path",
      folder: "/nb",
    });
  });

  it("路径为空 / 无父目录→空数组（避免任意路径过宽规则）", () => {
    expect(deriveRememberRule("Write", { file_path: "" })).toEqual([]);
    expect(deriveRememberRule("Write", { file_path: "foo.ts" })).toEqual([]);
    expect(deriveRememberRule("Write", {})).toEqual([]);
  });
});

describe("deriveRememberRule WebFetch→完整 URL equals", () => {
  it("取完整 url 作 field equals", () => {
    expect(oneMatcher("WebFetch", { url: "https://example.com/a/b" })).toEqual({
      kind: "field",
      field: "url",
      equals: "https://example.com/a/b",
    });
  });
  it("url 为空→空数组", () => {
    expect(deriveRememberRule("WebFetch", { url: "" })).toEqual([]);
    expect(deriveRememberRule("WebFetch", {})).toEqual([]);
  });
});

describe("deriveRememberRule 其它工具→工具级", () => {
  it("未知/只读工具→tool 级任意调用", () => {
    expect(deriveRememberRule("Read", { file_path: "/a/b" })).toEqual([
      { effect: "allow", tool: "Read", matcher: { kind: "tool" } },
    ]);
    expect(deriveRememberRule("SomeMcpTool", { x: 1 })).toEqual([
      { effect: "allow", tool: "SomeMcpTool", matcher: { kind: "tool" } },
    ]);
  });
});

describe("describeRememberRule 描述行", () => {
  it("Bash 前缀 + 项目本地", () => {
    const drafts = deriveRememberRule("Bash", { command: "pnpm test" });
    expect(describeRememberRule(drafts, "local")).toBe(
      '将记住到本项目本地：执行以 "pnpm test" 开头的命令时始终允许',
    );
  });
  it("文件工具 + 用户全局回退", () => {
    const drafts = deriveRememberRule("Write", { file_path: "/a/b/c.ts" });
    expect(describeRememberRule(drafts, "user")).toBe(
      "将记住到用户全局：编辑 /a/b 及其子目录下的文件时始终允许",
    );
  });
  it("WebFetch url equals", () => {
    const drafts = deriveRememberRule("WebFetch", { url: "https://x.com/p" });
    expect(describeRememberRule(drafts, "local")).toBe(
      '将记住到本项目本地：对 url 为 "https://x.com/p" 的调用时始终允许',
    );
  });
  it("工具级", () => {
    const drafts = deriveRememberRule("Read", {});
    expect(describeRememberRule(drafts, "local")).toBe(
      "将记住到本项目本地：调用该工具时始终允许",
    );
  });
  it("多条（链式命令）逐条列出", () => {
    const drafts = deriveRememberRule("Bash", { command: "pnpm test && npm run build" });
    expect(drafts).toHaveLength(2);
    expect(describeRememberRule(drafts, "local")).toBe(
      '将记住到本项目本地（2 条规则）：1. 执行以 "pnpm test" 开头的命令时始终允许；2. 执行以 "npm run build" 开头的命令时始终允许',
    );
  });
});

describe("stripTrailingNumericArg 数字参数透明化", () => {
  it("`-8` 选项+数值一体→去掉", () => {
    expect(stripTrailingNumericArg("tail -8")).toBe("tail");
    expect(stripTrailingNumericArg("tail -8 ")).toBe("tail");
  });
  it("`--lines=8` → 去掉", () => {
    expect(stripTrailingNumericArg("tail --lines=8")).toBe("tail");
  });
  it("`-n 8` 数值前是选项 flag→两个一起去掉", () => {
    expect(stripTrailingNumericArg("head -n 8")).toBe("head");
    expect(stripTrailingNumericArg("grep -m 20")).toBe("grep");
  });
  it("裸数字 token（vitest 过滤器）→不简化", () => {
    expect(stripTrailingNumericArg("npx vitest run 2")).toBeNull();
    expect(stripTrailingNumericArg("tail 8")).toBeNull();
  });
  it("非数字参数→不简化", () => {
    expect(stripTrailingNumericArg("tail -f")).toBeNull();
    expect(stripTrailingNumericArg("git checkout main")).toBeNull();
    expect(stripTrailingNumericArg("--reporter=verbose")).toBeNull();
  });
  it("太短（少于两个 token）→不简化", () => {
    expect(stripTrailingNumericArg("tail")).toBeNull();
    expect(stripTrailingNumericArg("")).toBeNull();
  });
});

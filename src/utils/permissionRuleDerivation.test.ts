import { describe, it, expect } from "vitest";
import type { PermissionRule } from "@/types/permissions";
import { deriveRememberRule, describeRememberRule } from "./permissionRuleDerivation";

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

describe("deriveRememberRule Bash 前缀推导", () => {
  it("无控制符的命令→整条作前缀", () => {
    expect(deriveRememberRule("Bash", { command: "pnpm test --runInBand" })).toEqual({
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test --runInBand" },
    });
  });

  it("在首个未引用控制符处截断", () => {
    expect(deriveRememberRule("Bash", { command: "pnpm test && npm run build" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "pnpm test",
    });
    expect(deriveRememberRule("Bash", { command: "echo a; rm b" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "echo a",
    });
  });

  it("引号内的控制符不截断", () => {
    expect(deriveRememberRule("Bash", { command: "git commit -m 'fix: a; b'" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "git commit -m 'fix: a; b'",
    });
    expect(deriveRememberRule("Bash", { command: 'echo "a|b"' })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: 'echo "a|b"',
    });
  });

  it("去前导空白；空命令或截断后为空→null", () => {
    expect(deriveRememberRule("Bash", { command: "   pnpm test" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "pnpm test",
    });
    expect(deriveRememberRule("Bash", { command: "" })).toBeNull();
    expect(deriveRememberRule("Bash", { command: "&& echo hi" })).toBeNull();
    expect(deriveRememberRule("Bash", {})).toBeNull();
  });

  it("重定向 fd 吸收：2>/2>&1/1> 的 fd 数字不进前缀", () => {
    // 真实 bug：`ls dir 2>/dev/null` 点「记住」存出 `ls dir 2`，永远匹配不到 `ls dir`
    expect(
      deriveRememberRule("Bash", { command: "ls ~/.aide/claude/plugins/cache/ 2>/dev/null" })
        ?.matcher,
    ).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "ls ~/.aide/claude/plugins/cache/",
    });
    expect(
      deriveRememberRule("Bash", { command: "pnpm vue-tsc --noEmit 2>&1 | tail -20" })?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "pnpm vue-tsc --noEmit" });
    expect(
      deriveRememberRule("Bash", { command: "cargo test --lib 1>/tmp/out" })?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "cargo test --lib" });
    expect(
      deriveRememberRule("Bash", { command: "sort 0<in.txt" })?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "sort" });
  });

  it("fd 吸收的边界：数字是单词一部分或与操作符间有空格时不剥", () => {
    // `foo2` 是一个词，2 是参数（bash 语义同）
    expect(deriveRememberRule("Bash", { command: "echo foo2>file" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "echo foo2",
    });
    // `2 >` 有空格，2 是参数不是 fd
    expect(deriveRememberRule("Bash", { command: "cmd 2 > file" })?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "cmd 2",
    });
  });

  it("纯重定向命令截断后为空→null", () => {
    expect(deriveRememberRule("Bash", { command: "2>/dev/null" })).toBeNull();
  });

  it("命令缺失/类型错→null", () => {
    expect(deriveRememberRule("Bash", undefined)).toBeNull();
    expect(deriveRememberRule("Bash", { command: 123 })).toBeNull();
  });
});

describe("deriveRememberRule 链式命令感知现有规则", () => {
  it("第一段已被现有前缀规则覆盖→记住未覆盖的第二段", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(
      deriveRememberRule(
        "Bash",
        { command: "pnpm vitest run src/utils/permissionModeCycle.test.ts | grep -i allow" },
        rules,
      )?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "grep -i allow" });
  });

  it("无现有规则→维持旧行为（第一段作前缀）", () => {
    expect(
      deriveRememberRule("Bash", { command: "pnpm test && npm run build" }, [])?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "pnpm test" });
  });

  it("多段命令取第一个未覆盖段", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(
      deriveRememberRule("Bash", { command: "pnpm vitest run a.ts | grep x | wc -l" }, rules)
        ?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "grep x" });
  });

  it("全部段已被覆盖（异常态）→回退第一段", () => {
    const rules = [allowRule("pnpm test"), allowRule("grep")];
    expect(deriveRememberRule("Bash", { command: "pnpm test | grep x" }, rules)?.matcher).toEqual({
      kind: "bash",
      mode: "prefix",
      value: "pnpm test",
    });
  });

  it("引号内管道不算分隔符", () => {
    const rules = [allowRule("pnpm vitest run")];
    expect(
      deriveRememberRule("Bash", { command: "pnpm vitest run 'a|b' | grep x" }, rules)?.matcher,
    ).toEqual({ kind: "bash", mode: "prefix", value: "grep x" });
  });
});

describe("deriveRememberRule 文件工具→文件夹", () => {
  it("Write/Edit/MultiEdit 取 dirname 作 folder", () => {
    expect(deriveRememberRule("Write", { file_path: "C:/proj/src/a.ts" })?.matcher).toEqual({
      kind: "path",
      field: "file_path",
      folder: "C:/proj/src",
    });
    expect(deriveRememberRule("Edit", { file_path: "/home/u/repo/b.rs" })?.matcher).toEqual({
      kind: "path",
      field: "file_path",
      folder: "/home/u/repo",
    });
    expect(deriveRememberRule("MultiEdit", { file_path: "src/c.ts" })?.matcher).toEqual({
      kind: "path",
      field: "file_path",
      folder: "src",
    });
  });

  it("NotebookEdit 用 notebook_path 字段", () => {
    expect(deriveRememberRule("NotebookEdit", { notebook_path: "/nb/x.ipynb" })?.matcher).toEqual({
      kind: "path",
      field: "notebook_path",
      folder: "/nb",
    });
  });

  it("路径为空 / 无父目录→null（避免任意路径过宽规则）", () => {
    expect(deriveRememberRule("Write", { file_path: "" })).toBeNull();
    expect(deriveRememberRule("Write", { file_path: "foo.ts" })).toBeNull();
    expect(deriveRememberRule("Write", {})).toBeNull();
  });
});

describe("deriveRememberRule WebFetch→完整 URL equals", () => {
  it("取完整 url 作 field equals", () => {
    expect(deriveRememberRule("WebFetch", { url: "https://example.com/a/b" })?.matcher).toEqual({
      kind: "field",
      field: "url",
      equals: "https://example.com/a/b",
    });
  });
  it("url 为空→null", () => {
    expect(deriveRememberRule("WebFetch", { url: "" })).toBeNull();
    expect(deriveRememberRule("WebFetch", {})).toBeNull();
  });
});

describe("deriveRememberRule 其它工具→工具级", () => {
  it("未知/只读工具→tool 级任意调用", () => {
    expect(deriveRememberRule("Read", { file_path: "/a/b" })).toEqual({
      effect: "allow",
      tool: "Read",
      matcher: { kind: "tool" },
    });
    expect(deriveRememberRule("SomeMcpTool", { x: 1 })).toEqual({
      effect: "allow",
      tool: "SomeMcpTool",
      matcher: { kind: "tool" },
    });
  });
});

describe("describeRememberRule 描述行", () => {
  it("Bash 前缀 + 项目本地", () => {
    const draft = deriveRememberRule("Bash", { command: "pnpm test" })!;
    expect(describeRememberRule(draft, "local")).toBe(
      '将记住到本项目本地：执行以 "pnpm test" 开头的命令时始终允许',
    );
  });
  it("文件工具 + 用户全局回退", () => {
    const draft = deriveRememberRule("Write", { file_path: "/a/b/c.ts" })!;
    expect(describeRememberRule(draft, "user")).toBe(
      "将记住到用户全局：编辑 /a/b 及其子目录下的文件时始终允许",
    );
  });
  it("WebFetch url equals", () => {
    const draft = deriveRememberRule("WebFetch", { url: "https://x.com/p" })!;
    expect(describeRememberRule(draft, "local")).toBe(
      '将记住到本项目本地：对 url 为 "https://x.com/p" 的调用时始终允许',
    );
  });
  it("工具级", () => {
    const draft = deriveRememberRule("Read", {})!;
    expect(describeRememberRule(draft, "local")).toBe(
      "将记住到本项目本地：调用该工具时始终允许",
    );
  });
});
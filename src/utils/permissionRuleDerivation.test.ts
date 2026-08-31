import { describe, it, expect } from "vitest";
import type {
  PermissionEffect,
  PermissionMatcher,
  PermissionRule,
  PermissionRuleDraft,
} from "@/types/permissions";
import {
  deriveRememberRule,
  deriveSessionFileRules,
  describeRuleMatcher,
  filterRememberableDrafts,
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

describe("describeRuleMatcher 规则行描述", () => {
  it("Bash 前缀", () => {
    const [d] = deriveRememberRule("Bash", { command: "pnpm test" });
    expect(describeRuleMatcher(d)).toBe('执行以 "pnpm test" 开头的命令时始终允许');
  });
  it("文件工具文件夹", () => {
    const [d] = deriveRememberRule("Write", { file_path: "/a/b/c.ts" });
    expect(describeRuleMatcher(d)).toBe("编辑 /a/b 及其子目录下的文件时始终允许");
  });
  it("WebFetch url equals", () => {
    const [d] = deriveRememberRule("WebFetch", { url: "https://x.com/p" });
    expect(describeRuleMatcher(d)).toBe('对 url 为 "https://x.com/p" 的调用时始终允许');
  });
  it("工具级", () => {
    const [d] = deriveRememberRule("Read", {});
    expect(describeRuleMatcher(d)).toBe("调用该工具时始终允许");
  });
});

describe("deriveSessionFileRules 会话级精确文件规则", () => {
  it("Edit/Write/MultiEdit → 精确文件 matcher（file 字段，非 folder）", () => {
    expect(deriveSessionFileRules("Edit", { file_path: "C:/proj/src/a.ts" })).toEqual([
      {
        effect: "allow",
        tool: "Edit",
        matcher: { kind: "path", field: "file_path", file: "C:/proj/src/a.ts" },
      },
    ]);
    expect(deriveSessionFileRules("Write", { file_path: "/home/u/repo/b.rs" })[0].matcher).toEqual({
      kind: "path",
      field: "file_path",
      file: "/home/u/repo/b.rs",
    });
    expect(deriveSessionFileRules("MultiEdit", { file_path: "src/c.ts" })[0].matcher).toEqual({
      kind: "path",
      field: "file_path",
      file: "src/c.ts",
    });
  });

  it("NotebookEdit 用 notebook_path 字段", () => {
    expect(deriveSessionFileRules("NotebookEdit", { notebook_path: "/nb/x.ipynb" })).toEqual([
      {
        effect: "allow",
        tool: "NotebookEdit",
        matcher: { kind: "path", field: "notebook_path", file: "/nb/x.ipynb" },
      },
    ]);
  });

  it("路径为空 / 缺失 → 空数组（不推导）", () => {
    expect(deriveSessionFileRules("Edit", { file_path: "" })).toEqual([]);
    expect(deriveSessionFileRules("Edit", {})).toEqual([]);
    expect(deriveSessionFileRules("Edit", undefined)).toEqual([]);
    expect(deriveSessionFileRules("Edit", { file_path: 123 })).toEqual([]);
  });

  it("非文件工具 → 空数组（Bash/WebFetch 不建会话规则）", () => {
    expect(deriveSessionFileRules("Bash", { command: "ls" })).toEqual([]);
    expect(deriveSessionFileRules("WebFetch", { url: "https://x.com" })).toEqual([]);
    expect(deriveSessionFileRules("Read", { file_path: "/a/b" })).toEqual([]);
  });
});

describe("describeRuleMatcher file matcher 措辞（与 folder 区分）", () => {
  it("file matcher → 编辑某文件时始终允许", () => {
    const [d] = deriveSessionFileRules("Write", { file_path: "/a/b/c.ts" });
    expect(describeRuleMatcher(d)).toBe("编辑 /a/b/c.ts 这个文件时始终允许");
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

describe("filterRememberableDrafts 落盘前语义过滤", () => {
  /** 构造一条任意形状的现有规则（默认 allow / Bash）。 */
  function ruleWith(
    matcher: PermissionMatcher,
    effect: PermissionEffect = "allow",
    tool = "Bash",
  ): PermissionRule {
    return {
      id: "r-x",
      scope: "user",
      order: 0,
      effect,
      tool,
      matcher,
      source: { label: "user", readOnly: false },
    };
  }

  /** 直接构造 draft（绕过 derive——测 filter 对各 matcher 形态的分派本身）。 */
  const draftOf = (tool: string, matcher: PermissionMatcher): PermissionRuleDraft => ({
    effect: "allow",
    tool,
    matcher,
  });

  const matchersOf = (drafts: readonly PermissionRuleDraft[]): unknown[] =>
    drafts.map((d) => d.matcher);

  it("宽前缀规则覆盖窄 prefix draft→丢弃（用户场景：cd/tail 已有宽规则，只剩 cargo check）", () => {
    const drafts = deriveRememberRule(
      "Bash",
      { command: 'cd "C:/document/owner/cypress-agent/src-tauri" && cargo check 2>&1 | tail -30' },
      [],
    );
    expect(drafts).toHaveLength(3); // 空规则库下推导的全量段（快照未过滤形态）
    const kept = filterRememberableDrafts(drafts, [allowRule("cd"), allowRule("tail")]);
    expect(matchersOf(kept)).toEqual([{ kind: "bash", mode: "prefix", value: "cargo check" }]);
  });

  it("未被覆盖的 prefix draft→保留（cargo check ≠ cargo test）", () => {
    const kept = filterRememberableDrafts(deriveRememberRule("Bash", { command: "cargo check" }), [
      allowRule("cargo test"),
    ]);
    expect(matchersOf(kept)).toEqual([{ kind: "bash", mode: "prefix", value: "cargo check" }]);
  });

  it("与现有规则精确同值的 prefix draft→丢弃（重复点击不再堆积）", () => {
    const kept = filterRememberableDrafts(deriveRememberRule("Bash", { command: "pnpm test" }), [
      allowRule("pnpm test"),
    ]);
    expect(kept).toEqual([]);
  });

  it("tool 级 allow 规则覆盖 prefix draft→丢弃", () => {
    const kept = filterRememberableDrafts(deriveRememberRule("Bash", { command: "cargo check" }), [
      allowRule("anything", true),
    ]);
    expect(kept).toEqual([]);
  });

  it("value 缺失的 prefix draft→保守保留（交由行级校验/落盘端兜底）", () => {
    const kept = filterRememberableDrafts([draftOf("Bash", { kind: "bash", mode: "prefix" })], [
      allowRule("cd"),
    ]);
    expect(kept).toHaveLength(1);
  });

  it("bash all draft：被 tool 级 allow 或 bash all allow 覆盖→丢；仅有 prefix 规则→留", () => {
    const allDraft = draftOf("Bash", { kind: "bash", mode: "all" });
    expect(filterRememberableDrafts([allDraft], [allowRule("x", true)])).toEqual([]);
    expect(
      filterRememberableDrafts([allDraft], [ruleWith({ kind: "bash", mode: "all" })]),
    ).toEqual([]);
    expect(filterRememberableDrafts([allDraft], [allowRule("ls")])).toHaveLength(1);
  });

  it("tool 级 draft：同工具 tool 级 allow→丢；不同工具→留", () => {
    const readDraft = deriveRememberRule("Read", {});
    expect(readDraft).toHaveLength(1);
    expect(
      filterRememberableDrafts(readDraft, [ruleWith({ kind: "tool" }, "allow", "Read")]),
    ).toEqual([]);
    expect(
      filterRememberableDrafts(readDraft, [ruleWith({ kind: "tool" }, "allow", "Grep")]),
    ).toHaveLength(1);
    // Bash 的 tool 级规则覆盖不了别的工具
    expect(filterRememberableDrafts(readDraft, [allowRule("ls", true)])).toHaveLength(1);
  });

  it("path folder draft：同形状→丢；不同 folder→留（目录包含语义刻意不做）", () => {
    const writeDraft = deriveRememberRule("Write", { file_path: "C:/proj/src/a.ts" });
    expect(writeDraft).toHaveLength(1);
    expect(
      filterRememberableDrafts(writeDraft, [
        ruleWith({ kind: "path", field: "file_path", folder: "C:/proj/src" }, "allow", "Write"),
      ]),
    ).toEqual([]);
    // 宽目录（C:/proj）已覆盖窄目录（C:/proj/src）——语义上冗余但本期不做包含判断
    expect(
      filterRememberableDrafts(writeDraft, [
        ruleWith({ kind: "path", field: "file_path", folder: "C:/proj" }, "allow", "Write"),
      ]),
    ).toHaveLength(1);
  });

  it("field equals draft：同形状→丢；不同 equals→留", () => {
    const urlDraft = deriveRememberRule("WebFetch", { url: "https://x.com/p" });
    expect(urlDraft).toHaveLength(1);
    expect(
      filterRememberableDrafts(urlDraft, [
        ruleWith({ kind: "field", field: "url", equals: "https://x.com/p" }, "allow", "WebFetch"),
      ]),
    ).toEqual([]);
    expect(
      filterRememberableDrafts(urlDraft, [
        ruleWith({ kind: "field", field: "url", equals: "https://x.com/q" }, "allow", "WebFetch"),
      ]),
    ).toHaveLength(1);
  });

  it("同形状 deny/ask 规则不构成覆盖（effect 守卫）", () => {
    const writeDraft = deriveRememberRule("Write", { file_path: "C:/proj/src/a.ts" });
    expect(
      filterRememberableDrafts(writeDraft, [
        ruleWith({ kind: "path", field: "file_path", folder: "C:/proj/src" }, "deny", "Write"),
      ]),
    ).toHaveLength(1);
    // bash all draft 对 deny/ask 的 tool 级规则同理
    expect(
      filterRememberableDrafts([draftOf("Bash", { kind: "bash", mode: "all" })], [
        ruleWith({ kind: "tool" }, "ask"),
      ]),
    ).toHaveLength(1);
  });

  it("bash contains draft（draft 侧不可达：contains 永不作 allow）落形状臂：同形状→丢", () => {
    const containsDraft = draftOf("Bash", { kind: "bash", mode: "contains", value: "x" });
    expect(
      filterRememberableDrafts([containsDraft], [ruleWith({ kind: "bash", mode: "contains", value: "x" })]),
    ).toEqual([]);
    expect(filterRememberableDrafts([containsDraft], [allowRule("ls")])).toHaveLength(1);
  });

  it("空规则库→全保留", () => {
    const drafts = deriveRememberRule("Bash", { command: "pnpm test && npm run build" }, []);
    expect(filterRememberableDrafts(drafts, [])).toHaveLength(drafts.length);
  });

  it("链式段全覆盖的异常态（derive 回退首段）→过滤后为空：预览/按钮/落盘三侧一致不写", () => {
    const rules = [allowRule("pnpm test"), allowRule("grep")];
    const drafts = deriveRememberRule("Bash", { command: "pnpm test | grep x" }, rules);
    // derive 侧段全覆盖异常态保守回退首段（1 条），但该段已被覆盖——filter 滤掉
    expect(drafts).toHaveLength(1);
    expect(filterRememberableDrafts(drafts, rules)).toEqual([]);
  });
});

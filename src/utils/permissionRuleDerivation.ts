// 「允许并记住」的规则推导——把一次工具调用请求就地转成一条可持久化的
// `allow` 规则，替代旧版「总是允许」按钮（那笔提交移除了 always-allow 路径，
// 改由 aide 自有权限规则体系承接）。
//
// 纯函数，无 IO：输入工具名 + 工具参数，输出 PermissionRuleDraft 或 null
// （推不出来就不显示「记住」按钮）。Bash 前缀截断的引号感知扫描器与 sidecar
// `agent-sidecar/src/policy/matchers.ts` 的 `hasUnquotedShellControl` 语义对齐——
// 前端不能 import sidecar，这里复刻一份最小实现。
//
// 安全性靠两层：① 推导出的前缀本身绝不含未引用 shell 控制符（在首个控制符处截断）；
// ② Rust/sidecar 的 prefix-allow 匹配还有第二道闸——被匹配命令若含未引用控制符
// 直接 no-match。所以「记住 `pnpm test`」会放行 `pnpm test --foo`，但永不放行
// `pnpm test && rm -rf /`。

import type {
  PermissionMatcher,
  PermissionRuleDraft,
  PermissionScope,
} from "@/types/permissions";

// 未引用即被视为命令边界的 shell 控制符。`$(` 单独处理（两字符）。
const SHELL_CONTROL = new Set([";", "|", "&", "<", ">", "\n", "`"]);

/** 扫描 `command`，返回第一个「未引用」shell 控制符的字符索引；
 *  全程无控制符则返回命令长度。引号感知：
 *  - 单引号内一切字面（含 `;` `|` 等）
 *  - 双引号内仍识别控制符（与 sidecar 一致：双引号不豁免控制符检测）
 *  - 单引号外的反斜杠转义下一字符
 *  对齐 sidecar policy/matchers.ts `hasUnquotedShellControl`。 */
function firstUnquotedControlIndex(command: string): number {
  const chars = [...command];
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\" && !inSingle) {
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (SHELL_CONTROL.has(c)) return i;
      if (c === "$" && chars[i + 1] === "(") return i;
    }
    i++;
  }
  return chars.length;
}

/** Bash 前缀推导：去前导空白 → 在首个未引用控制符处截断 → 吸收重定向 fd → 去尾部空白。
 *  结果为空（命令本身以控制符开头 / 空命令）返回 null。 */
function deriveBashPrefix(command: string): string | null {
  const trimmed = command.trimStart();
  if (!trimmed) return null;
  let cut = firstUnquotedControlIndex(trimmed);
  // 重定向 fd（IO_NUMBER）吸收：`cmd 2>/dev/null` 截断点在 `>`，紧邻操作符的
  // 独立数字 token 是 fd 而非参数，须一并剥掉——否则前缀末尾挂个 " 2"，
  // 不带重定向的同类命令（`cmd`）反而匹配不上，规则成了死规则。
  if (cut > 0 && (trimmed[cut] === ">" || trimmed[cut] === "<")) {
    let j = cut - 1;
    while (j >= 0 && trimmed[j] >= "0" && trimmed[j] <= "9") j--;
    // 数字须紧邻操作符、且自身是独立 token（前面是空白或串首）才剥；
    // `echo foo2>file` 的 2 是单词一部分（bash 里也是参数），不能剥。
    if (j < cut - 1 && (j < 0 || trimmed[j] === " " || trimmed[j] === "\t")) {
      cut = j + 1;
    }
  }
  const prefix = trimmed.slice(0, cut).trimEnd();
  return prefix.length > 0 ? prefix : null;
}

/** 跨平台父目录：同时认 `/` 和 `\`，去尾部分隔后取最后一段之前。
 *  无父目录（单段相对名、根、盘根）返回 null——避免推出「任意路径」过宽规则。 */
function parentDir(p: string): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (lastSep <= 0) return null;
  return trimmed.slice(0, lastSep);
}

/** 把一次工具调用请求推导成一条 `allow` 规则。推不出来返回 null。 */
export function deriveRememberRule(
  tool: string,
  input: unknown,
): PermissionRuleDraft | null {
  const inp =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  if (tool === "Bash") {
    const command = typeof inp.command === "string" ? inp.command : "";
    const prefix = deriveBashPrefix(command);
    if (!prefix) return null;
    return {
      effect: "allow",
      tool,
      matcher: { kind: "bash", mode: "prefix", value: prefix },
    };
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const fp = typeof inp.file_path === "string" ? inp.file_path : "";
    const folder = parentDir(fp);
    if (!folder) return null;
    return {
      effect: "allow",
      tool,
      matcher: { kind: "path", field: "file_path", folder },
    };
  }

  if (tool === "NotebookEdit") {
    const fp = typeof inp.notebook_path === "string" ? inp.notebook_path : "";
    const folder = parentDir(fp);
    if (!folder) return null;
    return {
      effect: "allow",
      tool,
      matcher: { kind: "path", field: "notebook_path", folder },
    };
  }

  if (tool === "WebFetch") {
    const url = typeof inp.url === "string" ? inp.url : "";
    if (!url) return null;
    return {
      effect: "allow",
      tool,
      matcher: { kind: "field", field: "url", equals: url },
    };
  }

  // 其它工具：工具级「任意调用」。用户显式点了记住，工具级 allow 可接受；
  // 描述行会写明「调用 X 工具时始终允许」，用户看清楚再决定。
  return { effect: "allow", tool, matcher: { kind: "tool" } };
}

// ---------------------------------------------------------------------------
// 描述（供对话框展示「将记住什么」）
// ---------------------------------------------------------------------------

function scopeWord(scope: PermissionScope): string {
  switch (scope) {
    case "local":
      return "本项目本地";
    case "project":
      return "本项目（共享）";
    case "user":
      return "用户全局";
    case "managed":
      return "受管策略";
    case "session":
      return "本会话";
  }
}

function matcherDescription(matcher: PermissionMatcher): string {
  switch (matcher.kind) {
    case "tool":
      return "调用该工具";
    case "bash":
      if (matcher.mode === "prefix") return `执行以 "${matcher.value}" 开头的命令`;
      if (matcher.mode === "contains") return `执行包含 "${matcher.value}" 的命令`;
      return "执行任意 Bash 命令";
    case "path": {
      const fieldWord =
        matcher.field === "notebook_path" ? "notebook" : "文件";
      if (matcher.folder !== undefined) {
        return `编辑 ${matcher.folder} 及其子目录下的${fieldWord}`;
      }
      return `编辑任意路径的${fieldWord}`;
    }
    case "field":
      return `对 ${matcher.field} 为 "${matcher.equals}" 的调用`;
  }
}

/** 供权限对话框「允许并记住」按钮旁的描述行：将记住到哪个作用域、记住什么。 */
export function describeRememberRule(
  draft: PermissionRuleDraft,
  scope: PermissionScope,
): string {
  return `将记住到${scopeWord(scope)}：${matcherDescription(draft.matcher)}时始终允许`;
}
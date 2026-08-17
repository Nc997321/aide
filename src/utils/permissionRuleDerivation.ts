// 「允许并记住」的规则推导——把一次工具调用请求就地转成一条可持久化的
// `allow` 规则，替代旧版「总是允许」按钮（那笔提交移除了 always-allow 路径，
// 改由 aide 自有权限规则体系承接）。
//
// 纯函数，无 IO：输入工具名 + 工具参数 + 现有规则，输出 PermissionRuleDraft 或
// null（推不出来就不显示「记住」按钮）。Bash 前缀截断的引号感知扫描器与 sidecar
// `agent-sidecar/src/policy/matchers.ts` 的 `hasUnquotedShellControl` 语义对齐——
// 前端不能 import sidecar，这里复刻一份最小实现。
//
// 链式命令（`a | b`、`a && b`…）的推导感知现有规则：切分成段后逐段检查是否已
// 被现有 allow 规则覆盖，取**第一个未覆盖的段**作为新规则前缀。否则像
// `pnpm vitest run <file> | grep x` 这类第一段早已放行、真正缺的是管道后段的命令，
// 记住出来的会是第一段的冗余规则，永远解决不了弹窗。
//
// 安全性靠两层：① 推导出的前缀本身绝不含未引用 shell 控制符（在首个控制符处截断）；
// ② Rust/sidecar 的 prefix-allow 匹配还有第二道闸——被匹配命令若含未引用控制符
// 直接 no-match。所以「记住 `pnpm test`」会放行 `pnpm test --foo`，但永不放行
// `pnpm test && rm -rf /`。段覆盖检查只复用前缀边界语义，不放松链式分段本身的
// 严格匹配。

import type {
  PermissionMatcher,
  PermissionRule,
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

/** 命令是否含未引用的 shell 控制符（`|;&&><\n\`` 或 `$(`）。与
 *  `firstUnquotedControlIndex` 同源：有控制符 ⇔ 索引小于命令长度。
 *  导出供记住对话框校验用户编辑的规则值——allow 前缀含未引用控制符
 *  在策略引擎里永不命中，必须先亮红灯。 */
export function hasUnquotedShellControl(command: string): boolean {
  return firstUnquotedControlIndex(command) < command.length;
}

/** 前缀匹配带命令边界：`value` 必须匹配 `command` 开头且其后跟空白、shell
 *  分隔符或串尾。`"pnpm test"` 匹配 `"pnpm test --runInBand"` 但不匹配
 *  `"pnpm testx"`。对齐 sidecar matchers.ts `commandStartsWithBoundary`。 */
function commandStartsWithBoundary(command: string, value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(value)) {
    return false;
  }
  const rest = trimmed.slice(value.length);
  if (rest.length === 0) {
    return true;
  }
  const next = rest[0];
  return (
    next === " " || next === "\t" ||
    next === ";" || next === "|" || next === "&" ||
    next === "<" || next === ">" || next === "\n"
  );
}

/** Bash 链式命令切分（前端复刻 sidecar matchers.ts `splitBashSegments`）。
 *  把 `a | b`、`a && b`、`a; b`、`a & b`、换行切分成独立段；命令含文件重定向、
 *  `$(…)`/反引号、空段、未闭合引号时返回 null（不可验证）。无害重定向
 *  （`2>&1`、`2>/dev/null`、`&>/dev/null`）段内透明化。
 *
 *  与 sidecar 匹配侧有一处刻意分叉：这里的段**剥离 fd 号**（`cmd 2>&1` → 段
 *  `cmd`），sidecar 匹配侧的段**保留 fd**（`cmd 2`）。记住侧要剥——`2>&1` 的
 *  `2` 是 fd 不是命令词，留在段里会被 `deriveBashPrefix` 当参数写进规则，
 *  生成 `cmd 2` 这种把 fd 误当参数的错规则。匹配侧要留——字面规则 `cmd 2`
 *  （用户记住/手写的参数）必须命中 `cmd 2>&1` 重定向变体。两者配合：
 *  记住生成的是剥了 fd 的宽前缀（`cmd`），匹配段保留 fd 后照样命中。 */
function splitBashSegments(command: string): string[] | null {
  const chars = [...command];
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const finalizeInterior = (): boolean => {
    const seg = current.trim();
    current = "";
    if (seg.length === 0) return false;
    segments.push(seg);
    return true;
  };

  /** 读重定向目标词（带引号/展开即不可验证）。 */
  const readRedirectTarget = (): string | null => {
    while (chars[i] === " " || chars[i] === "\t") i++;
    if (i >= chars.length) return null;
    if (chars[i] === "'" || chars[i] === '"') return null;
    let t = "";
    while (i < chars.length && !/[ \t;|&<>\n`$"'\\]/.test(chars[i])) {
      t += chars[i];
      i++;
    }
    return t.length > 0 ? t : null;
  };

  /** 剥掉 `current` 末尾独立数字 run——重定向操作符的 IO_NUMBER fd，
   *  不是命令词（`echo foo2>file` 的 2 是参数，保留）。 */
  const stripTrailingFd = (): void => {
    const m = /(?:^|[ \t])(\d+)$/.exec(current);
    if (m) current = current.slice(0, current.length - m[1].length);
  };

  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\" && !inSingle) {
      if (i + 1 < chars.length) {
        current += c + chars[i + 1];
        i += 2;
      } else {
        current += c;
        i += 1;
      }
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      current += c;
      i++;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      current += c;
      i++;
      continue;
    }
    if (inSingle || inDouble) {
      current += c;
      i++;
      continue;
    }

    if (c === "$" && chars[i + 1] === "(") return null;
    if (c === "`") return null;
    if (c === ";" || c === "\n") {
      if (!finalizeInterior()) return null;
      i++;
      continue;
    }
    if (c === "|") {
      i++;
      if (chars[i] === "|") i++; // `||` 是单个分隔符
      if (!finalizeInterior()) return null;
      continue;
    }
    if (c === "&") {
      const next = chars[i + 1];
      if (next === "&") {
        i += 2;
        if (!finalizeInterior()) return null;
        continue;
      }
      if (next === ">") {
        // `&>file` / `&>>file` 双流重定向——只有 /dev/null 无害。
        i += 2;
        if (chars[i] === ">") i++;
        const target = readRedirectTarget();
        if (target !== "/dev/null") return null;
        continue;
      }
      // 单个 `&` = 后台分隔符。
      i++;
      if (!finalizeInterior()) return null;
      continue;
    }
    if (c === ">" || c === "<") {
      stripTrailingFd();
      const op = c;
      i++;
      if (op === ">" && chars[i] === ">") {
        i++; // `>>`
      } else if (op === "<" && chars[i] === "<") {
        return null; // heredoc / herestring
      }
      if (chars[i] === "&") {
        // fd 复制 `[n]>&[m]` / `[n]>&-`——无文件系统副作用。
        // 非数字目标（`>&file`）把双流重定向到文件。
        i++;
        const t = readRedirectTarget();
        if (t === null || !/^(\d+|-)$/.test(t)) return null;
        continue;
      }
      const target = readRedirectTarget();
      if (op === ">" && target === "/dev/null") continue; // 无害丢弃
      return null; // 任何真实文件重定向都不可验证
    }
    current += c;
    i++;
  }
  if (inSingle || inDouble) return null;
  const last = current.trim();
  if (last.length > 0) segments.push(last);
  return segments.length > 0 ? segments : null;
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

/** 段是否已被现有 allow 规则覆盖。只认 Bash 工具的 allow 规则；tool 级 / bash
 *  `all` 覆盖一切，bash `prefix` 按「前缀 + 命令边界 + 无未引用控制符」判定（与
 *  sidecar 策略引擎同语义）。`contains` 永不作 allow（上游已校验），跳过。 */
function segmentCoveredByRules(segment: string, rules: readonly PermissionRule[]): boolean {
  for (const rule of rules) {
    if (rule.effect !== "allow" || rule.tool !== "Bash") continue;
    const m = rule.matcher;
    if (m.kind === "tool") return true;
    if (m.kind !== "bash") continue;
    if (m.mode === "all") return true;
    if (m.mode === "prefix") {
      const value = m.value ?? "";
      if (
        value.length > 0 &&
        !hasUnquotedShellControl(segment) &&
        commandStartsWithBoundary(segment, value)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Bash「记住」规则前缀推导：简单命令维持原行为（整条作前缀）；链式命令切分
 *  成段后对**每一个未被现有规则覆盖的段**各生成一条前缀——一次「允许并记住」
 *  把管道整链缺的规则全部补上，而不是只补第一段、留下第二段下次继续弹窗。
 *  整条不可验证或全被覆盖时回退到原行为（首段前缀）。结果去重（不同段可能
 *  推出同一前缀）。 */
function deriveBashRememberPrefixes(
  command: string,
  rules: readonly PermissionRule[],
): string[] {
  const trimmed = command.trimStart();
  if (!trimmed) return [];
  const one = (c: string): string[] => {
    const p = deriveBashPrefix(c);
    return p ? [p] : [];
  };
  if (!hasUnquotedShellControl(trimmed)) {
    return one(trimmed);
  }
  const segments = splitBashSegments(trimmed);
  if (segments === null) {
    return one(trimmed);
  }
  const uncovered = segments.filter((seg) => !segmentCoveredByRules(seg, rules));
  // 全部被覆盖是异常态（整链已被放行，本不该弹窗）——保守回退首段，不加戏。
  const targets = uncovered.length > 0 ? uncovered : [segments[0]];
  return [...new Set(targets.flatMap(one))];
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

/** 把一次工具调用请求推导成一组 `allow` 规则（Bash 链式命令可一次推出多条——
 *  每段一条；其余工具最多一条）。`existingRules` 供 Bash 链式命令识别「未被现有
 *  规则覆盖的段」。推不出来返回空数组（对话框据此不显示「记住」按钮）。 */
export function deriveRememberRule(
  tool: string,
  input: unknown,
  existingRules: readonly PermissionRule[] = [],
): PermissionRuleDraft[] {
  const inp =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  if (tool === "Bash") {
    const command = typeof inp.command === "string" ? inp.command : "";
    return deriveBashRememberPrefixes(command, existingRules).map((value) => ({
      effect: "allow",
      tool,
      matcher: { kind: "bash", mode: "prefix", value },
    }));
  }

  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
    const fp = typeof inp.file_path === "string" ? inp.file_path : "";
    const folder = parentDir(fp);
    if (!folder) return [];
    return [
      {
        effect: "allow",
        tool,
        matcher: { kind: "path", field: "file_path", folder },
      },
    ];
  }

  if (tool === "NotebookEdit") {
    const fp = typeof inp.notebook_path === "string" ? inp.notebook_path : "";
    const folder = parentDir(fp);
    if (!folder) return [];
    return [
      {
        effect: "allow",
        tool,
        matcher: { kind: "path", field: "notebook_path", folder },
      },
    ];
  }

  if (tool === "WebFetch") {
    const url = typeof inp.url === "string" ? inp.url : "";
    if (!url) return [];
    return [
      {
        effect: "allow",
        tool,
        matcher: { kind: "field", field: "url", equals: url },
      },
    ];
  }

  // 其它工具：工具级「任意调用」。用户显式点了记住，工具级 allow 可接受；
  // 描述行会写明「调用 X 工具时始终允许」，用户看清楚再决定。
  return [{ effect: "allow", tool, matcher: { kind: "tool" } }];
}

// ---------------------------------------------------------------------------
// 数字参数透明化（方案 E）：`tail -8` 形态的高置信度可变参数检测
// ---------------------------------------------------------------------------

/** 规则值末尾是否「数字参数」形态，若是返回去掉该参数后的前缀，否则返回 null。
 *  只认高置信度可变的形态：
 *   - `-8`（选项+数值一体）→ `tail -8` → `tail`
 *   - `--lines=8` → `tail --lines=8` → `tail`
 *   - `-n 8` / `--lines 8`（数值前是选项 flag）→ `head -n 8` → `head`
 *  裸数字 token（`npx vitest run 2` 的 `2`）不简化——那可能是 vitest 过滤器、
 *  分支名这类语义本身，引擎无法区分，宁可留给用户手动编辑。 */
export function stripTrailingNumericArg(value: string): string | null {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  const prevIsFlag = /^--?[\w-]+$/.test(prev);
  const lastIsFlagValue = /^-\d+$/.test(last) || /^(--?[\w-]+)=\d+$/.test(last);
  const lastIsNumWithFlagPrev = /^\d+$/.test(last) && prevIsFlag;
  if (!lastIsFlagValue && !lastIsNumWithFlagPrev) return null;
  const cut = lastIsNumWithFlagPrev ? tokens.length - 2 : tokens.length - 1;
  const prefix = tokens.slice(0, cut).join(" ");
  return prefix.length > 0 ? prefix : null;
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

/** 供权限对话框「允许并记住」按钮旁的描述行：将记住到哪个作用域、记住什么。
 *  多条规则（链式命令一次记住多段）逐条列出。 */
export function describeRememberRule(
  drafts: readonly PermissionRuleDraft[],
  scope: PermissionScope,
): string {
  if (drafts.length === 0) return "";
  const head = `将记住到${scopeWord(scope)}`;
  if (drafts.length === 1) {
    return `${head}：${matcherDescription(drafts[0].matcher)}时始终允许`;
  }
  const items = drafts
    .map((d, i) => `${i + 1}. ${matcherDescription(d.matcher)}时始终允许`)
    .join("；");
  return `${head}（${drafts.length} 条规则）：${items}`;
}

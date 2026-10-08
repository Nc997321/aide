import type { ChatMessage, ContentBlock, LspRelayVerdict } from "../types/chat";

/**
 * F 方案（Read 接力显示）的判定核心：纯函数层，不碰 store、不碰 IO。
 *
 * 背景：LSP 工具给出精确定位（workspaceSymbol / findReferences / hover 的结果文本）
 * 之后，模型理想的行为是沿坐标 Read(offset, limit) 读小段；现实是它也可能无视
 * 坐标整文件读。这里的职责：给 assistant 的每次 Read 调用算出「接力了 / 没接力 /
 * 无从判定」三态，供工具卡头行渲染徽章。
 *
 * **两代 LSP 通道都要认**（2026-09-19 C3 起）：内置 `LSP` 工具，与 aide-lsp 的四个
 * `mcp__aide-lsp__*` 工具。C3 把内置通道退役掉了，此后 agent 只走后者——判定若还只认
 * 前者，整块接力 UI 会**静默失效**（不是报错，是徽章再也不出现）。两代的入参字段名与
 * 「结果算不算数」的判据都不同，分别在本文件下半部按代处理。
 *
 * 判定依据刻意保持宽松——徽章是行为指示器不是契约证明：
 * 同一文件（basename 相等）+ LSP 结果非失败 + Read 带 offset ⇒ hit；
 * 同上但 Read 无 offset ⇒ miss（整文件读）。
 *
 * 已实测的**内置** LSP 失败结果文本前缀（scripts/diag/lsp-probe-run{B,C,D2}.json）：
 * "No hover information available…" / "No symbols found…" / "No references
 * found…" / "No definition found…" / "Error performing hover…" / "Failed to
 * sync file open…" —— 统一按 no / error / failed 前缀识别。
 */

/** 一次已完成的 LSP 调用的判定上下文。 */
export interface LspCallContext {
  /** LSP 操作的目标文件（内置 `LSP` 的 input.filePath / aide-lsp 的 input.file） */
  filePath: string;
  /** 该调用的结果文本（tool_result；空/缺失视为未完成，不构成上下文） */
  result: string;
}

/** LSP 失败结果的统一前缀识别。误杀方向恒为中性（不打徽章）——禁止扩大前缀集：
 *  扩大只会把成功结果误判成失败，徽章永远往「缺」的方向偏，不往「错」偏。 */
const LSP_FAILED = /^(no\b|error|failed)/i;

/** 内置 LSP 工具名（C3 之前的唯一通道）。 */
const BUILTIN_LSP_TOOL = "LSP";

/** aide-lsp 的 MCP 工具名前缀：server 名 `aide-lsp`，SDK 展开成
 *  `mcp__aide-lsp__lsp_symbols` 等（工具清单见 agent-sidecar/src/extensions/lspTools.ts）。 */
const AIDE_LSP_TOOL_PREFIX = "mcp__aide-lsp__";

/** 这次工具调用属于 LSP 家族吗。两代都认——漏认后者 = 整块接力 UI 静默失效。 */
function isLspToolCall(name: string): boolean {
  return name === BUILTIN_LSP_TOOL || name.startsWith(AIDE_LSP_TOOL_PREFIX);
}

/** 该调用的结果算不算「答了话」（够不够格当接力上下文）。
 *
 *  两代判据不同，各自照**实测 / 自控的文案**定，不是随手松紧之差：
 *  - 内置 `LSP`：前缀识别。**不能**改成「有坐标才算」——内置的 hover 结果是纯文档
 *    （`Hover info at 13:9:` 后接代码块），那样会把 hover 构成的上下文整片杀掉
 *    （lspRelay.test.ts 的 HOVER_OK 就是这个形状）。
 *  - aide-lsp：**必须有坐标**。它四个工具全是定位类（symbols / references /
 *    definition / implementations，没有 hover），而**非 ready 时一律回散文**——
 *    "The language server is still building its index…" 开头是 "The"，前缀判据那边
 *    整片失效。用坐标在场判定同时办两件事：真答了话的才算上下文，**索引没就绪的空
 *    结果绝不算「接力了」**（红线，也是这个徽章最容易骗人的地方）。 */
function isUsableLspResult(toolName: string, result: string): boolean {
  const text = result.trim();
  if (LSP_FAILED.test(text)) return false;
  if (toolName === BUILTIN_LSP_TOOL) return true;
  // 文本兜底（语义层没答上时同一发给出的纯文本命中）带着坐标，但**不是** LSP 的答案：
  // 它的标记词是 UNVERIFIED（见 agent-sidecar lspFormat.ts 的 textFallbackText）。
  if (/\bUNVERIFIED\b/.test(text)) return false;
  // 三种坐标形状（2026-09-29 起的输出，见 lspFormat.ts）：`path:12:5`（定义 / 符号）、
  // 分组引用的行首 `  12:5`、文件结构的 `L12-40`。
  return /:\d+:\d+/.test(text) || /^\s+\d+:\d+\s/m.test(text) || /\bL\d+(-\d+)?\b/.test(text);
}

/** 实时路径的回看扫描上限（块数）：防超长会话 O(n)。 */
const RECENT_BLOCK_CAP = 200;

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  // 此臂实际不可达（String.split 恒返回 ≥1 元素）；工程未开 noUncheckedIndexedAccess，
  // ?? "" 属防御性收窄而非编译所需
  return parts[parts.length - 1] ?? "";
}

/** LSP 工具 input 里的目标文件。**两代字段名不同**：内置 `LSP` 是 camelCase
 *  `filePath`（实测 harness 格式），aide-lsp 的四个工具是 `file`（见其 zod shape）。
 *
 *  只有带 file 的调用才有目标文件可谈。aide-lsp 的 `{ name }` 单参形式（先按名找符号）
 *  没有 file ⇒ 不构成上下文 ⇒ 那次 Read 落中性。**这是刻意的**：一次返回 N 个文件的
 *  引用查询并没有「那一个坐标」，硬凑一个集合会把徽章变成噪声（模块头：误杀方向恒为
 *  中性，宁可少打不可错打）。 */
function lspInputFilePath(input: unknown, result?: string): string | null {
  const record = input as Record<string, unknown> | null;
  for (const key of ["filePath", "file"] as const) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return result ? singleResultFile(result) : null;
}

/** 按名调用（`lsp_definition {name}`）没有入参文件，但结果里只指向**一个**文件时，那个
 *  文件就是接力目标（定义 + 函数体之后 Read 同一文件的某段，是最典型的接力）。
 *  指向多个文件 ⇒ 没有「那一个坐标」⇒ null（中性），与上面的纪律一致。 */
function singleResultFile(result: string): string | null {
  const files = new Set<string>();
  for (const m of result.matchAll(/([\w./\\:-]+\.[A-Za-z0-9]+):\d+:\d+/g)) files.add(m[1]);
  return files.size === 1 ? [...files][0] : null;
}

/**
 * 判定一次 Read 是否接力。input 是 tool_use 的原始入参（unknown，边界收窄）。
 * 返回 "hit" / "miss" / null（中性，不打徽章）。
 */
export function judgeReadRelay(input: unknown, lsp: LspCallContext | null): LspRelayVerdict | null {
  if (!lsp || LSP_FAILED.test(lsp.result.trim())) return null;
  const record = input as Record<string, unknown> | null;
  const filePath = typeof record?.file_path === "string" ? record.file_path : null;
  if (!filePath) return null;
  if (basenameOf(filePath) !== basenameOf(lsp.filePath)) return null;
  const offset = record?.offset;
  return typeof offset === "number" && Number.isFinite(offset) ? "hit" : "miss";
}

/**
 * 倒序扫最近消息，找最近一个已完成（有结果）的 LSP 调用。cap 限扫描块数，
 * 防超长会话 O(n)。用户消息整段跳过——@mention 合成卡永不参与判定。
 */
export function lastLspContextInMessages(
  messages: readonly ChatMessage[],
  cap = RECENT_BLOCK_CAP,
): LspCallContext | null {
  let scanned = 0;
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg || msg.role !== "assistant") continue;
    for (let bi = msg.blocks.length - 1; bi >= 0; bi--) {
      if (scanned >= cap) return null;
      const block = msg.blocks[bi];
      // !block 此臂实际不可达（合法索引下元素恒存在）；未开 noUncheckedIndexedAccess，属防御性收窄
      if (!block || block.type !== "tool_call") continue;
      scanned++;
      if (!isLspToolCall(block.name)) continue;
      if (typeof block.result !== "string" || !block.result) continue;
      if (!isUsableLspResult(block.name, block.result)) continue;
      const filePath = lspInputFilePath(block.input, block.result);
      if (filePath) return { filePath, result: block.result };
    }
  }
  return null;
}

/**
 * 就地标注消息序列里的 assistant Read 块（回看路径：itemsToChatMessages 落盘页
 * 重放）。整页遍历：LSP 块更新追踪器、Read 块就地判定——单遍 O(页大小)。
 * 两条路径的接力都以各自可见范围为限：回看以页内为界，实时路径以当前驻留
 * 消息为限（cap=200）——LSP 在页界之外时该 Read 落中性，同块两路径可能不一致，
 * 属已知角部代价（徽章是行为指示器，缺徽章无害）。
 */
export function annotateReadRelay(messages: readonly ChatMessage[]): void {
  let lsp: LspCallContext | null = null;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.blocks) {
      if (block.type !== "tool_call") continue;
      if (isLspToolCall(block.name)) {
        const result = typeof block.result === "string" ? block.result : "";
        const filePath = lspInputFilePath(block.input, block.result);
        if (result && filePath && isUsableLspResult(block.name, result)) {
          lsp = { filePath, result };
        }
        continue;
      }
      if (block.name === "Read" && block.lspRelay === undefined) {
        const verdict = judgeReadRelay(block.input, lsp);
        if (verdict) block.lspRelay = verdict;
      }
    }
  }
}

/**
 * Read 的行号区间文案（offset 为 1-based 起点、limit 为行数 → 区间
 * [offset, offset+limit-1]）。无 offset/limit（@mention 合成卡、整文件读）返回
 * null——整文件读的文案由 miss 徽章承担，这里不重复。
 */
export function readRangeLabel(input: unknown): string | null {
  const record = input as Record<string, unknown> | null;
  const offset = record?.offset;
  const limit = record?.limit;
  const off = typeof offset === "number" && Number.isFinite(offset) ? offset : null;
  const lim = typeof limit === "number" && Number.isFinite(limit) ? limit : null;
  if (off === null && lim === null) return null;
  if (off !== null && lim !== null) return `${off}–${off + lim - 1} 行 · ${lim} 行`;
  if (off !== null) return `自 ${off} 行`;
  return `前 ${lim} 行`;
}
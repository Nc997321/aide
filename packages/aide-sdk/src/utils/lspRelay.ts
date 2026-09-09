import type { ChatMessage, ContentBlock, LspRelayVerdict } from "../types/chat";

/**
 * F 方案（Read 接力显示）的判定核心：纯函数层，不碰 store、不碰 IO。
 *
 * 背景：LSP 工具给出精确定位（workspaceSymbol / findReferences / hover 的结果文本）
 * 之后，模型理想的行为是沿坐标 Read(offset, limit) 读小段；现实是它也可能无视
 * 坐标整文件读。这里的职责：给 assistant 的每次 Read 调用算出「接力了 / 没接力 /
 * 无从判定」三态，供工具卡头行渲染徽章。
 *
 * 判定依据刻意保持宽松——徽章是行为指示器不是契约证明：
 * 同一文件（basename 相等）+ LSP 结果非失败 + Read 带 offset ⇒ hit；
 * 同上但 Read 无 offset ⇒ miss（整文件读）。
 *
 * 已实测的 LSP 失败结果文本前缀（scripts/diag/lsp-probe-run{B,C,D2}.json）：
 * "No hover information available…" / "No symbols found…" / "No references
 * found…" / "No definition found…" / "Error performing hover…" / "Failed to
 * sync file open…" —— 统一按 no / error / failed 前缀识别。
 */

/** 一次已完成的 LSP 调用的判定上下文。 */
export interface LspCallContext {
  /** LSP 操作的目标文件（tool_use input.filePath） */
  filePath: string;
  /** 该调用的结果文本（tool_result；空/缺失视为未完成，不构成上下文） */
  result: string;
}

/** LSP 失败结果的统一前缀识别。误杀方向恒为中性（不打徽章）——禁止扩大前缀集：
 *  扩大只会把成功结果误判成失败，徽章永远往「缺」的方向偏，不往「错」偏。 */
const LSP_FAILED = /^(no\b|error|failed)/i;

/** 实时路径的回看扫描上限（块数）：防超长会话 O(n)。 */
const RECENT_BLOCK_CAP = 200;

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  // 此臂实际不可达（String.split 恒返回 ≥1 元素）；工程未开 noUncheckedIndexedAccess，
  // ?? "" 属防御性收窄而非编译所需
  return parts[parts.length - 1] ?? "";
}

/** LSP 工具 input 里的目标文件（实测 harness 格式为 camelCase filePath）。 */
function lspInputFilePath(input: unknown): string | null {
  const record = input as Record<string, unknown> | null;
  const filePath = record?.filePath;
  return typeof filePath === "string" && filePath ? filePath : null;
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
      if (block.name !== "LSP") continue;
      if (typeof block.result !== "string" || !block.result) continue;
      const filePath = lspInputFilePath(block.input);
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
      if (block.name === "LSP") {
        const filePath = lspInputFilePath(block.input);
        if (typeof block.result === "string" && block.result && filePath) {
          lsp = { filePath, result: block.result };
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
// Aide-controlled instruction loader.
//
// Replaces the SDK's filesystem setting-source loading with an explicit read of
// a short, known file list: the global CLAUDE.md in the Aide Claude config dir,
// the project-root one, and — per @-attached workspace (single-session
// cross-directory work) — that root's CLAUDE.md plus its auto-memory index. It
// NEVER reads .claude/settings*.json and never scans recursively. Each file is
// capped at 256 KiB; oversize or unreadable files yield a short diagnostics line
// so the query is never aborted, and a missing file is silently skipped.
//
// One block does not come from a file at all: Aide's own LSP navigation hint
// (lspHint.ts), injected only when the user actually has a language server —
// see that module for why. It goes first so Aide's layer reads above user rules.
//
// 生效窗口（方案 F6）：本函数只在 query spawn 时跑，而 query 全会话只 spawn 一次
// ⇒ 附加根的指令只在「首条消息带目录 / 新会话 / query 重启」进 system prompt；
// 中途 @ 的目录靠消息级目录段当轮送达（见 @aide/sdk 的 fileMentions.ts）。

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { memoryDirs } from "./memoryDirs.js";
import { loadLspHint } from "./lspHint.js";

const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
/** auto memory 索引（MEMORY.md）截断：前 200 行 / 25 KiB 先到先截——镜像 CLI 的加载
 *  语义（Rust 侧同规则：commands/memory_observatory/mod.rs:19-20）。 */
const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
/** 附加根区块的闸：最多 8 个根、合计 512 KiB（base 两块不在此预算内，各自 256 KiB
 *  的既有语义不变）。超限的表现是「整块跳过 + 一行诊断」——注入可以少，不能静默少。 */
const MAX_ATTACHED_ROOTS = 8;
const MAX_ATTACHED_BYTES = 512 * 1024;

/** `loadAideInstructions` 的输入面。对象化而非 4 个位置参数：`cwd`/`configDir` 相邻
 *  同型，调用点写反是静默错位（唯一调用点 queryContext.ts）。 */
export interface InstructionSources {
  /** 会话主根（= 会话 cwd）。 */
  cwd: string;
  /** Aide 的 Claude 配置根（CLAUDE_CONFIG_DIR）。 */
  configDir: string;
  /** 主根是否信任（受限模式跳过主根 CLAUDE.md）。**附加根不走这道门**（D8：@ 即信任）。 */
  trusted: boolean;
  /** 本会话的 @目录账本（附加根）。 */
  attached?: string[];
}

/**
 * Load and concatenate the Aide instruction blocks. Returns the joined text
 * (blocks separated by a blank line), or an empty string if there is nothing to
 * load. Never throws — a bad file becomes a diagnostics line so the caller's
 * `query()` is never blocked.
 */
export async function loadAideInstructions(p: InstructionSources): Promise<string> {
  const builtin = await loadLspHint(p.configDir);
  const base = await readBaseInstructions(p);
  const attached = await readAttachedInstructions(p.attached ?? [], p.configDir);
  return [...(builtin ? [builtin] : []), ...base, ...attached].join("\n\n");
}

/** 主根两块：全局 CLAUDE.md 恒读；主根 CLAUDE.md 仅在 trusted 时读——不让不受信任
 *  仓库植入的项目指令影响 agent 行为（受限模式语义，未变）。 */
async function readBaseInstructions(p: InstructionSources): Promise<string[]> {
  const files = [join(p.configDir, "CLAUDE.md")];
  if (p.trusted) files.push(join(p.cwd, "CLAUDE.md"));
  const chunks = await Promise.all(files.map((f) => readInstructionFile(f)));
  return chunks.filter((t): t is string => !!t && t.length > 0);
}

/** 附加根区块：逐根取块（并发）→ 过数量与总预算闸。读不到内容的根不是错误，
 *  只是这个仓既没有 CLAUDE.md 也没有记忆——静默略过。 */
async function readAttachedInstructions(attached: string[], configDir: string): Promise<string[]> {
  const kept = attached.slice(0, MAX_ATTACHED_ROOTS);
  const chunks = await Promise.all(kept.map((dir) => attachedRootChunk(dir, configDir)));
  const out = applyByteBudget(
    chunks.filter((t): t is string => !!t),
    MAX_ATTACHED_BYTES,
  );
  if (attached.length > kept.length) {
    out.push(`（附加工作区共 ${attached.length} 个，超过 ${MAX_ATTACHED_ROOTS} 个上限的部分未注入）`);
  }
  return out;
}

/** 一个附加根的指令块：来源头 + 本仓 CLAUDE.md + 该仓的 auto memory 索引。
 *  来源头不能省——两套规则混在同一个 system prompt 里，没有边界模型会把对方仓的
 *  约定当成主仓的。整块为空（既无 CLAUDE.md 也无记忆）时返回 null。 */
async function attachedRootChunk(dir: string, configDir: string): Promise<string | null> {
  const [rules, memory] = await Promise.all([
    readInstructionFile(join(dir, "CLAUDE.md")),
    readMemoryIndex(configDir, dir),
  ]);
  const body = [rules, memory].filter((t): t is string => !!t && t.length > 0);
  if (body.length === 0) return null;
  return [
    `--- 附加工作区指令：${dir} ---`,
    "（以下规则来自另一个仓库，仅当操作该仓库的文件时适用）",
    ...body,
  ].join("\n");
}

/** 附加根的 auto memory 索引：`<configDir>/projects/<key>/memory/MEMORY.md`。
 *  一个工作区可能因编码版本分裂成多个 projects 目录（dot 归一，见 memoryDirs），
 *  取第一个读到的。读不到 = 这个仓还没有记忆，不是错误。 */
async function readMemoryIndex(configDir: string, dir: string): Promise<string | null> {
  for (const memoryDir of memoryDirs(configDir, dir)) {
    const text = await readTextOrNull(join(memoryDir, "MEMORY.md"));
    if (text && text.length > 0) return truncateMemoryIndex(text);
  }
  return null;
}

/** 先截行、再截字节（两个上限谁先到谁生效），尾部留一行说明。 */
function truncateMemoryIndex(text: string): string {
  const lines = text.split("\n");
  const byLines = lines.slice(0, MEMORY_INDEX_MAX_LINES).join("\n");
  const cut = sliceBytes(byLines, MEMORY_INDEX_MAX_BYTES);
  return cut === text ? text : `${cut}\n…（记忆索引过长，已截断）`;
}

/** 按**字节**截断：stat 与 CLI 的口径都是字节，而 JS 字符串按 UTF-16 计长——
 *  中文会松 3 倍。切断多字节序列时尾部会出现一个替换字符，可接受。 */
function sliceBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  return buf.length <= maxBytes ? text : buf.subarray(0, maxBytes).toString("utf8");
}

/** 按顺序装入，装不下的**整块**跳过（半个 CLAUDE.md 比没有更误导），留一行诊断。 */
function applyByteBudget(chunks: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(chunk, "utf8");
    if (used + size > budget) {
      skipped += 1;
      continue;
    }
    out.push(chunk);
    used += size;
  }
  if (skipped > 0) out.push(`（附加工作区指令超过 ${budget} 字节上限，${skipped} 块未注入）`);
  return out;
}

/** 单个指令文件：不存在 → null；超限或读失败 → 一行诊断（绝不抛、绝不阻断 query）。 */
async function readInstructionFile(path: string): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // Missing file (ENOENT) or stat failure — silently skip. Not a diagnostic
    // case: most projects legitimately have no project-root CLAUDE.md.
    return null;
  }
  if (size > MAX_INSTRUCTION_FILE_BYTES) {
    return `（${path} 超过 256 KiB 上限，已跳过加载）`;
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    return `（${path} 读取失败，已跳过）`;
  }
}

/** 读一个可能不存在的文本文件；读失败一律 null（记忆索引缺失是常态，不是错误）。 */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

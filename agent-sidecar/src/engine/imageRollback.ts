// 图片 400 回滚：模型不支持图片时，从 SDK 会话历史里移除带图消息，
// 让会话不报废（历史里带图消息重放必 400，见 docs 讨论）。
//
// 独立模块、纯函数 + 文件操作，worker 只做薄接线（检测 → 调这里 → 重启 query）。
import { existsSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyImageInputResult, extractMessageText, IMAGE_UNSUPPORTED_400 } from "./imageInputCapability.js";
import { buildUserMessage } from "./mapper.js";
import type { ChatEvent } from "./types.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** 识别「模型不支持图片」的 400 错误消息（SDK 的两种形态）：
 *  - synthetic assistant 消息（真实 SDK 事件流形状：is_api_error_message + model="<synthetic>"，
 *    2026-08-21 smoke 实锤——CLI 写 jsonl 用 camelCase isApiErrorMessage，但 SDK 事件
 *    转发时是 snake_case is_api_error_message，camelCase 分支实际永不命中）
 *  - result 错误消息（部分网关让 CLI 非零退出时走这条） */
export function detectImageUnsupported(msg: unknown): boolean {
  const m = msg as {
    type?: unknown;
    isApiErrorMessage?: unknown;
    apiErrorStatus?: unknown;
    is_api_error_message?: unknown;
  };
  if (
    m?.type === "assistant" &&
    (m.isApiErrorMessage === true || m.is_api_error_message === true)
  ) {
    return IMAGE_UNSUPPORTED_400.test(extractMessageText(msg));
  }
  return classifyImageInputResult(msg) === false;
}

/** 按 session id 在 projects 目录下扫描 jsonl。
 *  不自己编码 cwd——Claude 的文件夹编码规则可能和 aide 不同（`.` 编码差异），
 *  与 Rust 侧 find_session_jsonl_in 同策略：id 是 UUID 全局唯一，至多命中一个。 */
export function findSessionJsonl(projectsDir: string, sessionId: string): string | null {
  const name = `${sessionId}.jsonl`;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(projectsDir, entry.name, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** content 数组里是否含图片块（直接块，或 tool_result 嵌套块）。 */
function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const b = block as { type?: unknown; content?: unknown };
    if (b.type === "image") return true;
    if (b.type === "tool_result" && Array.isArray(b.content)) {
      return contentHasImage(b.content);
    }
    return false;
  });
}

/** content 数组里是否有直接 image block（用户发图）；tool_result 嵌套图不算。 */
function hasDirectImageBlock(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "image");
}

/** 场景 B 的错误反馈文本：替换 tool_result 图片内容，让模型看到明确错误后
 *  自行决定下一步（读文本/跳过），而不是反复重读图片（回滚不删行、保留
 *  tool_use 配对）。刻意不预设"必有文本可读"——纯视觉内容没有文本，OCR
 *  也无从谈起，模型自己判断。 */
const TOOL_IMAGE_ERROR_TEXT =
  "图片输入不可用：当前模型不支持图片输入（API 返回 400 this model does not support image input）。" +
  "请勿再读取图片文件。若文件存在可读取的文本内容，可改为读取文本；" +
  "否则跳过该文件，继续处理用户的问题。";

/** 把 content 里所有带图的 tool_result 替换为错误文本（is_error 置 true）。
 *  返回是否替换了至少一个。 */
function replaceToolResultImages(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  let replaced = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; content?: unknown; is_error?: unknown };
    if (b.type === "tool_result" && Array.isArray(b.content) && contentHasImage(b.content)) {
      b.content = TOOL_IMAGE_ERROR_TEXT;
      b.is_error = true;
      replaced = true;
    }
  }
  return replaced;
}

/** 提取 user 消息里的文本（text block 拼接；tool_result 是工具输出，不算用户文本）。 */
function extractUserText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
}

/** synthetic 图片 400 错误行（isApiErrorMessage/is_api_error_message + apiErrorStatus 400 + 文本匹配）。
 *  jsonl 里 CLI 写 camelCase（实测）；SDK 事件流是 snake_case——两态都认。 */
function isSyntheticImageError(msg: unknown): boolean {
  const m = msg as {
    type?: unknown;
    isApiErrorMessage?: unknown;
    apiErrorStatus?: unknown;
    is_api_error_message?: unknown;
  };
  if (
    m?.type !== "assistant" ||
    (m.isApiErrorMessage !== true && m.is_api_error_message !== true) ||
    m.apiErrorStatus !== 400
  ) return false;
  return IMAGE_UNSUPPORTED_400.test(extractMessageText(msg));
}

export interface RollbackResult {
  /** 被移除消息的文本（前端放回输入框用）；无文本为 ""。 */
  text: string;
  /** 是否真的移除了消息（无带图消息 / 文件不存在 → false，不写文件）。 */
  removed: boolean;
  /** 回滚形态：user = 用户直接发图（整条消息删除，文本回输入框）；
   *  tool = 模型 Read 图片（tool_result 图片替换为错误文本，保留 tool_use 配对，
   *  模型看到错误后改读文本，不会反复读图）。 */
  kind: "user" | "tool";
}

/** jsonl 按行解析，记录每行字节偏移（供截断用）。兼容 \r\n / \n；\r 留在 text 里由调用方 trim。 */
interface JsonlLine {
  /** 行首字节偏移（截断点：set_len 到此处 = 保留该行之前的全部内容） */
  start: number;
  /** 行文本（不含换行符） */
  text: string;
}

function parseLines(buf: Buffer): JsonlLine[] {
  const lines: JsonlLine[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push({ start, text: buf.toString("utf8", start, i).replace(/\r$/, "") });
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lines.push({ start, text: buf.toString("utf8", start) });
  }
  return lines;
}

/** 回滚：处理最后一条带图片的 user 消息，并清掉所有图片 400 的 synthetic 错误行。
 *  - 用户直接发图（image block 在 user 消息里）：字节截断到该行前——与通用
 *    rewind（ChangeLogPanel 撤回 / truncate jsonl）同一语义：该轮及其后内容
 *    （模型回复、synthetic 400、半截写入的不完整行）一并移除。
 *  - 模型 Read 图片（图片在 tool_result 嵌套里）：不截断——截断会丢整轮工具
 *    进度；改为把 tool_result 图片替换成错误文本回喂模型，让它改读文本。
 *    该分支整文件重写（保留 tool_use/tool_result 配对，API 要求严格配对）。
 *  调用方保证在 CLI 进程已退出后调用（abort 之后），避免与 CLI 的 append 写入竞争。 */
export function rollbackImageMessage(jsonlPath: string): RollbackResult {
  if (!existsSync(jsonlPath)) return { text: "", removed: false, kind: "user" };

  const lines = parseLines(readFileSync(jsonlPath));

  // 反向扫描找最后一条带图 user 消息（就是刚发的那条）
  let targetIndex = -1;
  let removedText = "";
  let kind: "user" | "tool" = "user";
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].text.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const m = msg as { type?: unknown; message?: { content?: unknown } };
    if (m?.type !== "user" || !contentHasImage(m.message?.content)) continue;
    targetIndex = i;
    // 直接 image block = 用户发图；图片只在 tool_result 里 = 模型 Read 图片。
    // 场景 B 用户文本仍在历史里（消息不删），不回填输入框。
    kind = hasDirectImageBlock(m.message?.content) ? "user" : "tool";
    removedText = kind === "user" ? extractUserText(m.message?.content) : "";
    break;
  }
  if (targetIndex < 0) return { text: "", removed: false, kind: "user" };

  if (kind === "user") {
    // 场景 A：字节截断到该行前。不重写文件——synthetic 400 / 半截写入的行
    // 都在该行之后，天然一并移除（比逐行重写更安全：不再构造孤儿回复）。
    truncateSync(jsonlPath, lines[targetIndex].start);
    return { text: removedText, removed: true, kind: "user" };
  }

  // 场景 B：保留行，替换 tool_result 图片为错误文本（tool_use 配对不破），
  // 并清掉所有 synthetic 400 行，整文件重写。
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === targetIndex) {
      const msg = JSON.parse(lines[i].text);
      replaceToolResultImages((msg as { message?: { content?: unknown } }).message?.content);
      kept.push(JSON.stringify(msg));
      continue;
    }
    const trimmed = lines[i].text.trim();
    if (!trimmed) {
      kept.push(lines[i].text);
      continue;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      kept.push(lines[i].text);
      continue;
    }
    if (isSyntheticImageError(msg)) continue;
    kept.push(lines[i].text);
  }

  writeFileSync(jsonlPath, kept.join("\n"));
  return { text: removedText, removed: true, kind: "tool" };
}

// ---- 回滚执行（历史住 session-worker.ts 的 performImageRollback 方法体，纯移动
//      注依赖化：worker 只留薄接线，检测 → 调这里 → 预置注入消息） ----

/** 场景 B 自动继续的注入消息：CLI resume 会话后必须收到输入才会重放历史
 *  （2026-08-21 实锤：resume 无输入 → CLI 0 事件直接退出）。注入这条 user
 *  消息触发 CLI 重放历史（含错误文本 tool_result）→ 模型自行判断下一步：
 *  能读就读，不能读就自然告知用户跳过。措辞刻意不预设"有文本可读"
 *  （图片可能是纯视觉内容，OCR 无效），并引导模型回复时别复述技术细节
 *  （"模型不支持图片输入"这类内部错误，用户看到会一头雾水）。该消息只进
 *  会话 jsonl，SDK 事件流不回显 user 消息，前端不会出现多余气泡。 */
export const ROLLBACK_TOOL_CONTINUE =
  "请继续处理用户的问题。刚才读取图片文件未获得可用内容，请忽略该次操作。" +
  "若该文件内容确实无法读取，可自然地向用户说明无法查看该文件并继续，不要提及任何技术细节。";

export interface ImageRollbackDeps {
  /** 子进程实际生效的配置根（worker 的 subprocessConfigDir）；空 = 静默跳过。 */
  configDir: string | undefined;
  /** fork/resume 源（SDK 会话 ID）；空 = 静默跳过。 */
  sessionId: string;
  emit: (e: ChatEvent) => void;
}

/** 从 SDK 会话历史移除带图消息（含 synthetic 400 行），让下一轮 query 重放干净
 *  历史。调用时机：abort 之后（CLI 已退出，文件不再被写）。返回场景 B 需要预置
 *  到下一轮私有迭代器的注入消息（null = 无需注入）。失败静默返回 null——会话
 *  保持现状，至少不 crash。 */
export function rollbackImageHistory(deps: ImageRollbackDeps): SDKUserMessage | null {
  try {
    const { configDir, sessionId } = deps;
    if (!configDir || !sessionId) return null;
    const jsonl = findSessionJsonl(join(configDir, "projects"), sessionId);
    if (!jsonl) return null;
    const result = rollbackImageMessage(jsonl);
    if (!result.removed) return null;
    deps.emit({ type: "image_input_rollback", text: result.text });
    if (result.kind !== "tool") return null;
    // 场景 B（模型 Read 图片）：回滚只替换了 tool_result，模型还没回复——
    // resume 后 CLI 等输入，不注入消息模型不会自动继续。注入后 CLI 重放
    // 历史（含错误文本 tool_result）→ 模型改读文本/跳过。
    // 注意：调用方不能 queue.push——旧迭代器挂起的 resolveNext 会把消息吞掉
    // （见 worker 的 rollbackInjection 字段注释），必须预置到下一轮私有迭代器。
    return {
      type: "user",
      message: buildUserMessage(ROLLBACK_TOOL_CONTINUE, []),
      parent_tool_use_id: null,
    };
  } catch {
    // 回滚失败（文件占用等）：会话保持现状，至少不 crash
    return null;
  }
}

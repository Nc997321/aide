import { nextTick, type Ref } from "vue";
import { api } from "../api";
import { parseMentionPath, normalizeMentionPath, joinPath, isAbsoluteishPath } from "../utils/fileMentions";

// 路径语法（拼接/绝对性判定）已迁到 SDK 的 fileMentions（mention 路径的唯一真相源）；
// 这里 re-export 给既有调用点（SearchPanel、本模块单测），新代码请直接引包。
export { joinPath, isAbsoluteishPath };

/**
 * 输入框的 `@path `→mention 小卡片转换层（唯一的转换机制，与来源无关）。
 *
 * 任何来源把文件路径以 `@path ` 文本放进 textarea——手打 `@path`+空格、粘贴
 * OS 文件（paste 管道产出 `@path ` 文本）、拖入 OS 文件 / 文件树节点（drop
 * 管道产出 `@path ` 文本）——都由这里的 `@input` 检测统一扫描 `inputText`，
 * 把"真实存在的路径"片段替换成 mention 芯片（经 `addMention` 回调推入
 * `pendingMentions`），发送时由 `handleSend` 展开成 `@path` 前缀。
 *
 * token 可带行号后缀（`@path:12-48`，编辑器选区引用的文本形态）：`path_types`
 * 只认真实路径，所以校验前先剥后缀，命中后再把区间原样带回芯片。
 *
 * 设计要点：
 * - 触发＝`@token` 后紧跟空格；`@` 前须为边界（行首/空白），不误吞邮箱 `a@b.com`。
 * - 仅真实存在的路径才转（`path_types` 返回 file/dir）；不存在保留纯文本。
 * - 多 token 一次批量 `path_types`（一次 IPC 处理多文件粘贴/拖入）。
 * - 异步竞态：请求序号 + 转换前片段复核双保险。
 *
 * 纯函数（`findMentionTokens` / `resolveCandidates`）导出供单测，不依赖 Vue 运行时；
 * 路径语法（`joinPath` / `isAbsoluteishPath`）见 SDK 的 fileMentions.ts。
 */

export interface MentionTokenMatch {
  /** `@` 在文本中的索引 */
  atIdx: number;
  /** 片段结束索引（含尾随空格，即 `@token ` 之后的下标） */
  endPos: number;
  /** `@` 与尾随空格之间的 token 原文 */
  token: string;
}

/**
 * 把一个 `@token` 解析为待校验的候选绝对路径（单个）。
 * - token 形似绝对路径（盘符/根/UNC）：直接用 token 本身（不拼到 workspace 下）。
 * - 相对 token + workspace：`joinPath(workspace, token)`。
 * - 相对 token + 无 workspace：只能试 token 原文。
 */
export function resolveCandidate(token: string, workspacePath: string): string {
  if (isAbsoluteishPath(token)) return token;
  if (workspacePath) return joinPath(workspacePath, token);
  return token;
}

/**
 * 扫描文本里所有 `@token ` 模式（`@` + 非空白非@字符 + 一个空格）。
 * `@` 前须为边界（行首或空白字符），否则跳过——避免误吞邮箱 `a@b.com`。
 * 用字面量空格而非 `\s`，避免吃掉用户输入的换行/制表符。
 */
export function findMentionTokens(text: string): MentionTokenMatch[] {
  const re = /@([^\s@]+) /g;
  const out: MentionTokenMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const atIdx = m.index;
    if (atIdx > 0 && !/\s/.test(text[atIdx - 1])) continue;
    out.push({ token: m[1], atIdx, endPos: atIdx + m[0].length });
  }
  return out;
}

export function useInlineMention(opts: {
  inputText: Ref<string>;
  textareaEl: Ref<HTMLTextAreaElement | null | undefined>;
  workspacePath: () => string;
  addMention: (path: string, isDir: boolean, range?: { start: number; end: number }) => void;
}): { onInput: (e: InputEvent) => void; scan: () => Promise<void> } {
  // 单调递增的请求序号：异步校验回来时若已过期（用户又编辑了）即弃。
  let seq = 0;

  function onInput(e: InputEvent) {
    // IME 组合输入期间不转换（避免打断中文/日文输入）。
    if (e.isComposing) return;
    void scanAndConvert();
  }

  async function scanAndConvert() {
    const mySeq = ++seq;
    const text = opts.inputText.value;
    const matches = findMentionTokens(text);
    if (matches.length === 0) return;

    const ws = opts.workspacePath();
    // 行号后缀不参与路径解析/校验：剥掉后解析，命中再随芯片带回区间。
    const parsed = matches.map((m) => parseMentionPath(m.token));
    const candidates = parsed.map((p) => resolveCandidate(p.path, ws));
    const allCandidates = Array.from(new Set(candidates));
    if (allCandidates.length === 0) return;

    let types: ("file" | "dir" | "none")[];
    try {
      types = await api.pathTypes(allCandidates);
    } catch {
      return; // IPC 失败：保留纯文本，不阻断输入
    }
    if (mySeq !== seq) return; // 过期

    const typeByPath = new Map(allCandidates.map((p, i) => [p, types[i]]));

    // 逐 token 取命中类型
    const hits = matches.map((m, i) => {
      const t = typeByPath.get(candidates[i]);
      if (t === "file" || t === "dir") {
        // 入芯片前剥尾分隔符：`@C:\a\ ` 与 `@C:\a ` 是同一个目录，别生成两个芯片
        // （芯片去重键是路径文本，见 ChatInputBox.mentionKey）。
        return {
          match: m,
          path: normalizeMentionPath(candidates[i]),
          isDir: t === "dir",
          range: parsed[i].range,
        };
      }
      return null;
    });

    // 从后往前复核+替换，避免索引偏移；异步期间用户若已编辑该片段则跳过。
    let text2 = opts.inputText.value;
    const applied: Array<{ atIdx: number; path: string; isDir: boolean; range?: { start: number; end: number } }> = [];
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (!h) continue;
      const { token, atIdx, endPos } = h.match;
      if (text2.slice(atIdx, endPos) !== `@${token} `) continue; // 片段已变，放弃
      text2 = text2.slice(0, atIdx) + text2.slice(endPos);
      applied.unshift({ atIdx, path: h.path, isDir: h.isDir, range: h.range });
    }
    if (applied.length === 0) return;

    opts.inputText.value = text2;
    for (const a of applied) opts.addMention(a.path, a.isDir, a.range);

    // 光标回到首个被替换处（最小 atIdx），避免跳到末尾。
    const cursorTarget = applied[0].atIdx;
    void nextTick(() => {
      const ta = opts.textareaEl.value;
      if (!ta) return;
      try {
        ta.setSelectionRange(cursorTarget, cursorTarget);
      } catch {
        /* 忽略 */
      }
    });
  }

  return { onInput, scan: scanAndConvert };
}
import { buildChangeInfo } from "../utils/changeCard";
import type { ChangeFile } from "../types";

/**
 * 变更归属归集器：回答「这一轮改了哪些文件」，答案取自**事件流**，不从工作树反推。
 *
 * ## 为什么不能从 git diff 反推（2026-09-09 定论）
 *
 * 工作树是**全体共享**的一份状态：git 只看得见「某文件与 HEAD 不同」，看不见
 * 「是谁让它不同的」。于是任何基于 diff 的归集都会把别的会话、别的工具、用户
 * 自己的改动一并算进正在跑的那一轮——运维会话里窜进 186 个编码会话的文件就是
 * 这么来的（旧实现在 `useConversationChanges` 里用轮首快照做时间窗差分，滤掉的
 * 只是「上一轮之后没再变过的」，滤不掉「别人在我这轮期间改的」）。
 *
 * 而工具调用事件天然带 `session_id`，归属是**一等公民**，不需要推断。
 *
 * ## 本模块的位置
 *
 * 纯内存旁路：吃 `tool_use_start` 事件 → 按 sid 分桶 → 调用方用 `drain(sid)`
 * 游标取走增量（一次轮固化 = 一次 drain；轮进行中的实时刷新 = 反复 drain+merge）。
 * git 在下游只做**校验者**：补 status / 行数，**不发现新条目**——发现权归事件，
 * 这是「外来文件混不进列表」的唯一保证。
 *
 * 不挂消息 store：消息块会被体积回收（`useChatSession/evict.ts`），长会话与后台
 * 会话的块会被丢弃，从渲染数据反推归属必然漏。
 */

/** 单片段字符上限：超出不收集。
 *
 *  Write 的 input 是整文件全文（几十 KB 很常见），全存进内存没有收益。该文件因此
 *  没有片段 → 整轮退化为累计视图——与「历史轮无片段」走**同一条** fallback 路径，
 *  不新增分支类型。 */
const MAX_SEGMENT_CHARS = 20_000;

/** 单文件片段数上限：同一文件在一轮里被反复 Edit 时只保留前 N 个片段。
 *  行数统计不受影响——「改了哪些文件、改了多少」是核心需求，片段只是增强。 */
const MAX_SEGMENTS_PER_FILE = 12;

/** 与 git 侧 `DiffEntry.status` 对齐（"M"/"A"/"D"）。
 *  事件侧只能分辨 M/A：删除是 Bash/mv 的产物，工具调用事件里看不到（已知代价）。 */
export type TouchedStatus = "M" | "A";

/** 一次工具调用造成的改动片段（片段级 diff：不是全文件）。 */
export interface ChangeSegment {
  oldText: string;
  newText: string;
  addCount: number;
  delCount: number;
}

export interface TouchedFile {
  /** 相对工作区根的路径——撤回（`git checkout -- <rel>`）、展示、git 校验都要这个。
   *  绝对路径不另存：`join(wsRoot, relPath)` 是确定组合，存两份就互为派生、
   *  可能因工作区切换而不一致。 */
  relPath: string;
  status: TouchedStatus;
  additions: number;
  deletions: number;
  /** 本轮内该文件的片段序列，按发生顺序。空数组 = 无片段 → 走累计视图。 */
  segments: ChangeSegment[];
}

/** 一次 drain 的结果。`wsRoot` 是**会话级**事实（这个会话属于哪个工作区），
 *  文件条目不再各自重复一份。 */
export interface RoundTouches {
  wsRoot: string;
  files: TouchedFile[];
}

export interface AttributionDeps {
  /** 会话 → 工作区根。`null` = 未绑定工作区 → 不归集（见 `ingest` 的边界规则）。 */
  rootOf: (sid: string) => string | null;
  /** 会话是否可跟踪；缺省 = 全部可跟踪。自动化运行（`markSessionUntracked`）没有
   *  轮次视图，归集进去的数据永远无人消费，只会在内存里堆积。 */
  isTracked?: (sid: string) => boolean;
}

export interface ChangeAttribution {
  /** 吃一条 chat-event。非变更类工具、无法归属的事件静默丢弃。 */
  ingest(event: Record<string, unknown>): void;
  /** 取走该会话自上次 drain 以来新触碰的文件（游标推进）。无增量返回 `null`。 */
  drain(sid: string): RoundTouches | null;
  /** 丢弃该会话的桶（会话销毁 / 轮次清理时收口，防无界增长）。 */
  forget(sid: string): void;
}

interface Bucket {
  wsRoot: string;
  files: Map<string, TouchedFile>;
}

/** Windows 路径分隔符统一：`\` → `/`。git 给相对路径，Claude 给绝对路径，
 *  两边分隔符都可能不一致，所有比较先过这里。 */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * 绝对路径 → 相对工作区根；不属于该工作区返回 `null`。
 *
 * 边界规则：工作区外文件**不归集**。漏是安全失败，且撤回对工作区外文件本就无意义
 * ——语义上它也不属于「本会话在我这个项目里改了什么」。
 */
export function toRelPath(wsRoot: string, absPath: string): string | null {
  const root = normalizeSep(wsRoot).replace(/\/+$/, "");
  if (!root) return null;
  const abs = normalizeSep(absPath);
  // Windows 大小写不敏感：前缀比较统一转小写，切分仍用原始形态（路径保真）。
  if (!abs.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  return abs.slice(root.length + 1);
}

export function createChangeAttribution(deps: AttributionDeps): ChangeAttribution {
  const buckets = new Map<string, Bucket>();

  function ingest(event: Record<string, unknown>): void {
    if (event["type"] !== "tool_use_start") return;
    const sid = event["session_id"];
    if (typeof sid !== "string" || !sid) return;
    if (deps.isTracked && !deps.isTracked(sid)) return;

    const name = event["name"];
    if (typeof name !== "string") return;
    // 白名单内嵌在 buildChangeInfo：只认 Edit / Write / NotebookEdit 三种能解析出
    // 文件路径与新旧文本的工具，其余（Read/Bash/Grep…）返回 null 静默跳过。
    const info = buildChangeInfo(name, event["input"]);
    if (!info) return;

    // 归属：会话 → 工作区根。未绑定 = 不知道这改动落在哪个项目，宁可不记
    // （与「未跟踪会话不归集」同一条规则，不新增分支类型）。
    let bucket = buckets.get(sid);
    if (!bucket) {
      const root = deps.rootOf(sid);
      if (!root) return;
      bucket = { wsRoot: root, files: new Map() };
      buckets.set(sid, bucket);
    }

    const rel = toRelPath(bucket.wsRoot, info.filePath);
    if (!rel) return;

    // Write 写整文件：相对 HEAD 一律视为新增（即使覆盖已存在的文件——本轮语义下
    // 「本会话新建」比「本会话修改」更贴近，且 status 下游由 git 校验覆盖）。
    const isWrite = name === "Write";
    let file = bucket.files.get(rel);
    if (!file) {
      file = {
        relPath: rel,
        status: isWrite ? "A" : "M",
        additions: 0,
        deletions: 0,
        segments: [],
      };
      bucket.files.set(rel, file);
    }
    if (isWrite) file.status = "A";
    file.additions += info.addCount;
    file.deletions += info.delCount;

    if (
      file.segments.length < MAX_SEGMENTS_PER_FILE
      && info.pair.oldText.length <= MAX_SEGMENT_CHARS
      && info.pair.newText.length <= MAX_SEGMENT_CHARS
    ) {
      file.segments.push({
        oldText: info.pair.oldText,
        newText: info.pair.newText,
        addCount: info.addCount,
        delCount: info.delCount,
      });
    }
  }

  function drain(sid: string): RoundTouches | null {
    const bucket = buckets.get(sid);
    if (!bucket || bucket.files.size === 0) return null;
    buckets.delete(sid); // 游标推进：取走即清空
    return { wsRoot: bucket.wsRoot, files: [...bucket.files.values()] };
  }

  function forget(sid: string): void {
    buckets.delete(sid);
  }

  return { ingest, drain, forget };
}

/** 合并两次 drain 的增量（轮进行中反复刷新时用）：同路径累加行数、拼接片段。
 *  status 取「新增优先」——任一段是 Write 即视为本轮新建。 */
export function mergeTouches(base: TouchedFile[], incoming: TouchedFile[]): TouchedFile[] {
  const merged = new Map<string, TouchedFile>();
  // 单一追加路径：新建条目与已存在条目走同一套累加/封顶规则——分成两条分支的话，
  // 上限只会在其中一条上生效（首次合并漏掉封顶就是这么来的）。
  const absorb = (src: TouchedFile) => {
    let cur = merged.get(src.relPath);
    if (!cur) {
      cur = { relPath: src.relPath, status: "M", additions: 0, deletions: 0, segments: [] };
      merged.set(src.relPath, cur);
    }
    if (src.status === "A") cur.status = "A";
    cur.additions += src.additions;
    cur.deletions += src.deletions;
    for (const seg of src.segments) {
      if (cur.segments.length >= MAX_SEGMENTS_PER_FILE) break;
      cur.segments.push(seg);
    }
  };
  for (const f of base) absorb(f);
  for (const f of incoming) absorb(f);
  return [...merged.values()];
}

/** 归集结果 → 落盘形状（剥掉内存片段）。
 *  `ChangeFile` 是全链路唯一接缝，落盘格式与面板 props 都不因归集换源而变。 */
export function toChangeFiles(files: TouchedFile[]): ChangeFile[] {
  return files.map((f) => ({
    path: f.relPath,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

/** 整轮能否用「片段视图」：所有文件都有片段才成立。
 *
 *  以**轮**为单位判定，不是以文件为单位——同一轮里一半本轮 diff、一半累计 diff，
 *  用户无从判断哪个可信。整轮二态，规则一句话说得清。 */
export function isSegmentedRound(files: TouchedFile[]): boolean {
  return files.length > 0 && files.every((f) => f.segments.length > 0);
}

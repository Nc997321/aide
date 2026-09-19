import { computed, ref, type ComputedRef, type Ref } from "vue";
import { api } from "@aide/sdk/api";
import {
  isAbsoluteishPath, isSameOrInside, joinPath, type DirEntry,
} from "@aide/sdk/utils/fileMentions";

/**
 * 输入框 `@` 补全：光标锚定 token → 逐级列目录 → 候选行。
 *
 * 与 `/` 菜单的分工：`/` 看整串文本（必须以 `/` 开头且无空格），`@` 必须看**光标**
 * ——同一个 `@src/co` 在句中、在行尾、光标停在中间，含义都不同。
 *
 * 数据源两条：
 * - 本层：`list_directory`（同层打字**零 IPC**——命令内缓存该目录的 entries 本地筛）。
 * - 全仓兜底：`find_files_by_name`（gitignore 感知、只回文件），只在**没敲到分隔符**时
 *   跑，且防抖 + 序号防竞态：它是遍历，不能每敲一个字就来一次。
 *
 * 动作语义见 `applyPick`：下钻（→）不带尾空格，引用（回车/Tab）带尾空格——
 * 尾空格是既有 `useInlineMention` 认领 token 转芯片的触发条件，别少也别多。
 *
 * 纯函数全部导出供单测，不依赖 Vue 运行时（与 useInlineMention 同款分层）。
 */

/** 候选行上限：8 行 ≈ 252px，正好不触发弹层 280px 的滚动。 */
export const MAX_SUGGESTIONS = 8;
/** 向 Rust 要的全仓兜底条数：合并去重前多取一些，封顶交给 mergeSuggestions。 */
const FUZZY_FETCH_LIMIT = 30;
/** 全仓兜底防抖：遍历型查询，落键中途不跑。 */
const FUZZY_DEBOUNCE_MS = 180;

export interface MentionToken {
  /** `@` 在文本中的下标 */
  at: number;
  /** `@` 与光标之间的查询串 */
  query: string;
}

/** 候选来源。三态合一（不是多个 bool）——UI 按它挂「项目」/「全仓」弱标签。 */
export type SuggestOrigin = "local" | "fuzzy" | "project";

export interface MentionSuggestion {
  name: string;
  /** 行尾展示的目录：本层/兜底＝所在目录，项目＝父目录（同名项目靠它区分），根层 = "" */
  dir: string;
  isDir: boolean;
  /** 写回 `@rel` 用的路径（本层＝目录前缀 + 名字；项目＝登记表的原样绝对路径） */
  rel: string;
  origin: SuggestOrigin;
}

/** 项目候选的来源形状：`WorkspaceInfo` 的结构子集（`name` 就是注册表里的绝对路径）。 */
export interface ProjectSource {
  name: string;
  missing?: boolean;
}

export interface PickResult {
  text: string;
  caret: number;
}

/**
 * 光标锚定的 `@token`：从光标往前扫到空白得到片段，取片段里最后一个 `@`，
 * 要求它前面是行首或空白——否则不触发（邮箱 `a@b.com` 的 `@` 前面是 `a`）。
 * 光标一旦离开 token（后面还隔着空格）就自然返回 null，菜单随之关闭。
 */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  let i = caret;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  const at = text.slice(i, caret).lastIndexOf("@");
  if (at < 0) return null;
  if (i + at > 0 && !/\s/.test(text[i + at - 1])) return null;
  return { at: i + at, query: text.slice(i + at + 1, caret) };
}

/** 按最后一个分隔符切：`dir` 含尾分隔符（照用户敲的原样写回），`leaf` 是过滤前缀。 */
export function splitQueryPath(query: string): { dir: string; leaf: string } {
  const idx = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  return idx < 0 ? { dir: "", leaf: query } : { dir: query.slice(0, idx + 1), leaf: query.slice(idx + 1) };
}

/**
 * 剥掉尾分隔符（列目录与缓存键用）：`@src/` 的尾斜杠是书写痕迹，与目录身份无关，
 * 不剥的话 `@src/` 与 `@src\` 会各自产生一条缓存。裸盘符（`C:`）是例外——那是
 * 「C 盘当前目录」不是「C 盘根」，必须留着斜杠。
 */
function stripTrailingSep(p: string): string {
  const stripped = p.replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}/` : stripped;
}

/** 目录前缀 + 名字拼成写回路径（前缀的尾分隔符先剥，根层直接给名字）。 */
function joinRel(dir: string, name: string): string {
  const base = dir.replace(/[\\/]+$/, "");
  return base ? `${base}/${name}` : name;
}

/** 已列目录的结果缓存：同层打字不再发 IPC。 */
interface ListingCache {
  dirAbs: string;
  entries: DirEntry[];
}

/** 本层候选：按叶子前缀筛（大小写不敏感），目录在前、同组按名升序（对齐 Rust 的排序）。
 *  `dir` 存**剥尾分隔符**的展示形态（`@src/` 的 dir 是 `src/`，留着会被 RTL 渲染翻成前导斜杠）。 */
export function localSuggestions(entries: DirEntry[], ctx: { dir: string; leaf: string }): MentionSuggestion[] {
  const q = ctx.leaf.toLowerCase();
  const dir = stripTrailingSep(ctx.dir);
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(q))
    .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    .map((e) => ({ name: e.name, dir, isDir: e.is_dir, rel: joinRel(dir, e.name), origin: "local" as const }));
}

/** 路径末段（项目行的显示名）；没有分隔符或末段为空（盘符根）时回落整串，避免出现空白行。 */
function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 父目录（项目行行尾显示它）；没有分隔符时给空串。 */
function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const cut = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return cut < 0 ? "" : norm.slice(0, cut);
}

/**
 * 其它已注册工作区（项目）候选：
 * - 剔 `missing`（登记的路径已不在，列出来只会让人选了才发现）；
 * - 剔**当前会话工作区自己与它的祖先**——「其它项目」是"不是我所在的地方"，引用自己的
 *   cwd 没有意义（本层条目已经在候选里了）。判据用 SDK 的 `isSameOrInside`，与发送侧
 *   剔「主根子树」同一把尺子（别在调用点手搓 strip_prefix）。
 * - 叶子按**项目名包含**匹配（`@api` 命中 `backend-api`）；叶子为空则全列——这就是
 *   「@ 时看得见其它项目」的入口。
 * - `rel` 用登记表里的**原样**绝对路径（写回文本与 Rust 授权判定都认它，不做归一）。
 */
export function projectSuggestions(
  projects: ProjectSource[],
  ctx: { sessionWs: string; leaf: string },
): MentionSuggestion[] {
  const q = ctx.leaf.toLowerCase();
  return projects
    .filter((p) => !p.missing)
    .filter((p) => !isSameOrInside(ctx.sessionWs, p.name))
    .map((p) => ({
      name: baseName(p.name),
      dir: parentPath(p.name),
      isDir: true,
      rel: p.name,
      origin: "project" as const,
    }))
    .filter((r) => !q || r.name.toLowerCase().includes(q));
}

/** 绝对路径相对化（分隔符归一到 `/`）；不在工作区下就原样返回绝对路径。 */
function toRelPath(abs: string, root: string): string {
  const p = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!r || !p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p;
  return p.slice(r.length + 1);
}

/** 全仓兜底候选：Rust 回的是绝对路径且已按命中强度排序，这里只切成展示/写回两列。 */
export function fuzzySuggestions(paths: string[], root: string): MentionSuggestion[] {
  return paths.map((abs) => {
    const rel = toRelPath(abs, root);
    const cut = rel.lastIndexOf("/");
    return {
      name: cut < 0 ? rel : rel.slice(cut + 1),
      dir: cut < 0 ? "" : rel.slice(0, cut),
      isDir: false,
      rel,
      origin: "fuzzy" as const,
    };
  });
}

/**
 * 三源合并：项目 → 本层（保序）→ 兜底（保序），同 `rel` 去重、总共封顶 `MAX_SUGGESTIONS`。
 * 保序是有意的：各组内部的次序由各自的生产者决定（项目按注册表序、本层按 Rust 排序）。
 */
export function mergeSuggestions(
  projects: MentionSuggestion[],
  local: MentionSuggestion[],
  fuzzy: MentionSuggestion[],
): MentionSuggestion[] {
  const out: MentionSuggestion[] = [];
  const seen = new Set<string>();
  for (const group of [projects, local, fuzzy]) {
    for (const row of group) {
      if (seen.has(row.rel)) continue;
      seen.add(row.rel);
      out.push(row);
      if (out.length === MAX_SUGGESTIONS) return out;
    }
  }
  return out;
}

/**
 * 选中一项后改写文本：
 * - `drill`：续成 `@目录/`（**不带尾空格**——带了会被 useInlineMention 立刻转成芯片，就钻不下去了）
 * - `commit`：写成 `@rel `（尾空格触发既有转换层转芯片，不新增第二条转芯片路径）
 */
export function applyPick(
  text: string,
  token: MentionToken,
  item: MentionSuggestion,
  action: "commit" | "drill",
): PickResult {
  const inserted = `@${item.rel}${action === "drill" ? "/" : " "}`;
  const tail = token.at + 1 + token.query.length;
  return { text: text.slice(0, token.at) + inserted + text.slice(tail), caret: token.at + inserted.length };
}

/** 一次刷新的目标：写回前缀 `dir`、真正要列（或已缓存）的目录 `dirAbs`、叶子 `leaf`。 */
interface SearchTarget {
  dir: string;
  dirAbs: string;
  leaf: string;
}

export interface MentionSuggest {
  token: Ref<MentionToken | null>;
  items: Ref<MentionSuggestion[]>;
  active: Ref<number>;
  /** 有 token 且有候选才可见——无匹配/加载中都不弹空菜单。 */
  visible: ComputedRef<boolean>;
  /** 每次 input/keyup/click 调：按当前文本 + 光标重算候选 */
  refresh: (text: string, caret: number) => Promise<void>;
  hide: () => void;
  move: (delta: number) => void;
  current: () => MentionSuggestion | undefined;
}

/** 防抖等待；delay <= 0 = 不等（测试与「明确不要防抖」的调用点）。 */
function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function useMentionSuggest(opts: {
  workspacePath: () => string;
  /** 其它已注册工作区（`useWorkspaces().workspaces` 直接传）。缺省 = 不列项目（老调用点行为不变）。 */
  projects?: () => ProjectSource[];
  fuzzyDebounceMs?: number;
}): MentionSuggest {
  const token = ref<MentionToken | null>(null);
  const items = ref<MentionSuggestion[]>([]);
  const active = ref(0);
  const visible = computed(() => token.value !== null && items.value.length > 0);

  let cache: ListingCache | null = null;
  /** 单调递增的查询序号：异步回来若已过期（换了层/又落键）即弃。 */
  let seq = 0;

  function hide() {
    token.value = null;
    items.value = [];
    active.value = 0;
  }

  /** 写入本次查询并返回序号；候选先清空，换层瞬间不残留上一层的行。 */
  function beginSearch(tok: MentionToken): number {
    seq += 1;
    token.value = tok;
    active.value = 0;
    items.value = [];
    return seq;
  }

  /** token → 刷新目标；无工作区又只给了相对路径时返回 null（没东西可列，不弹）。 */
  function targetFor(tok: MentionToken): SearchTarget | null {
    const { dir, leaf } = splitQueryPath(tok.query);
    if (isAbsoluteishPath(dir)) return { dir, dirAbs: stripTrailingSep(dir), leaf };
    const ws = opts.workspacePath();
    if (!ws) return null;
    return dir ? { dir, dirAbs: stripTrailingSep(joinPath(ws, dir)), leaf } : { dir: "", dirAbs: ws, leaf };
  }

  /** 取该目录的 entries：命中缓存则零 IPC；失败当空（静默关菜单，不阻断输入）。 */
  async function entriesFor(dirAbs: string, mySeq: number): Promise<DirEntry[]> {
    if (cache?.dirAbs === dirAbs) return cache.entries;
    try {
      const entries = await api.listDirectory(dirAbs, false, false);
      // 远端（PWA）没有这条命令时 invoke 可能回非数组——补全不值得为它炸掉输入框
      if (!Array.isArray(entries)) return [];
      if (mySeq === seq) cache = { dirAbs, entries };
      return entries;
    } catch {
      return [];
    }
  }

  /** 项目候选：只在「没敲到分隔符」时给——敲了分隔符说明已经在某个目录里了。 */
  function projectsFor(target: SearchTarget): MentionSuggestion[] {
    if (target.dir !== "") return [];
    return projectSuggestions(opts.projects?.() ?? [], {
      sessionWs: opts.workspacePath(),
      leaf: target.leaf,
    });
  }

  /** 全仓兜底：只在没敲到分隔符（本层根）且有叶子时跑，遍历型查询先防抖。 */
  async function appendFuzzy(target: SearchTarget, mySeq: number): Promise<void> {
    const ws = opts.workspacePath();
    if (!ws || target.dir !== "" || target.leaf === "") return;
    await delay(opts.fuzzyDebounceMs ?? FUZZY_DEBOUNCE_MS);
    let paths: string[];
    try {
      paths = await api.findFilesByName(target.leaf, ws, FUZZY_FETCH_LIMIT);
    } catch {
      return; // 兜底失败就只留本层结果
    }
    if (mySeq !== seq) return;
    items.value = mergeSuggestions([], items.value, fuzzySuggestions(paths, ws));
  }

  async function refresh(text: string, caret: number): Promise<void> {
    const tok = mentionTokenAt(text, caret);
    if (!tok) return hide();
    const target = targetFor(tok);
    if (!target) return hide();

    const mySeq = beginSearch(tok);
    const entries = await entriesFor(target.dirAbs, mySeq);
    if (mySeq !== seq) return; // 过期：用户已经换层/改字
    items.value = mergeSuggestions(projectsFor(target), localSuggestions(entries, target), []);
    await appendFuzzy(target, mySeq);
  }

  function move(delta: number) {
    if (items.value.length === 0) return;
    active.value = Math.max(0, Math.min(items.value.length - 1, active.value + delta));
  }

  function current(): MentionSuggestion | undefined {
    return items.value[active.value];
  }

  return { token, items, active, visible, refresh, hide, move, current };
}

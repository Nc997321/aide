/**
 * 旁白：把工具调用说成一句人话（「在知识库里搜索了「报销」，找到 3 篇」），对话里不再出现
 * 工具名（`mcp__aide-browser__browser_act`、`Read`…）。
 *
 * 规则（设计稿 2026-10-20）：
 * - 一次调用一句；**相邻的同一类**（category 相同）合成一句，中间隔了正文、思考、
 *   子代理或别类操作就另起一句。
 * - 进行中用「正在…」；做完用过去式，结果只取一个最有用的数字或结论。
 * - 内置浏览器 / 操作计算机：始终一行。进行中原地替换成当前步骤；做完把**改变了页面
 *   的动作**串成一句（查看 / 等待 / 截图不写进去），超过 3 个写「等 N 步」。
 * - 认不出来的第三方 MCP：「用 figma 执行了「get file」」。
 *
 * 输出是**片段数组**而不是字符串：对象（文件名、搜索词、页面）要比动词亮，失败要标红——
 * 渲染端按 tone 上色，不认识的客户端直接把 text 拼起来就是一句完整的话。
 * 桌面与手机共用这一份说法（手机端何时接入由手机端自己定）。
 */
import { parseToolDenial } from "./toolDenial";

/** 一段文字。tone 缺省 = 普通旁白色。 */
export interface NarrSeg {
  text: string;
  /** obj = 对象（亮一点）；mono = 等宽的对象（文件名 / 命令）；err = 失败；meta = 次要信息 */
  tone?: "obj" | "mono" | "err" | "meta";
}

/** 图标：由渲染端画成小线条图标。 */
export type NarrIcon =
  | "file" | "search" | "pencil" | "terminal" | "target" | "book" | "window" | "monitor"
  | "globe" | "doc" | "memory" | "person" | "split" | "eye" | "check" | "spark" | "plug"
  | "question" | "map" | "bulb" | "dot";

/** 旁白需要的工具调用字段（ToolCallBlock 的子集）。 */
export interface NarrCall {
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  isPending: boolean;
  /** 结果已被降级成占位（结果正文不可用于取数）。 */
  truncated?: unknown;
}

/** 一组（≥1 次）同类调用的旁白。 */
export interface Narration {
  icon: NarrIcon;
  segs: NarrSeg[];
  /** 还有调用在跑：渲染成「正在…」带流光。 */
  live: boolean;
  /** 有调用失败（不含被拒）。 */
  error: boolean;
  /** 被拒：user = 你拒绝的；policy = 命中权限规则。组里任一被拒即带上（多为单条）。 */
  denied?: { kind: "user" | "policy"; reason?: string };
}

// ── 小工具 ─────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** 截短到 max 个字符，超出加「…」。 */
export function clip(s: string, max = 40): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 路径的最后一段（兼容 / 与 \）。 */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 网址只留主机 + 路径（去掉协议与查询串）。 */
function shortUrl(u: string): string {
  return clip(u.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, ""), 48);
}

const obj = (text: string): NarrSeg => ({ text, tone: "obj" });
const mono = (text: string): NarrSeg => ({ text, tone: "mono" });
const quoted = (text: string): NarrSeg => obj(`「${clip(text)}」`);
const t = (text: string): NarrSeg => ({ text });

/** 片段数组拼回纯文本（测试 / 不认识 tone 的客户端用）。 */
export function narrationText(segs: NarrSeg[]): string {
  return segs.map((s) => s.text).join("");
}

// ── 分类：决定图标、合并键与组句法 ─────────────────────────────────────

type Kind =
  | "read" | "search" | "edit" | "bash" | "lsp" | "kb" | "browser" | "computer" | "web"
  | "docs" | "memory" | "agent" | "subsession" | "watch" | "todo" | "skill" | "ask" | "plan"
  | "mcp" | "other";

const ICONS: Record<Kind, NarrIcon> = {
  read: "file", search: "search", edit: "pencil", bash: "terminal", lsp: "target", kb: "book",
  browser: "window", computer: "monitor", web: "globe", docs: "doc", memory: "memory",
  agent: "person", subsession: "split", watch: "eye", todo: "check", skill: "spark",
  ask: "question", plan: "map", mcp: "plug", other: "dot",
};

/** `mcp__<server>__<tool>` 拆开；不是 MCP 名返回 null。 */
function splitMcp(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

function kindOf(name: string): Kind {
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Grep":
    case "Glob":
    case "LS":
      return "search";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
      return "bash";
    case "LSP":
      return "lsp";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Agent":
    case "Task":
      return "agent";
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return "todo";
    case "Skill":
      return "skill";
    case "AskUserQuestion":
      return "ask";
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "plan";
  }
  const mcp = splitMcp(name);
  if (!mcp) return "other";
  switch (mcp.server) {
    case "aide-browser": return "browser";
    case "aide-computer": return "computer";
    case "aide-knowledge": return "kb";
    case "aide-lsp": return "lsp";
    case "aide-docs": return "docs";
    case "aide-memory": return "memory";
    case "aide-sessions": return "subsession";
    case "aide-watch": return "watch";
  }
  return "mcp";
}

/** 合并键：相邻两次调用键相同才合成一句。第三方 MCP 按 server 分，其余按类。 */
export function narrationKey(name: string): string {
  const kind = kindOf(name);
  if (kind === "mcp" || kind === "other") return `${kind}:${splitMcp(name)?.server ?? name}`;
  return kind;
}

// ── 单次调用 ───────────────────────────────────────────────────────────

/** 单次调用拆成的几部分。live / done 是完整一句；clause 是组句时用的分句（不带地点前缀）。 */
interface CallParts {
  live: NarrSeg[];
  done: NarrSeg[];
  /** 组句用：浏览器 / 电脑 / 知识库的分句（「点击了「提交」」），不带「在内置浏览器里」。 */
  clause?: NarrSeg[];
  /** 进行中的分句（同上，不带地点前缀）。 */
  liveClause?: NarrSeg[];
  /** 是否改变了东西（浏览器 / 电脑组句只串这些）。 */
  acts?: boolean;
  /** 组句列举的对象（文件名 / 搜索词 / 命令 / 网址）。 */
  target?: string;
}

/** 结果正文可用（不在跑、没被降级、没被拒）。 */
function usableResult(c: NarrCall): string | null {
  if (c.isPending || c.truncated || c.result === undefined) return null;
  if (parseToolDenial(c.result)) return null;
  return c.result;
}

/** Grep / Glob 的命中数：「Found 4 files」或逐行计数；没命中 → 0；拿不到 → null。 */
function searchHits(c: NarrCall): number | null {
  const r = usableResult(c);
  if (r === null || c.isError) return null;
  const head = r.slice(0, 120);
  if (/^No (files|matches) found/i.test(head)) return 0;
  const m = /^Found (\d+)/i.exec(head);
  if (m) return Number(m[1]);
  const body = r.trim();
  return body ? body.split("\n").length : 0;
}

/** Read 的行号区间（offset 1-based、limit 行数）。 */
function readRange(input: Record<string, unknown>): string {
  const offset = typeof input.offset === "number" ? input.offset : undefined;
  const limit = typeof input.limit === "number" ? input.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const from = offset ?? 1;
  return limit !== undefined ? `第 ${from}–${from + limit - 1} 行` : `第 ${from} 行起`;
}

/** 命令首行，截短。 */
function commandLine(cmd: string): string {
  return clip(cmd.split("\n").find((l) => l.trim()) ?? cmd, 56);
}

function partsFor(c: NarrCall): CallParts {
  const input = rec(c.input);
  const kind = kindOf(c.name);
  switch (kind) {
    case "read": {
      const file = str(input.file_path) || str(input.notebook_path);
      const range = readRange(input);
      const name = baseName(file);
      return {
        live: [t("正在读 "), mono(name), t("…")],
        done: [t("读了 "), mono(name), ...(range ? [{ text: ` ${range}`, tone: "meta" as const }] : [])],
        target: name,
      };
    }
    case "search": {
      if (c.name === "Glob") {
        const pattern = str(input.pattern);
        const hits = searchHits(c);
        return {
          live: [t("正在找 "), mono(clip(pattern)), t(" 文件…")],
          done: [t("找了 "), mono(clip(pattern)), t(" 文件"), ...countTail(hits, "个")],
          target: clip(pattern, 24),
        };
      }
      if (c.name === "LS") {
        const dir = baseName(str(input.path)) || "目录";
        return { live: [t("正在看 "), mono(dir), t(" 目录…")], done: [t("看了 "), mono(dir), t(" 目录")], target: dir };
      }
      const pattern = str(input.pattern);
      const hits = searchHits(c);
      return {
        live: [t("正在项目里搜索"), quoted(pattern), t("…")],
        done: [t("在项目里搜索了"), quoted(pattern), ...countTail(hits, "处")],
        target: `「${clip(pattern, 20)}」`,
      };
    }
    case "edit": {
      const file = baseName(str(input.file_path) || str(input.notebook_path));
      const created = c.name === "Write" && !c.isPending && /created/i.test(c.result ?? "");
      return {
        live: [t("正在修改 "), mono(file), t("…")],
        done: [t(created ? "新建了 " : "修改了 "), mono(file)],
        target: file,
      };
    }
    case "bash": {
      if (c.name === "BashOutput") {
        return { live: [t("正在看后台命令的输出…")], done: [t("看了后台命令的输出")], target: "后台输出" };
      }
      if (c.name === "KillShell" || c.name === "KillBash") {
        return { live: [t("正在停止后台命令…")], done: [t("停止了后台命令")], target: "停止后台命令" };
      }
      const cmd = commandLine(str(input.command));
      const bg = input.run_in_background === true;
      return {
        live: [t("正在运行 "), mono(cmd), t("…")],
        done: [t(bg ? "在后台启动了 " : "运行了 "), mono(cmd)],
        target: clip(cmd, 24),
      };
    }
    case "lsp":
      return lspParts(c, input);
    case "kb":
      return kbParts(c, input);
    case "browser":
      return browserParts(c, input);
    case "computer":
      return computerParts(c, input);
    case "web": {
      if (c.name === "WebSearch") {
        const q = str(input.query);
        return {
          live: [t("正在网上搜索"), quoted(q), t("…")],
          done: [t("在网上搜索了"), quoted(q)],
          target: `「${clip(q, 20)}」`,
        };
      }
      const url = shortUrl(str(input.url));
      return { live: [t("正在读网页 "), mono(url), t("…")], done: [t("读了网页 "), mono(url)], target: url };
    }
    case "docs": {
      const file = baseName(str(input.file_path));
      const write = c.name.endsWith("write_docx");
      return {
        live: [t(write ? "正在生成 " : "正在读 "), mono(file), t("…")],
        done: [t(write ? "生成了 " : "读了 "), mono(file)],
        target: file,
      };
    }
    case "memory": {
      const root = baseName(str(input.root)) || "另一个项目";
      return {
        live: [t("正在翻 "), obj(root), t(" 的记忆…")],
        done: [t("翻了一下 "), obj(root), t(" 的记忆")],
        target: root,
      };
    }
    case "agent": {
      const d = str(input.description);
      return { live: [t("助手正在"), quoted(d), t("…")], done: [t("派了一个助手去"), quoted(d)], target: `「${clip(d, 20)}」` };
    }
    case "subsession":
      return subsessionParts(c, input);
    case "watch":
      return watchParts(c, input);
    case "todo": {
      const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : [];
      if (todos.length === 0) return { live: [t("正在更新待办…")], done: [t("更新了待办")] };
      const done = todos.filter((x) => x?.status === "completed").length;
      const active = todos.find((x) => x?.status === "in_progress");
      const tail: NarrSeg[] = active && str(active.content) ? [t("，正在"), quoted(str(active.content))] : [];
      return {
        live: [t("正在更新待办…")],
        done: [t(`更新了待办：${done}/${todos.length} 已完成`), ...tail],
      };
    }
    case "skill": {
      const s = str(input.skill) || str(input.name);
      return { live: [t("正在加载"), quoted(s), t("技能…")], done: [t("用了"), quoted(s), t("技能")], target: s };
    }
    case "ask": {
      const qs = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
      const first = str(qs[0]?.question);
      return {
        live: [t("在问你："), obj(clip(first, 60))],
        done: [t("问了你："), obj(clip(first, 60)), ...(qs.length > 1 ? [t(` 等 ${qs.length} 个问题`)] : [])],
      };
    }
    case "plan":
      return c.name === "EnterPlanMode"
        ? { live: [t("正在进入计划模式…")], done: [t("进入了计划模式")] }
        : { live: [t("在等你确认计划…")], done: [t("提交了计划")] };
    case "mcp": {
      const mcp = splitMcp(c.name)!;
      const server = mcp.server.replace(/^app-/, "");
      const tool = mcp.tool.replace(/[_-]+/g, " ");
      return {
        live: [t("正在用 "), obj(server), t(" 执行"), quoted(tool), t("…")],
        done: [t("用 "), obj(server), t(" 执行了"), quoted(tool)],
        target: `「${tool}」`,
      };
    }
    default: {
      const label = c.name === "ToolSearch" ? "查找可用工具" : c.name;
      return { live: [t("正在"), quoted(label), t("…")], done: [t("执行了"), quoted(label)] };
    }
  }
}

/** 「，找到 4 处」/「，没找到」；数不出来就什么都不加。 */
function countTail(n: number | null, unit: string): NarrSeg[] {
  if (n === null) return [];
  return n === 0 ? [{ text: "，没找到", tone: "meta" }] : [t(`，找到 ${n} ${unit}`)];
}

function lspParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const op = splitMcp(c.name)?.tool ?? str(input.operation);
  const names = Array.isArray(input.names) ? (input.names as unknown[]).map(str).filter(Boolean) : [];
  const sym = str(input.name) || names[0] || (str(input.file) ? baseName(str(input.file)) : "") || "符号";
  if (op === "lsp_outline" || op === "documentSymbol") {
    const file = baseName(str(input.file) || str(input.filePath));
    return { live: [t("正在看 "), mono(file), t(" 的结构…")], done: [t("看了 "), mono(file), t(" 的结构")], target: file };
  }
  const what =
    op === "lsp_references" || op === "findReferences" ? "引用"
      : op === "lsp_implementations" || op === "goToImplementation" ? "实现"
        : op === "lsp_symbols" || op === "workspaceSymbol" ? "位置"
          : "定义";
  return {
    live: [t("正在查 "), mono(clip(sym, 32)), t(` 的${what}…`)],
    done: [t("查了 "), mono(clip(sym, 32)), t(` 的${what}`)],
    target: clip(sym, 24),
  };
}

/** 知识库：组句时串成「搜索了「x」，找到 3 篇，读了《y》」。 */
function kbParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const tool = splitMcp(c.name)?.tool ?? "";
  const r = usableResult(c);
  const wrap = (clause: NarrSeg[], liveClause: NarrSeg[], acts = false): CallParts => ({
    clause,
    liveClause,
    acts,
    live: [t("正在知识库里"), ...liveClause, t("…")],
    done: [t("在知识库里"), ...clause],
  });
  switch (tool) {
    case "search": {
      const q = str(input.query);
      const m = r ? /\((\d+)\):/.exec(r.slice(0, 200)) : null;
      const none = r ? /^No match/.test(r) : false;
      const tail: NarrSeg[] = none ? [{ text: "，没找到", tone: "meta" }] : m ? [t(`，找到 ${m[1]} 篇`)] : [];
      return wrap([t("搜索了"), quoted(q), ...tail], [t("搜索"), quoted(q)]);
    }
    case "read_document": {
      const title = r ? /^# (.+)$/m.exec(r.slice(0, 300))?.[1] : undefined;
      const doc = title ? obj(`《${clip(title, 30)}》`) : t("一篇文档");
      return wrap([t("读了"), doc], [t("读文档")]);
    }
    case "list_spaces":
      return wrap([t("看了有哪些知识空间")], [t("看有哪些知识空间")]);
    case "list_documents":
      return wrap([t("看了一个空间里的文档列表")], [t("看文档列表")]);
    case "create_document":
      return wrap([t("新建了"), obj(`《${clip(str(input.title), 30)}》`)], [t("新建"), obj(`《${clip(str(input.title), 30)}》`)], true);
    case "create_folder":
      return wrap([t("新建了文件夹"), quoted(str(input.title))], [t("新建文件夹")], true);
    case "move_document":
      return wrap([t("移动了一篇文档")], [t("移动文档")], true);
    case "append_document":
      return wrap([t("在一篇文档末尾追加了内容")], [t("追加内容")], true);
    case "update_document":
      return wrap([t("改写了一篇文档")], [t("改写文档")], true);
    case "ingest_file":
      return wrap([t("导入了 "), mono(baseName(str(input.filePath)))], [t("导入 "), mono(baseName(str(input.filePath)))], true);
    case "delete_document":
      return wrap([t("删除了一篇文档")], [t("删除文档")], true);
    case "edit_selection":
      return wrap([t("改了你圈选的那段")], [t("改你圈选的那段")], true);
    default:
      return wrap([t("执行了"), quoted(tool.replace(/_/g, " "))], [t("执行"), quoted(tool.replace(/_/g, " "))]);
  }
}

/** 内置浏览器：分句不带「在内置浏览器里」，组句时统一加。 */
function browserParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const tool = splitMcp(c.name)?.tool ?? "";
  const mk = (clause: NarrSeg[], liveClause: NarrSeg[], acts: boolean): CallParts => ({
    clause,
    liveClause,
    acts,
    live: [t("正在内置浏览器里"), ...liveClause, t("…")],
    done: [t("在内置浏览器里"), ...clause],
  });
  const target = str(input.text) || str(input.selector);
  switch (tool) {
    case "browser_tab": {
      const action = str(input.action);
      const url = shortUrl(str(input.url));
      if (action === "open") return mk([t("打开了 "), mono(url)], [t("打开 "), mono(url)], true);
      if (action === "navigate") return mk([t("转到了 "), mono(url)], [t("转到 "), mono(url)], true);
      if (action === "back") return mk([t("后退了一页")], [t("后退")], true);
      if (action === "forward") return mk([t("前进了一页")], [t("前进")], true);
      if (action === "close") return mk([t("关掉了一个标签页")], [t("关标签页")], false);
      return mk([t("把页面切到了前台")], [t("切换页面")], false);
    }
    case "browser_act": {
      const action = str(input.action);
      if (action === "fill") {
        const v = clip(str(input.value), 24);
        return mk([t("在"), quoted(target), t("里填了 "), obj(v)], [t("在"), quoted(target), t("里填写")], true);
      }
      if (action === "press") {
        const mods = Array.isArray(input.modifiers) ? (input.modifiers as string[]).map((m) => m[0].toUpperCase() + m.slice(1)) : [];
        const key = [...mods, str(input.key)].filter(Boolean).join("+");
        return mk([t("按了 "), mono(key)], [t("按 "), mono(key)], true);
      }
      if (action === "hover") return mk([t("把鼠标移到了"), quoted(target), t("上")], [t("把鼠标移到"), quoted(target), t("上")], true);
      return mk([t("点击了"), quoted(target)], [t("点击"), quoted(target)], true);
    }
    case "browser_read":
      return mk([t("查看了页面内容")], [t("查看页面")], false);
    case "browser_tabs":
      return mk([t("看了开着哪些页面")], [t("看开着哪些页面")], false);
    case "browser_wait":
      return mk([t("等页面就绪")], [t("等页面就绪")], false);
    case "browser_screenshot":
      return mk([t("截了一张图")], [t("截图")], false);
    case "browser_eval":
      return mk([t("在页面里执行了一段脚本")], [t("在页面里执行脚本")], true);
    case "browser_network":
      return mk([t("看了网络请求")], [t("看网络请求")], false);
    case "browser_console":
      return mk([t("看了控制台")], [t("看控制台")], false);
    default:
      return mk([t("执行了"), quoted(tool.replace(/_/g, " "))], [t("执行"), quoted(tool.replace(/_/g, " "))], false);
  }
}

/** 操作计算机：computer_act 自带 intent（模型写给用户审批看的一句话），直接用它。 */
function computerParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const tool = splitMcp(c.name)?.tool ?? "";
  const mk = (clause: NarrSeg[], liveClause: NarrSeg[], acts: boolean): CallParts => ({
    clause,
    liveClause,
    acts,
    live: [t("正在电脑上"), ...liveClause, t("…")],
    done: [t("在电脑上"), ...clause],
  });
  switch (tool) {
    case "computer_act": {
      const intent = clip(str(input.intent), 48) || "做了一步操作";
      return mk([obj(intent)], [obj(intent)], true);
    }
    case "computer_window": {
      const action = str(input.action);
      const app = str(input.app);
      if (action === "launch") return mk([t("打开了 "), obj(app)], [t("打开 "), obj(app)], true);
      const verb: Record<string, string> = { focus: "切换了窗口", minimize: "最小化了窗口", maximize: "最大化了窗口", restore: "还原了窗口", close: "关掉了一个窗口" };
      const text = verb[action] ?? "调整了窗口";
      return mk([t(text)], [t(text.replace("了", ""))], true);
    }
    case "computer_read":
      return mk([t("看了窗口内容")], [t("看窗口")], false);
    case "computer_windows":
      return mk([t("看了开着哪些窗口")], [t("看开着哪些窗口")], false);
    case "computer_wait":
      return mk([t("等界面就绪")], [t("等界面就绪")], false);
    default:
      return mk([t("执行了"), quoted(tool.replace(/_/g, " "))], [t("执行"), quoted(tool.replace(/_/g, " "))], false);
  }
}

function subsessionParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const tool = splitMcp(c.name)?.tool ?? "";
  if (tool === "session_spawn") {
    const title = str(input.title) || (str(input.task).split("\n").find((l) => l.trim()) ?? "");
    return { live: [t("正在开子会话"), quoted(title), t("…")], done: [t("开了一个子会话"), quoted(title)] };
  }
  if (tool === "session_message") {
    return { live: [t("正在给子会话追加指令…")], done: [t("给子会话追加了指令："), obj(clip(str(input.text), 40))] };
  }
  return { live: [t("正在看子会话…")], done: [t("看了子会话的进展")] };
}

function watchParts(c: NarrCall, input: Record<string, unknown>): CallParts {
  const tool = splitMcp(c.name)?.tool ?? "";
  if (tool === "watch_start") {
    const every = typeof input.every_seconds === "number" ? input.every_seconds : 0;
    const freq = every >= 60 ? `，每 ${Math.round(every / 60)} 分钟看一次` : every > 0 ? `，每 ${every} 秒看一次` : "";
    return { live: [t("正在开始值守"), quoted(str(input.title)), t("…")], done: [t("开始值守"), quoted(str(input.title)), t(freq)] };
  }
  if (tool === "watch_stop") return { live: [t("正在停止值守…")], done: [t("停止了值守")] };
  return { live: [t("正在看值守列表…")], done: [t("看了值守列表")] };
}

// ── 组句 ───────────────────────────────────────────────────────────────

/** 浏览器 / 电脑组句里最多串几个动作。 */
const MAX_ACTS = 3;
/** 列举对象最多几个。 */
const MAX_LIST = 3;

/** 「a、b、c 等」 */
function listTargets(targets: string[], asMono: boolean): NarrSeg[] {
  const uniq = [...new Set(targets.filter(Boolean))];
  const shown = uniq.slice(0, MAX_LIST);
  const out: NarrSeg[] = [];
  shown.forEach((x, i) => {
    if (i > 0) out.push(t("、"));
    out.push(asMono ? mono(x) : obj(x));
  });
  if (uniq.length > MAX_LIST) out.push(t(" 等"));
  return out;
}

/** 分句用「，」串起来；最后两个之间用「并」。 */
function joinClauses(clauses: NarrSeg[][]): NarrSeg[] {
  const out: NarrSeg[] = [];
  clauses.forEach((cl, i) => {
    if (i > 0) out.push(t(i === clauses.length - 1 && clauses.length > 1 ? "，并" : "，"));
    out.push(...cl);
  });
  return out;
}

function denialOf(calls: NarrCall[]): Narration["denied"] {
  for (const c of calls) {
    const d = c.truncated ? null : parseToolDenial(c.result);
    if (d) return { kind: d.kind === "policy" ? "policy" : "user", reason: d.reason || undefined };
  }
  return undefined;
}

/** 被拒的那次：「想运行 rm -rf dist」——live 句去掉「正在」「…」，换成「想」。 */
function deniedSegs(p: CallParts): NarrSeg[] {
  const segs = p.live.map((s) => ({ ...s }));
  if (segs[0]) segs[0].text = segs[0].text.replace(/^(助手)?正在/, "想");
  const last = segs[segs.length - 1];
  if (last) last.text = last.text.replace(/…$/, "");
  return segs.filter((s) => s.text);
}

/**
 * 一组相邻同类调用 → 一句旁白。调用方保证同组 narrationKey 相同（见 groupByNarration）。
 */
export function narrate(calls: NarrCall[]): Narration {
  if (calls.length === 0) return { icon: "dot", segs: [], live: false, error: false };
  const kind = kindOf(calls[0].name);
  const icon = ICONS[kind];
  const parts = calls.map(partsFor);
  const pendingIdx = calls.map((c) => c.isPending).lastIndexOf(true);
  const live = pendingIdx !== -1;
  const denied = denialOf(calls);
  const error = calls.some((c) => c.isError && !(c.truncated ? null : parseToolDenial(c.result)));
  const failTail: NarrSeg[] = error ? failureTail(kind, calls) : [];

  // 单条
  if (calls.length === 1) {
    const p = parts[0];
    if (live) return { icon, segs: p.live, live, error: false };
    if (denied) return { icon, segs: deniedSegs(p), live: false, error: false, denied };
    return { icon, segs: [...p.done, ...failTail], live, error, denied };
  }

  // 进行中：同一行原地替换成正在跑的那一步（浏览器 / 电脑 / 知识库的「始终一行」），
  // 计数类带上进度。
  if (live) {
    const p = parts[pendingIdx];
    const doneCount = calls.filter((c) => !c.isPending).length;
    const progress: NarrSeg[] =
      kind === "read" || kind === "edit" || kind === "docs" ? [{ text: `（已完成 ${doneCount} 个）`, tone: "meta" }] : [];
    return { icon, segs: [...p.live, ...progress], live, error: false };
  }

  const segs = groupDone(kind, calls, parts);
  return { icon, segs: [...segs, ...failTail], live: false, error, denied };
}

/** 失败的尾巴：命令说「，其中 N 条失败」，单条说「，失败」。 */
function failureTail(kind: Kind, calls: NarrCall[]): NarrSeg[] {
  const failed = calls.filter((c) => c.isError && !parseToolDenial(c.result)).length;
  if (calls.length === 1) {
    if (kind === "bash") {
      const code = /exit code (\d+)/i.exec(calls[0].result ?? "")?.[1];
      return [{ text: code ? `，失败（退出码 ${code}）` : "，失败", tone: "err" }];
    }
    return [{ text: "，没成功", tone: "err" }];
  }
  return [{ text: `，其中 ${failed} 次没成功`, tone: "err" }];
}

function groupDone(kind: Kind, calls: NarrCall[], parts: CallParts[]): NarrSeg[] {
  const n = calls.length;
  const targets = parts.map((p) => p.target ?? "");
  switch (kind) {
    case "read": {
      const uniq = new Set(targets).size;
      return uniq === 1 ? [t("读了 "), mono(targets[0]), t(`（${n} 段）`)] : [t(`读了 ${uniq} 个文件：`), ...listTargets(targets, true)];
    }
    case "edit": {
      const uniq = new Set(targets).size;
      return uniq === 1 ? [t("修改了 "), mono(targets[0]), t(`（${n} 处）`)] : [t(`修改了 ${uniq} 个文件：`), ...listTargets(targets, true)];
    }
    case "search":
      return [t(`在项目里搜索了 ${n} 次：`), ...listTargets(targets, false)];
    case "bash":
      return [t(`运行了 ${n} 条命令：`), ...listTargets(targets, true)];
    case "lsp":
      return [t(`查了 ${new Set(targets).size} 个符号：`), ...listTargets(targets, true)];
    case "web":
      return [t(`在网上查了 ${n} 次：`), ...listTargets(targets, false)];
    case "docs":
      return [t(`处理了 ${new Set(targets).size} 份文档：`), ...listTargets(targets, true)];
    case "memory":
      return [t(`翻了 ${n} 次记忆：`), ...listTargets(targets, false)];
    case "kb":
      return [t("在知识库里"), ...joinClauses(dedupeClauses(parts.map((p) => p.clause ?? p.done)).slice(0, MAX_ACTS)),
        ...(n > MAX_ACTS ? [t(` 等 ${n} 步`)] : [])];
    case "browser":
    case "computer": {
      const prefix = kind === "browser" ? "在内置浏览器里" : "在电脑上";
      const acts = parts.filter((p) => p.acts).map((p) => p.clause ?? p.done);
      if (acts.length === 0) {
        // 只看没动：取最后一个分句（「查看了页面内容」）
        const last = parts[parts.length - 1];
        return [t(prefix), ...(last.clause ?? last.done)];
      }
      const shown = acts.slice(0, MAX_ACTS);
      return [t(prefix), ...joinClauses(shown), ...(acts.length > MAX_ACTS ? [t(` 等 ${n} 步`)] : [])];
    }
    case "todo":
      // 待办只留最后一次
      return parts[parts.length - 1].done;
    case "mcp": {
      const server = splitMcp(calls[0].name)?.server.replace(/^app-/, "") ?? "";
      return [t("用 "), obj(server), t(` 执行了 ${n} 次操作：`), ...listTargets(targets, false)];
    }
    default:
      return [...parts[parts.length - 1].done, t(` 等 ${n} 次`)];
  }
}

/** 相邻重复的分句只留一个（连读同一篇文档两次 → 一句）。 */
function dedupeClauses(clauses: NarrSeg[][]): NarrSeg[][] {
  const out: NarrSeg[][] = [];
  let prev = "";
  for (const cl of clauses) {
    const key = narrationText(cl);
    if (key !== prev) out.push(cl);
    prev = key;
  }
  return out;
}

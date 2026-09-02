import { ref, readonly } from "vue";
import { api } from "../api";
import { useLsp } from "./useLsp";
import * as resolver from "./definitionResolver";
import type { GrepMatch, QueryResult } from "../types";

/** 路径归一为「正斜杠、相对 projectRoot」形式，供跨 provider 自引用过滤比较。
 *  LSP Location→QueryResult.file 是绝对路径（uri_to_path 出来），codegraph/grep
 *  是相对路径，source.sourceFile 也是相对路径——三者形态不一，统一归一后再比，
 *  避免 LSP 多结果时点击点自身因「绝对 ≠ 相对」而滤不掉、混进浮层。 */
function normFile(root: string, p: string): string {
  const r = root.replace(/\\/g, "/");
  const x = p.replace(/\\/g, "/");
  if (r && x.startsWith(r + "/")) return x.slice(r.length + 1);
  return x;
}

/** LSP 结果消费：自引用过滤（同文件同行 = 点到定义本身）+ `source:"lsp"` 打标。
 *  peek 缓存命中与 resolve-ok 两路共用，确保过滤/打标逻辑单一真相。 */
function stampLsp(results: QueryResult[], projectRoot: string, srcAbs: string, srcLine: number): QueryResult[] {
  return results
    .filter(r => !(normFile(projectRoot, r.symbol.file) === normFile(projectRoot, srcAbs) && r.symbol.line === srcLine))
    .map(r => ({ ...r, source: "lsp" as const }));
}

// Module-level singleton
const visible = ref(false);
const results = ref<QueryResult[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");

const targetProjectRoot = ref("");
const isGrepFallback = ref(false);
/** 当前浮层模式：search()=定义，searchAllReferences()=引用，searchImplementations()=实现。
 *  决定标题与空态文案。 */
const mode = ref<"definition" | "references" | "implementation">("definition");

/** LSP 请求进行中（浮层显示「跳转中…」而非「未找到定义」）。由拥有当前 seq 的调用在各出口复位。 */
const searching = ref(false);
/** LSP 降级原因（仅 timeout/not_ready；gone/ok-empty 不设）。浮层在 results 为空时据此显示 hint。 */
const degraded = ref<"timeout" | "not_ready" | null>(null);
/** 请求序号：每次 search/dismiss/切换模式自增，await 后比对 mySeq——不等说明有更新请求，
 *  当前 await 弃结果（防 stale 覆盖：慢 server 期间快速连点不同符号，末次点击胜）。 */
let requestSeq = 0;

let lastProjectRoot = "";
let lastSourceExt = "";
let lastSourceFile = "";
let lastSourceFileAbs = "";
let lastSourceLine = 0;
let lastSourceColumn = 0;
let lastSourceWordColumn = 0;

export function useGotoDefinition() {
  /** 跑 codegraph→grep 本地索引两层（不调 LSP）。供 search() 的 ok-empty/not_ready/gone 分支
   *  与 localManualSearch() 共用。每次 await 后查 seq，stale 即弃（不复位 searching——新请求拥有它）。
   *  命中或耗尽时由本函数复位 searching（仅当仍为当前 seq）。 */
  async function runLocalTiers(
    word: string,
    projectRoot: string,
    source: { sourceFile: string; sourceLine: number; sourceExt?: string; sourceColumn?: number } | undefined,
    mySeq: number,
  ) {
    // 1. CodeGraph 结构（tree-sitter AST，名字匹配）/ 语义（向量）层
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word,
        source?.sourceFile || "",
        source?.sourceLine || 0,
        source?.sourceColumn ?? 0,
        projectRoot,
      );
      if (mySeq !== requestSeq) return;
      if (cgResults.length > 0) {
        // Filter out self-reference (same file, same line)
        let filtered = cgResults;
        if (source?.sourceFile) {
          filtered = cgResults.filter(
            r => !(normFile(projectRoot, r.symbol.file) === normFile(projectRoot, source.sourceFile) && r.symbol.line === source.sourceLine),
          );
        }
        results.value = filtered.map(r => ({
          ...r,
          source: r.confidence === "Structure" ? ("ast" as const) : ("semantic" as const),
        }));
        isGrepFallback.value = false;
        searching.value = false;
        return;
      }
    } catch {
      // CodeGraph unavailable — fall through to grep
    }
    if (mySeq !== requestSeq) return;

    // 2. grep 文本回退（word-boundary 精确匹配）
    try {
      let matches: GrepMatch[] = await api.grepSymbol(word, projectRoot, source?.sourceExt);
      if (mySeq !== requestSeq) return;
      isGrepFallback.value = true;
      if (source?.sourceFile) {
        matches = matches.filter(
          m => !(normFile(projectRoot, m.file) === normFile(projectRoot, source.sourceFile) && m.line === source.sourceLine),
        );
      }
      // Convert GrepMatch[] to QueryResult[] for unified rendering.
      // grep 是 word-boundary 精确文本匹配，既非 tree-sitter 结构层也非向量语义层；
      // 这里 confidence/score 仅是为满足 QueryResult 类型的占位，渲染层走 source:"grep"/isGrepFallback
      // 显示 [匹配] 标签，不读这俩字段——勿据此判断"是定义"。
      results.value = matches.slice(0, 20).map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: 0,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
        source: "grep" as const,
      }));
    } catch {
      if (mySeq !== requestSeq) return;
      isGrepFallback.value = true;
      results.value = [];
    }
    if (mySeq !== requestSeq) return;
    searching.value = false;
  }

  async function search(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceFileAbs?: string; sourceLine: number; sourceExt: string; sourceColumn?: number; sourceWordColumn?: number },
  ) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    lastSourceExt = source?.sourceExt || "";
    lastSourceFile = source?.sourceFile || "";
    lastSourceFileAbs = source?.sourceFileAbs || "";
    lastSourceLine = source?.sourceLine || 0;
    lastSourceColumn = source?.sourceColumn ?? 0;
    lastSourceWordColumn = source?.sourceWordColumn ?? 0;
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;
    isGrepFallback.value = false;
    mode.value = "definition";
    searching.value = true;
    degraded.value = null;
    const mySeq = ++requestSeq;

    // 0. LSP（工作区 LSP 开 + server 在线 → 权威；按 status 分流 fallback 语义）
    if (source?.sourceFileAbs && useLsp().isLspOn(projectRoot)) {
      const srcAbs = source.sourceFileAbs;
      const srcLine = source.sourceLine;
      // 缓存键列 = 词首列（hover 预取与 click 对同一词产出同键 → 预取真正暖到点击）；
      // 缺省回退 click 位置列。LSP 请求也用此列——LSP 解析的是标识符，词首列与
      // click 位置列结果完全一致。
      const keyCol = source.sourceWordColumn ?? source.sourceColumn ?? 0;

      // 同步快路径：命中缓存即瞬时跳转（无 await、无「跳转中…」，Vue 批处理不渲染 loading）
      const cached = resolver.peek({ workspaceRoot: projectRoot, word }, { file: srcAbs, line: srcLine, col: keyCol });
      if (cached) {
        console.warn(`[hover] search peek HIT word=${word} line=${srcLine} col=${keyCol}`);
        const filtered = stampLsp(cached, projectRoot, srcAbs, srcLine);
        if (filtered.length > 0) {
          results.value = filtered;
          searching.value = false;
          return;
        }
        // 缓存全自引用（点到定义本身）→ 同 ok-empty，落本地索引（不重发 LSP）
      } else {
        console.warn(`[hover] search peek MISS word=${word} line=${srcLine} col=${keyCol} → resolve`);
        // 未命中：单次解析（无 retry、无 sleep）。hover 预取已在途则 await 同一 promise。
        try {
          const jump = await resolver.resolve({ workspaceRoot: projectRoot, word }, { file: srcAbs, line: srcLine, col: keyCol });
          if (mySeq !== requestSeq) return;
          if (jump.status === "ok") {
            const filtered = stampLsp(jump.results, projectRoot, srcAbs, srcLine);
            if (filtered.length > 0) {
              results.value = filtered;
              searching.value = false;
              return;
            }
            // ok 但空 = server 确认无定义 → 落本地索引（今天行为）
          } else if (jump.status === "timeout") {
            // 单次超时（删 retry）：结果真未知 → 降级提示，不 auto-fallback
            // （auto-fallback 正是多结果噪声弹框的来源；给手动「用本地索引跳转」链接）
            degraded.value = "timeout";
            searching.value = false;
            return;
          } else if (jump.status === "not_ready") {
            // 索引窗口 30-90s+，死等比今天静默 fallback 还差 → auto-fallback 本地索引 + hint
            degraded.value = "not_ready";
          } else {
            // gone：useLsp 已 toast server 退出 → auto-fallback 本地索引
          }
        } catch {
          if (mySeq !== requestSeq) return;
          // LSP invoke 抛错（通道/序列化）→ 落本地索引
        }
      }
    }

    // 1+2. 本地索引：codegraph → grep（ok-empty / not_ready / gone / LSP 不可用 / 缓存全自引用 路径汇入此）
    await runLocalTiers(word, projectRoot, source, mySeq);
  }

  function dismiss() {
    requestSeq++;
    visible.value = false;
    results.value = [];
    selectedIndex.value = 0;
    searching.value = false;
    degraded.value = null;
  }

  /** hint 链接「用本地索引跳转」：只重跑 codegraph+grep（不调 LSP），供 timeout 降级时用户主动取本地结果。
   *  复用 search() 时缓存的 source 字段做自引用过滤。 */
  async function localManualSearch() {
    const word = searchWord.value;
    const projectRoot = targetProjectRoot.value;
    if (!word || !projectRoot) return;
    const mySeq = ++requestSeq;
    searching.value = true;
    degraded.value = null;
    results.value = [];
    selectedIndex.value = 0;
    isGrepFallback.value = false;
    visible.value = true;
    await runLocalTiers(
      word,
      projectRoot,
      { sourceFile: lastSourceFile, sourceLine: lastSourceLine, sourceExt: lastSourceExt, sourceColumn: lastSourceColumn },
      mySeq,
    );
  }

  /** 「跳转到实现」：只走 LSP（textDocument/implementation），不 codegraph/grep 兜底——
   *  implementation 是纯语义请求，文本兜底会塞入同名符号噪声。
   *  gutter 标记点击时传 preloadedResults（已查好的缓存），直接填 results 免重查。
   *  单结果由调用方 jumpOrPick 自动跳；多结果浮层显示供选。 */
  async function searchImplementations(
    word: string,
    projectRoot: string,
    preloadedResults?: QueryResult[],
  ) {
    if (!word || !projectRoot) return;
    requestSeq++; // 取消任何进行中的定义跳转 await
    searching.value = false;
    degraded.value = null;
    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    results.value = (preloadedResults ?? []).map(r => ({ ...r, source: "lsp" as const }));
    selectedIndex.value = 0;
    isGrepFallback.value = false;
    mode.value = "implementation";
    if (preloadedResults) {
      visible.value = true; // 多结果弹列表；单结果调用方会 jumpOrPick 直接跳
      return;
    }
    // 无预载结果 → 走 LSP 查（预留：当前 gutter 路径总带 preloadedResults，此分支供快捷键等用）
    visible.value = true;
    try {
      results.value = (await api.lspImplementation(projectRoot, "", 0, 0, word)).map(r => ({ ...r, source: "lsp" as const }));
    } catch {
      results.value = [];
    }
  }

  function selectPrev() {
    if (results.value.length === 0) return;
    selectedIndex.value =
      (selectedIndex.value - 1 + results.value.length) % results.value.length;
  }

  function selectNext() {
    if (results.value.length === 0) return;
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
  }

  function getSelected(): QueryResult | null {
    if (results.value.length === 0) return null;
    return results.value[selectedIndex.value] ?? null;
  }

  /** 「查引用」：LSP 权威（textDocument/references，符号 → 全部使用点）→ grep 文本兜底。
   *  本地兜底不走 codegraph——codegraphGotoDefinition 查到的是定义点，在引用场景会拿
   *  定义冒充使用点；grep 的 word-boundary 全量文本出现位更贴近使用点语义（[匹配] 标签如实标注）。
   *  - source 提供（Alt+Click 入口）：带完整源位置走 LSP；requestSeq 防串台。
   *  - source 缺省（「未找到定义 · 搜索所有引用」hint 链接）：复用上次 search() 缓存的
   *    lastSource*（跨函数共享，含绝对路径）。
   *  - status 语义照搬定义跳转：ok-empty/not_ready/gone → grep；timeout → 降级提示不 auto-fallback。
   *  单命中是否直接跳由调用方决定（Alt+Click 入口 jumpOrPick；hint 链接保持列表探索）。 */
  async function searchAllReferences(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceFileAbs?: string; sourceLine: number; sourceExt: string; sourceColumn?: number; sourceWordColumn?: number },
  ) {
    if (!word || !projectRoot) return;
    const mySeq = ++requestSeq; // 取消任何进行中的定义跳转 await

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    if (source) {
      lastSourceExt = source.sourceExt || "";
      lastSourceFile = source.sourceFile || "";
      lastSourceFileAbs = source.sourceFileAbs || "";
      lastSourceLine = source.sourceLine || 0;
      lastSourceColumn = source.sourceColumn ?? 0;
      lastSourceWordColumn = source.sourceWordColumn ?? 0;
    }
    // hint 链接路径：无 source 参数时沿用缓存（仅当同一 projectRoot，防跨工作区串台）
    const srcAbs = source?.sourceFileAbs || (lastProjectRoot === projectRoot ? lastSourceFileAbs : "");
    const srcLine = source ? source.sourceLine : lastSourceLine;
    const keyCol = source
      ? (source.sourceWordColumn ?? source.sourceColumn ?? 0)
      : (lastSourceWordColumn || lastSourceColumn);

    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;
    isGrepFallback.value = false;
    mode.value = "references";
    degraded.value = null;
    // 与 search() 一致：只要有 await 在途就置 loading，避免 grep 往返期间闪「未找到引用」
    searching.value = true;

    // 0. LSP 引用（源位置已知 + server 在线 → 权威；点击处本身也是使用点，stampLsp 滤掉）
    if (srcAbs && srcLine > 0 && useLsp().isLspOn(projectRoot)) {
      try {
        const jump = await api.lspReferences(projectRoot, srcAbs, srcLine, keyCol, word);
        if (mySeq !== requestSeq) return;
        if (jump.status === "ok") {
          const filtered = stampLsp(jump.results, projectRoot, srcAbs, srcLine);
          if (filtered.length > 0) {
            results.value = filtered;
            searching.value = false;
            return;
          }
          // ok 但空 = server 确认无引用 → grep 文本兜底（字符串/注释里仍可能出现）
        } else if (jump.status === "timeout") {
          // 结果未知，与定义跳转 timeout 同语义：降级提示 + 手动「用本地索引」链接
          degraded.value = "timeout";
          searching.value = false;
          return;
        }
        // not_ready / gone → grep 兜底
      } catch {
        if (mySeq !== requestSeq) return;
        // invoke 抛错（通道/序列化）→ grep 兜底
      }
    }
    if (mySeq !== requestSeq) return;

    // 1. grep 文本兜底（word-boundary 精确匹配 = 全部文本使用点）
    isGrepFallback.value = true;
    try {
      const matches = await api.grepSymbol(word, projectRoot, lastSourceExt || undefined);
      if (mySeq !== requestSeq) return;
      // grep 是文本匹配，confidence/score 仅是类型占位（同 runLocalTiers 注释），勿据此判断。
      results.value = matches.map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: 0,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
        source: "grep" as const,
      }));
    } catch {
      if (mySeq !== requestSeq) return;
      results.value = [];
    }
    if (mySeq !== requestSeq) return;
    searching.value = false;
  }

  return {
    visible: readonly(visible),
    results: readonly(results),
    selectedIndex: readonly(selectedIndex),
    searchWord: readonly(searchWord),
    isGrepFallback: readonly(isGrepFallback),
    mode: readonly(mode),
    searching: readonly(searching),
    degraded: readonly(degraded),
    search,
    searchAllReferences,
    searchImplementations,
    localManualSearch,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}

/** 测试专用：复位模块单例态（生产代码勿调）。 */
export function __resetGotoForTest() {
  visible.value = false;
  results.value = [];
  selectedIndex.value = 0;
  searchWord.value = "";
  targetProjectRoot.value = "";
  isGrepFallback.value = false;
  mode.value = "definition";
  searching.value = false;
  degraded.value = null;
  requestSeq = 0;
  lastProjectRoot = "";
  lastSourceExt = "";
  lastSourceFile = "";
  lastSourceFileAbs = "";
  lastSourceLine = 0;
  lastSourceColumn = 0;
  lastSourceWordColumn = 0;
  resolver.__resetForTest();
}
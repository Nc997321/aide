/**
 * 截图用活体夹具（一次性，不入产品路径）：把**真实的 KnowledgeBase.vue 整块**挂进浏览器，
 * 拦掉 window.fetch 喂假数据——所以截出来的是**面板本身**（真 scoped 样式、真主题 token、
 * 真布局），不是手抄的副本。手抄 CSS 抄错了看不出来，这里跑的是组件自己的样式。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/kb-panel-live.html
 *
 * query 开关（改状态不用改代码）：
 *   ?empty=1   空空间（看空态）
 *   ?gate=1    凭据失效（看登录兜底页）
 *   ?html=1    默认选中网页条目
 *   ?old=1     服务端报 0.4.0（没有 version 字段）——看「该升级了」那条提示
 *   ?live=1    **不拦 fetch**：面板连真实服务（默认 127.0.0.1:18788，隔离冒烟栈），
 *              从登录页开始走真实链路。真组件 → 真服务 → 真取件地址，是端到端那一种。
 *   ?w=1400&h=860  面板尺寸（默认 1400×860，接近真实主区）
 *
 * 收尾：按端口 PID 杀 vite（**别 taskkill /IM node.exe**，会连 sidecar 一起杀）。
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import KnowledgeBase from "../../../src/components/KnowledgeBase/KnowledgeBase.vue";
// 应用统一的对话框：面板里的确认（删除 / 丢弃修改）走它。真应用里挂在 App.vue 根上，
// 夹具里也得挂一个，否则面板里一弹确认就再也没人 resolve。
import ModalDialog from "../../../src/components/ModalDialog.vue";
import { useRightPanel } from "../../../src/composables/useRightPanel";
import type {
  KbDocument,
  KbDocumentSummary,
  KbSearchResult,
  KbSpace,
} from "../../../src/components/KnowledgeBase/kbClient";

applyTheme(glass);

const q = new URLSearchParams(location.search);
const W = Number(q.get("w") ?? 1400);
const H = Number(q.get("h") ?? 860);

/** ?live=1：直连真实服务（冒烟栈）。地址写死在这里，别误连用户自己的实例。 */
const LIVE = q.get("live") === "1";
const LIVE_BASE = "http://127.0.0.1:18788";

// 驱动用的钩子：验证「在右栏打开」到底把地址交给了谁（右栏在夹具里没挂面板）
(window as unknown as { __kbHarness: unknown }).__kbHarness = {
  pendingBrowserUrl: () => useRightPanel().pendingBrowserUrl.value,
  consumePendingBrowserUrl: () => useRightPanel().consumePendingBrowserUrl(),
};

// ── 假数据（贴近本产品的真实产物：会话里做出来的网页与文档）────────────
const SPACE: KbSpace = {
  id: "s1",
  key: "mine",
  name: "我的资料库",
  description: null,
  visibility: "private",
  role: "owner",
};

const MD_BODY = `# 数据说明

这份文档说明复盘报告里每个数字是怎么算出来的。口径改过两次，下面是最新的。

## 指标口径

- **已完成需求**：以任务关闭时间为准，不按创建时间——有些需求挂了两周才关，按创建时间算会把交付率压得很难看
- **延期项**：超过承诺日期仍未关闭
- **按期交付率**：按期关闭 / 全部关闭

> 报告页由会话生成。口径变了要重新生成一次，不要手改页面上的数字。

## 数据来源

1. 任务系统导出（每周一同步一次）
2. 人工补充的线下沟通记录
3. 上线记录

\`\`\`
导出 → 清洗 → 生成报告页
\`\`\`

## 还没定的事

延期的判定要不要区分「主动延期」和「被动延期」，现在混在一起算。
`;

const HTML_BODY = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>一季度复盘</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:32px;background:#f6f7fb;color:#1c2030}
  h1{font-size:24px;margin:0 0 6px}
  .sub{color:#6b7280;font-size:13px;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .kpi{background:#fff;border:1px solid #e5e7f0;border-radius:12px;padding:16px}
  .kpi .n{font-size:26px;font-weight:700;color:#3b5bdb}
  .kpi .l{font-size:12px;color:#6b7280;margin-top:4px}
</style></head>
<body>
  <h1>一季度复盘</h1>
  <div class="sub">生成于 2026-09-30 · 数据来自项目记录</div>
  <div class="grid">
    <div class="kpi"><div class="n">18</div><div class="l">已完成需求</div></div>
    <div class="kpi"><div class="n">3</div><div class="l">延期项</div></div>
    <div class="kpi"><div class="n">92%</div><div class="l">按期交付率</div></div>
  </div>
</body></html>`;

const SUMMARY: KbDocumentSummary[] = q.get("empty")
  ? []
  : [
      { id: "f1", parentId: null, kind: "folder", slug: "q1", title: "一季度复盘", versionNo: 0, status: "draft", updatedAt: "2026-09-30T15:20:00Z" },
      { id: "d1", parentId: "f1", kind: "doc", slug: "report", title: "复盘报告.html", versionNo: 2, status: "draft", updatedAt: "2026-09-30T15:20:00Z" },
      { id: "d2", parentId: "f1", kind: "doc", slug: "metric", title: "数据说明.md", versionNo: 3, status: "draft", updatedAt: "2026-09-30T14:02:00Z" },
      { id: "d3", parentId: null, kind: "doc", slug: "sitemap", title: "站点地图.html", versionNo: 1, status: "draft", updatedAt: "2026-09-29T20:11:00Z" },
      { id: "d4", parentId: null, kind: "doc", slug: "long-name", title: "灰度发布 checklist（含 DB migration 与回滚步骤）", versionNo: 1, status: "draft", updatedAt: "2026-09-28T09:00:00Z" },
    ];

const BODY: Record<string, string> = {
  d1: HTML_BODY,
  d2: MD_BODY,
  d3: "<h1>站点地图</h1><p>/ · /docs · /pricing</p>",
  d4: "# 灰度发布\n\n1. 先发 5%\n2. 看 15 分钟\n",
};

const REVISIONS = [
  { id: "r3", versionNo: 3, title: "数据说明.md", authorId: "u1", authorName: "heaven", changeNote: "补口径说明", createdAt: "2026-09-30T14:02:00Z" },
  { id: "r2", versionNo: 2, title: "数据说明.md", authorId: "u1", authorName: "heaven", changeNote: "", createdAt: "2026-09-30T11:40:00Z" },
  { id: "r1", versionNo: 1, title: "数据说明.md", authorId: "u1", authorName: "heaven", changeNote: "初稿", createdAt: "2026-09-29T20:11:00Z" },
];

const SEARCH: KbSearchResult = {
  query: "口径",
  // ⚠️ 高亮是服务端 ts_headline 产出的 [[HL]] 哨兵，不是 <mark>——
  // 前端把整段转义后只把哨兵换成 <mark>（见 KbSearchView.renderSnippet）。
  // 这里写成 <mark> 会被转义成字面量，看起来像产品 bug。
  hits: [
    { documentId: "d2", spaceId: "s1", title: "数据说明.md", versionNo: 3, rank: 0.9, snippet: "指标[[HL]]口径[[/HL]]…已完成需求：以任务关闭时间为准" },
    { documentId: "d4", spaceId: "s1", title: "灰度发布 checklist（含 DB migration 与回滚步骤）", versionNo: 1, rank: 0.4, snippet: "…灰度[[HL]]口径[[/HL]]按流量比例…" },
  ],
};

// ── 拦截 fetch：假的 knowledge-server ────────────────────────────────
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const realFetch = window.fetch.bind(window);
const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();

  // ?old=1：假装服务端是 0.4.0（那时还没有 version 字段）——看「该升级了」那条提示
  if (path === "/api/health") {
    return q.get("old")
      ? json({ status: "ok", service: "aide-knowledge", parsers: [], tokenizer: "jieba-rs" })
      : json({
          status: "ok",
          service: "aide-knowledge",
          version: "0.5.0",
          parsers: [],
          tokenizer: "jieba-rs",
        });
  }
  if (path === "/api/auth/status") return json({ initialized: true });
  if (path === "/api/auth/me") {
    if (q.get("gate")) return json({ error: "unauthorized", message: "登录已过期" }, 401);
    return json({ id: "u1", username: "heaven", email: null, displayName: "heaven", isAdmin: true });
  }
  if (path === "/api/spaces") return json([SPACE]);
  if (path.startsWith("/api/spaces/") && path.endsWith("/documents")) return json(SUMMARY);
  if (path === "/api/search") return json(SEARCH);
  // 建文档：索引页那个「把使用指南存进资料库」要走它，所以夹具得认
  if (path === "/api/documents" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { title?: string; content?: string };
    const id = `new${SUMMARY.length}`;
    SUMMARY.push({
      id, parentId: null, kind: "doc", slug: id,
      title: body.title ?? "未命名文档", versionNo: 1, status: "draft",
      updatedAt: new Date().toISOString(),
    });
    BODY[id] = body.content ?? "";
    return json({ documentId: id, revisionId: `r-${id}`, versionNo: 1, merged: false });
  }
  if (path.endsWith("/revisions")) return json(REVISIONS);
  if (path.endsWith("/lock") && method === "POST") return json({ held: true, holder: null });
  if (path.endsWith("/lock") && method === "DELETE") return json({ released: true });
  if (path.endsWith("/lock/heartbeat")) return json({ renewed: true });
  const doc = /^\/api\/documents\/([^/]+)$/.exec(path);
  if (doc && method === "GET") {
    const id = doc[1];
    const sum = SUMMARY.find((d) => d.id === id);
    if (!sum) return json({ error: "not_found", message: "找不到这份资料" }, 404);
    const full: KbDocument = { ...sum, spaceId: "s1", content: BODY[id] ?? "" };
    return json(full);
  }

  if (url.origin !== location.origin) return realFetch(input as RequestInfo, init);
  return json({ error: "not_found", message: `夹具没有这条路由：${method} ${path}` }, 404);
};

if (LIVE) {
  // 真服务：不拦 fetch。**不清 token**——有没有凭据由真实状态决定
  // （要验的第一件事就是「有凭据时打开面板不落登录页」）。
  localStorage.setItem("aide.kb.baseUrl", LIVE_BASE);
} else {
  window.fetch = mockFetch;
  // 凭据：kbClient 从 localStorage 读，不塞就落登录页
  localStorage.setItem("aide.kb.baseUrl", location.origin);
  localStorage.setItem("aide.kb.token", "harness-token");
}

// ── 装进一个接近真实主区的容器 ──────────────────────────────────────
const style = document.createElement("style");
style.textContent = `
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--aide-ambient-scene);
    color: var(--aide-text-primary);
    font-family: var(--aide-font-ui);
    -webkit-font-smoothing: antialiased;
    display: grid;
    place-items: center;
  }
  #app { width: ${W}px; height: ${H}px; overflow: hidden; }
`;
document.head.appendChild(style);

const app = createApp({ render: () => h("div", { style: "display:contents" }, [h(KnowledgeBase), h(ModalDialog)]) });
app.mount("#app");

// 默认选中哪一份：?html=1 选网页条目，否则选 markdown
// live 模式下节点 id 是真的 uuid，这两个开关没有意义
if (!LIVE) {
  const pick = q.get("html") ? "d1" : "d2";
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-kb-node="${pick}"]`);
      row?.click();
    }),
  );
}

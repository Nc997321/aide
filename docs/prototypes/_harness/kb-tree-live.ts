/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** KbTree / KbSpaceList 挂进
 * 浏览器，用真实主题 token 渲染。原型页（2026-09-18-kb-tree.html）是手抄的 CSS，
 * 这个跑的是组件自己的 scoped 样式——token 名写错、scoped 选择器没生效都会露出来。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/kb-tree-live.html
 *
 * 菜单/重命名/新建是组件内部状态，外部调不到，所以挂载后用 DOM 点击真按钮把它们点开
 * （走的就是真实事件处理）。侧栏真实宽度 220px，夹具按真实比例渲染——否则缩进与
 * 截断都看不准。
 */
import { createApp, h, ref, type VNodeRef } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import KbTree from "../../../src/components/KnowledgeBase/KbTree.vue";
import KbSpaceList from "../../../src/components/KnowledgeBase/KbSpaceList.vue";
import type { KbDocumentSummary, KbSpace } from "../../../src/components/KnowledgeBase/kbClient";

applyTheme(glass);

const DOCS: KbDocumentSummary[] = [
  { id: "f1", parentId: null, kind: "folder", slug: "ops", title: "运维手册", versionNo: 0, status: "draft", updatedAt: "" },
  { id: "f2", parentId: "f1", kind: "folder", slug: "deploy", title: "部署", versionNo: 0, status: "draft", updatedAt: "" },
  { id: "d1", parentId: "f2", kind: "doc", slug: "rollback", title: "回滚手册", versionNo: 1, status: "draft", updatedAt: "" },
  { id: "d2", parentId: "f2", kind: "doc", slug: "canary", title: "灰度发布 checklist（含 DB migration）", versionNo: 3, status: "draft", updatedAt: "" },
  { id: "f3", parentId: "f1", kind: "folder", slug: "drill", title: "演练记录", versionNo: 0, status: "draft", updatedAt: "" },
  { id: "d3", parentId: "f1", kind: "doc", slug: "duty", title: "值班表", versionNo: 1, status: "draft", updatedAt: "" },
  { id: "d4", parentId: null, kind: "doc", slug: "handbook", title: "Engineering Handbook", versionNo: 1, status: "draft", updatedAt: "" },
  { id: "f4", parentId: null, kind: "folder", slug: "product", title: "产品档案", versionNo: 0, status: "draft", updatedAt: "" },
];

const SPACES: KbSpace[] = [
  { id: "s1", key: "eng", name: "工程手册", description: null, visibility: "internal", role: "owner" },
  { id: "s2", key: "prod", name: "产品档案", description: null, visibility: "private", role: "editor" },
];

const pane = (label: string, child: unknown, probe: string) =>
  h("div", { class: "pane", "data-probe": probe }, [h("h2", null, label), child as never]);

const spaceRef = ref<InstanceType<typeof KbSpaceList> | null>(null);

const app = createApp({
  setup() {
    const collapsedAll = ref<ReadonlySet<string>>(new Set<string>());
    const collapsedOne = ref<ReadonlySet<string>>(new Set(["f4"]));
    const tree = (over: Record<string, unknown>) =>
      h(KbTree, {
        documents: DOCS,
        activeId: null,
        spaceId: "s1",
        busy: false,
        ...over,
      } as never);

    return () =>
      h("div", { class: "wrap" }, [
        h("h1", null, "知识库目录树 · 真实组件（KbTree.vue / KbSpaceList.vue）"),
        h("p", null, "跑的是组件自己的 scoped 样式与真实主题 token；侧栏按真实宽度 220px 渲染。"),

        h("div", { class: "row" }, [
          pane(
            "① 全展开 · 文件夹的 ⋯ 菜单",
            tree({ collapsed: collapsedAll.value, activeId: "d1" }),
            "p1",
          ),
          pane(
            "② 折叠由父层传入 · 文档的 ⋯ 菜单",
            tree({ collapsed: collapsedOne.value }),
            "p2",
          ),
          pane("③ 就地重命名 / 新建", tree({ collapsed: collapsedAll.value }), "p3"),
          pane(
            "④ 空间列表 · ⋯ 菜单",
            h(KbSpaceList, { spaces: SPACES, activeId: "s1", busy: false, ref: spaceRef as VNodeRef } as never),
            "p4",
          ),
        ]),
      ]);
  },
});

const style = document.createElement("style");
style.textContent = `
  body { background: radial-gradient(560px 380px at 10% -8%, rgba(124,108,255,.32), transparent 65%), #0a0b11;
         font-family: var(--aide-font-ui); color: var(--aide-text-primary); padding: 24px 28px 64px; }
  .wrap > h1 { font-size: 16px; font-weight: 600; }
  .wrap > p { margin-top: 7px; font-size: 12px; color: var(--aide-text-muted); line-height: 1.7; }
  .row { display: flex; gap: 26px; margin-top: 22px; align-items: flex-start; }
  .pane { width: 220px; }
  .pane h2 { font-size: 12px; font-weight: 600; color: var(--aide-text-secondary); margin-bottom: 9px; min-height: 32px; }
`;
document.head.appendChild(style);

app.mount("#app");

/** 菜单项按文字找——不按下标，顺序不是契约，措辞才是。 */
function clickMenuItem(scope: Element, text: string): void {
  const hit = [...scope.querySelectorAll("[data-kb-menu] button")].find(
    (b) => b.textContent?.trim() === text,
  );
  (hit as HTMLElement | undefined)?.click();
}

requestAnimationFrame(() => {
  const p1 = document.querySelector('[data-probe="p1"]')!;
  p1.querySelector<HTMLElement>('[data-kb-node="f1"] [data-kb-more]')?.click();

  const p2 = document.querySelector('[data-probe="p2"]')!;
  p2.querySelector<HTMLElement>('[data-kb-node="d4"] [data-kb-more]')?.click();

  // ③ 同一棵树上先后点开：新建输入占住标题位，接着让另一个节点进入重命名，
  //    两个状态一起看（重命名会关掉新建，所以分两次 rAF 做）
  const p3 = document.querySelector('[data-probe="p3"]')!;
  p3.querySelector<HTMLElement>('[data-kb-node="f2"] [data-kb-add]')?.click();
  requestAnimationFrame(() => {
    const d3 = p3.querySelector<HTMLElement>('[data-kb-node="d3"] [data-kb-more]');
    d3?.click();
    requestAnimationFrame(() => clickMenuItem(p3, "重命名"));
  });

  const p4 = document.querySelector('[data-probe="p4"]')!;
  p4.querySelector<HTMLElement>('[data-space="s1"] [data-kb-more]')?.click();
});

/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** KbTree / KbSpaceList 挂进
 * 浏览器，用真实主题 token 渲染。原型页（2026-09-18-kb-tree.html）是手抄的 CSS，
 * 这个跑的是组件自己的 scoped 样式——token 名写错、scoped 选择器没生效都会露出来。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/kb-tree-live.html
 *
 * 菜单（ContextMenu）与对话框（ModalDialog）都是**应用级单例**（Teleport 到 body），
 * 夹具必须一并挂上，且同一时刻只能开一个——所以这里只演示一个开着的菜单。
 * 侧栏真实宽度 220px，夹具按真实比例渲染，否则缩进与截断都看不准。
 */
import { createApp, h, ref, type VNodeRef } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import KbTree from "../../../src/components/KnowledgeBase/KbTree.vue";
import KbSpaceList from "../../../src/components/KnowledgeBase/KbSpaceList.vue";
import ContextMenu from "../../../src/components/ContextMenu.vue";
import ModalDialog from "../../../src/components/ModalDialog.vue";
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

/** 与 KnowledgeBase.vue 的 `.kb-sidesec.grow` 同款：定高 + `overflow: auto`。 */
const clipped = (child: unknown, probe: string) =>
  h("div", { class: "sec grow", "data-probe": probe }, [child as never]);

const spaceRef = ref<InstanceType<typeof KbSpaceList> | null>(null);

const app = createApp({
  setup() {
    const collapsedAll = ref<ReadonlySet<string>>(new Set<string>());
    const collapsedOne = ref<ReadonlySet<string>>(new Set(["f4"]));
    const tree = (over: Record<string, unknown>) =>
      h(KbTree, { documents: DOCS, activeId: null, busy: false, ...over } as never);

    return () =>
      h("div", { class: "wrap" }, [
        // 菜单与对话框都是应用级单例（Teleport 到 body），夹具必须一并挂上
        h(ContextMenu),
        h(ModalDialog),
        h("h1", null, "知识库目录树 · 真实组件（KbTree.vue / KbSpaceList.vue）"),
        h("p", null, "跑的是组件自己的 scoped 样式与真实主题 token；侧栏按真实宽度 220px 渲染。"),

        h("div", { class: "row" }, [
          pane("① 全展开", tree({ collapsed: collapsedAll.value, activeId: "d1" }), "p1"),
          pane("② 折叠由父层传入（产品档案已折叠）", tree({ collapsed: collapsedOne.value }), "p2"),
          pane("③ 就地重命名", tree({ collapsed: collapsedAll.value }), "p3"),
          pane("④ 就地新建", tree({ collapsed: collapsedAll.value }), "p4"),
        ]),

        h("div", { class: "row" }, [
          pane(
            "⑤ 空间列表",
            h(KbSpaceList, { spaces: SPACES, activeId: "s1", busy: false, ref: spaceRef as VNodeRef } as never),
            "p5",
          ),
          h("div", { class: "pane" }, [
            h("h2", null, "⑥ 真实侧栏容器（120px 高 + overflow:auto）· 末行开 ⋯"),
            h("p", {
              class: "note",
            }, "菜单走应用统一的 ContextMenu（Teleport 到 body + fixed），所以不会被容器裁掉——这正是它换掉行内浮层的原因。"),
            clipped(
              h(KbTree, {
                documents: DOCS,
                activeId: null,
                collapsed: collapsedAll.value,
                busy: false,
              } as never),
              "p6",
            ),
          ]),
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
  .note { font-size: 11px; color: var(--aide-text-muted); line-height: 1.6; margin: 0 0 9px; }
  .sec.grow { height: 120px; overflow: auto; border: 1px dashed rgba(255,255,255,.18); border-radius: 6px; padding: 4px; }
`;
document.head.appendChild(style);

app.mount("#app");

/** 点开 ContextMenu 里某一项（它在 body 上，不在组件子树里）。 */
function clickMenuItem(text: string): void {
  const hit = [...document.querySelectorAll(".context-menu .ctx-item")].find(
    (b) => b.textContent?.trim() === text,
  );
  (hit as HTMLElement | undefined)?.click();
}

const probe = (p: string) => document.querySelector(`[data-probe="${p}"]`)!;
const rowBtn = (p: string, id: string, attr: string) =>
  probe(p).querySelector<HTMLElement>(`[data-kb-node="${id}"] [${attr}]`);

// ⚠️ 严格一帧一步。菜单是**全局单例**：一次点击只能开一个，而 `clickMenuItem` 点的
// 永远是「当前开着的那个菜单」——所以「点开 → 选一项」必须紧邻，中间不能插别的开菜单动作
// （之前把 ⑥ 的开菜单夹在中间，结果 ③ 的「重命名」点到了 ⑥ 的菜单上）。
const steps: Array<() => void> = [
  // ③ 就地重命名
  () => rowBtn("p3", "d3", "data-kb-more")?.click(),
  () => clickMenuItem("重命名"),
  // ④ 就地新建
  () => rowBtn("p4", "f2", "data-kb-add")?.click(),
  // ⑥ 末行的 ⋯ —— 菜单开在 120px 容器之外，证明它不被裁剪
  () => rowBtn("p6", "d4", "data-kb-more")?.click(),
  // 空间的新建对话框（原先那个挤在侧栏一小条里的浮层）。它是模态，会盖住整页，
  // 所以放最后——想看菜单那版就把这两步注掉
  () => spaceRef.value?.startCreate(),
];

let i = 0;
const tick = (): void => {
  steps[i++]?.();
  if (i < steps.length) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

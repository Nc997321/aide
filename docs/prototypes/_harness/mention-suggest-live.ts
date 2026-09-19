/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** ChatInputBox 挂进浏览器，
 * 用真实主题 token 与组件自己的 scoped 样式渲染 `@` 补全弹层——原型页是手抄 CSS，
 * 这里跑真组件，能抓到抄错（token 名写错、scoped 选择器没生效、flex 对齐跑偏）。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/mention-suggest-live.html
 *
 * 数据源用 setTransport 注入假传输层（不起 Tauri）：list_directory / find_files_by_name /
 * path_types 三条命令按 mock 应答，其余（会话身份、技能扫描等挂载期调用）返回 undefined。
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import { setTransport } from "@aide/sdk"; // 包根导出（与 remote-pwa 同一入口；exports 表里没有 ./transport）
import ChatInputBox from "../../../src/components/ChatPanel/ChatInputBox.vue";
import { useWorkspaces } from "../../../src/composables/useWorkspaces";

const WS = "C:\\Users\\<user>\\IdeaProjects\\aide";

interface Entry { name: string; path: string; is_dir: boolean; children: Entry[] | null }
const dir = (name: string): Entry => ({ name, path: `${WS}\\${name}`, is_dir: true, children: [] });
const file = (name: string, at = ""): Entry => ({
  name,
  path: at ? `${WS}\\${at}\\${name}` : `${WS}\\${name}`,
  is_dir: false,
  children: null,
});

// list_directory：目录在前 + 按名升序（与 Rust 同序，夹具照抄一遍以免看起来"是组件排的"）
const LISTINGS: Record<string, Entry[]> = {
  [WS]: [
    dir("agent-sidecar"), dir("docs"), dir("ohos"), dir("packages"), dir("src"), dir("src-tauri"),
    file("CLAUDE.md"), file("package.json"),
  ],
  [`${WS}\\src`]: [
    dir("api"), dir("components"), dir("composables"), dir("themes"), dir("utils"),
    file("App.vue", "src"), file("main.ts", "src"),
  ],
};

// find_files_by_name：只回文件、绝对路径
const DEEP_FILES = [
  `${WS}\\src-tauri\\src\\commands\\chat.rs`,
  `${WS}\\src-tauri\\src\\commands\\filesystem.rs`,
  `${WS}\\agent-sidecar\\src\\engine\\instructions.ts`,
  `${WS}\\ohos\\entry\\src\\main\\ets\\session\\chat\\ChatTranscript.ets`,
];

// 已注册工作区：含「会话自己」「祖先」「missing」三种该被挡掉的情况
const WORKSPACES = [
  { key: "k-idea", name: "C:\\Users\\<user>\\IdeaProjects", missing: false }, // WS 的祖先 → 挡
  { key: "k-aide", name: WS, missing: false }, // 会话自己 → 挡
  { key: "k-be", name: "C:\\Users\\<user>\\IdeaProjects\\backend-gateway", missing: false },
  { key: "k-mobile", name: "D:\\repo\\mobile-app", missing: false },
  { key: "k-gone", name: "C:\\Users\\<user>\\IdeaProjects\\gone", missing: true }, // 路径不在了 → 挡
];

setTransport({
  invoke: async (command: string, params?: Record<string, unknown>) => {
    const p = params ?? {};
    if (command === "list_directory") return LISTINGS[String(p.path)] ?? [];
    if (command === "path_types") return (p.paths as string[]).map(() => "file");
    if (command === "list_workspaces") return WORKSPACES;
    if (command === "find_files_by_name") {
      const q = String(p.query).toLowerCase();
      return DEEP_FILES.filter((f) => f.toLowerCase().split("\\").pop()!.includes(q));
    }
    return undefined;
  },
  listen: async () => () => {},
});

// 先拉一次工作区列表（模块级单例），否则候选里没有项目行
await useWorkspaces().refresh();

applyTheme(glass);

const provider = {
  id: "p1", kind: "custom", name: "p1", icon: "provider", baseUrl: "",
  apiKeyConfigured: false, authTokenConfigured: false, model: "", modelMappings: {
    anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "",
  },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "", knownModels: [],
};

// 顺序有意：弹层向上展开，所以"行数最多"的裸 @ 放最后一条（上方有整段边距给它）
const CASES: Array<[string, string]> = [
  ["① @back：项目按名包含匹配（一行）", "@back"],
  ["② @src/ 逐级下钻：该层子项，目录带「→ 进入」", "@src/"],
  ["③ @s 三类混排：项目 + 本层 + 全仓兜底", "@s"],
  ["④ 裸 @：其它项目在最前（标「项目」+ 父目录），再本层", "@"],
];

const app = createApp({
  render: () =>
    h("div", { class: "wrap" }, [
      h("h1", "@ 补全弹层 · 真实组件（ChatInputBox.vue）"),
      h("p", "每条都是真组件实例：弹层位置、行密度、选中态、目录「→ 进入」、全仓标签全部走组件自己的 scoped 样式。"),
      ...CASES.map(([label, value]) =>
        h("section", [
          h("h2", label),
          h(ChatInputBox, {
            sessionId: null,
            workspacePath: WS,
            isBusy: false,
            isHero: false,
            models: [],
            permissionModes: [],
            sessionProvider: provider,
            sendConfirmedNonce: 0,
            focused: true,
          }),
          h("code", { class: "typed" }, value),
        ]),
      ),
    ]),
});

const style = document.createElement("style");
style.textContent = `
  body { background: radial-gradient(560px 380px at 10% -8%, rgba(124,108,255,.32), transparent 65%), #0a0b11;
         font-family: var(--aide-font-ui); color: var(--aide-text-primary); padding: 430px 28px 64px; /* 顶部留白：第一条弹层向上展开也不会被视口顶截掉 */ }
  .wrap { max-width: 760px; }
  h1 { font-size: 16px; font-weight: 600; }
  .wrap > p { margin-top: 7px; font-size: 12px; color: var(--aide-text-muted); line-height: 1.7; }
  section { margin-top: 20px; margin-bottom: 300px; } /* 留白给向上展开的弹层，互不遮挡 */
  section h2 { font-size: 12px; font-weight: 600; color: var(--aide-text-secondary); margin-bottom: 6px; }
  .typed { display: block; margin-top: 6px; font-family: var(--aide-font-mono); font-size: 11px; color: var(--aide-text-muted); }
  pre { margin-top: 8px; }
`;
document.head.appendChild(style);

app.directive("tooltip", vTooltip);
app.mount("#app");

/** 夹具扮演用户：落字 + 摆光标 + 触发 input（组件与补全都靠这一个事件醒）。
 *  同步执行——截图工具在 load 之后取景，异步等待（setTimeout）会被截在前头。 */
function typeInto(index: number, value: string) {
  const areas = document.querySelectorAll("textarea.chat-input");
  const ta = areas[index] as HTMLTextAreaElement | undefined;
  if (!ta) return;
  ta.value = value;
  ta.setSelectionRange(value.length, value.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

CASES.forEach(([, value], i) => typeInto(i, value));

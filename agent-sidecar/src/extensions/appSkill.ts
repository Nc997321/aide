import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toForwardSlashes, safeDirname } from "../engine/winPaths.js";

/**
 * aide-app skill 自动落地（内建，免用户配置）：教 agent 给 Aide 写「侧栏应用」。
 *
 * 用户说「在 Aide 里做一个 XX」时，agent 要知道往哪写、清单长什么样、界面能调什么、
 * 写完怎么知道跑成什么样。这些是任务级工作流，靠 skill 触发（同 browser-inspect）。
 * 内容必须与 Host 的实现对得上：清单规则在 `aide-core/src/apps/manifest.rs`，
 * 桥方法表在 `aide-core/src/apps/bridge.rs`，界面侧 API 在 `src-tauri/src/commands/aide_app.js`。
 * 设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md。
 */

type Env = Record<string, string | undefined>;

const SKILL_DIR_NAME = "aide-app";

export function appSkillPath(env: Env): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return path.join(toForwardSlashes(path.join(toForwardSlashes(dir), "skills", SKILL_DIR_NAME)), "SKILL.md");
}

export const APP_SKILL_CONTENT = `---
name: aide-app
description: Use when the user asks to build, add, change or debug a tool, panel, sidebar button, mini-game, dashboard or any custom feature INSIDE Aide itself (e.g. "在 Aide 里做一个接口调试工具", "给侧边栏加个小游戏", "做个数据库面板"). Covers where an Aide app lives, its manifest, the UI bridge API, the optional backend, and how to read back what went wrong.
---

# 给 Aide 写侧栏应用

Aide 应用 = 一个文件夹：清单 \`app.json\` + 网页界面（+ 可选后端）。用户同意后，它出现在 Aide 的侧栏里。

## 写在哪

写到**当前工作区**的 \`.aide/apps/<id>/\`。这是开发态：Aide 每隔几秒看一次，文件一改面板就重载。
不要写到用户家目录的 \`~/.aide/apps/\`——做好后由用户在面板上点「安装」。

工作区必须是受信任的，否则 Aide 不会加载它。应用第一次出现时用户要在面板里点「同意并启用」；
**你启用不了它，也安装不了它**。做完后必须把这几件事都告诉用户（他不会自己知道）：

1. 去侧栏点新出现的入口，点「同意并启用」；
2. 现在它是开发中的版本：你之后的改动会立刻生效（在某个项目里做的，还只在打开那个项目时出现）。
   用着满意，点面板顶上的「安装到 Aide」，它就固定下来、一直留在 Aide 里。
3. 说清它现在在哪一侧，以及**位置可以换**：面板顶上有「移到主区 / 移到右栏」，一点就挪过去。
   用户不会自己知道应用还能待在另一侧。

用户之后要你改一个已经安装的应用：照样改工作区里的这一份（没有就从 \`~/.aide/apps/<id>/\` 复制过来再改），
改完告诉他点面板顶上的「更新安装」。

## 清单 app.json

\`\`\`json
{
  "id": "api-tester",
  "name": "接口调试",
  "version": "0.1.0",
  "icon": "ui/icon.svg",
  "panel": { "entry": "ui/index.html", "placement": "main" },
  "permissions": ["storage", "net"],
  "server": { "entry": "server/main.mjs" }
}
\`\`\`

- \`id\`：小写字母、数字、连字符，**必须等于文件夹名**。
- \`icon\`：侧栏入口上的图标，**每个应用都要给一个**（不给就是和别的应用一样的默认图标，用户分不清）。
  首选单色 SVG：\`viewBox="0 0 24 24"\`、线条画、不要背景——Aide 只取它的形状，按主题色着色，
  所以颜色写什么都行，但别画成一整块实心方块。想要彩色就用 PNG（原样显示）。不超过 256KB。
- \`placement\`：\`right\`（默认，右侧窄面板，适合小工具、小游戏）或 \`main\`（左侧导航里一行，点开占满主区，适合要空间的工具）。
  **每次都按这个应用要多大地方来选，别无脑用默认**：表格、多栏、编辑器、要对照着看的东西 → \`main\`。
  这只是初始位置：用户在面板上挪过之后以他挪的为准，你再改清单里的这一项不会把它挪回去。
- \`permissions\`：只申请用得到的。每多一项，用户就要重新同意一次。
  \`storage\` 存自己的数据 · \`secrets\` 存密码令牌 · \`net\` 访问任意地址 · \`net:<主机名>\` 只访问一台主机 ·
  \`workspace:read\` / \`workspace:write\` 读写工作区文件 · \`session:read\` 看 agent 的活动 ·
  \`composer\` 往用户的输入框里填内容。
- \`server\`：可选，见下文「后端」。
- 所有路径都是应用文件夹内的相对路径，用正斜杠。

## 界面

界面是普通网页，框架不限，但跑在**沙箱 iframe** 里，有三条硬限制：

1. **不能自己联网**：\`fetch\`、XHR、WebSocket 都被拦。要联网用 \`aide.net.fetch\`。CDN 上的脚本和样式也加载不了——依赖要放进应用文件夹。
2. **没有 localStorage / cookie / IndexedDB**。要存数据用 \`aide.storage\`。
3. 页面里引入桥：\`<script src="/aide-app.js"></script>\`（Aide 提供，路径固定）。

\`\`\`js
await aide.storage.set("key", anyJsonValue);   // get / delete / keys
await aide.secrets.set("db.password", "…");    // get / delete；key 只能用字母数字 . _ -
const res = await aide.net.fetch({ url, method: "POST", headers: {}, body: "…" });
//    → { status, statusText, headers, body（文本时）, bodyBase64 }
const { text } = await aide.fs.read("src/a.txt");      // 路径相对工作区根
const { entries } = await aide.fs.list("src");         // [{ name, isDir, size }]
await aide.fs.write("notes.md", "…");                  // 写不进 .git 和 .aide
aide.session.onEvent((e) => { /* tool.start / tool.end / subagent.* / turn.start / turn.end */ });
await aide.composer.fill("帮我分析这个响应：…");         // 填进用户的输入框，不会替用户发送
aide.ui.toast("已保存");  aide.ui.setBadge(3);
const info = await aide.host.info();           // { os, source }
\`\`\`

没申请对应权限的调用会被拒绝（Promise reject，原因写明缺哪项权限）。

**配色**：桥会把 Aide 的主题变量铺到页面根元素上，直接写 \`var(--aide-bg-base)\`、\`--aide-bg-raised\`、
\`--aide-text-primary\`、\`--aide-text-secondary\`、\`--aide-border\`、\`--aide-accent\`、\`--aide-danger\`、\`--aide-success\`，
界面就跟着用户的主题走。不要硬编码颜色。

## 后端（可选）

界面做不了的事（连数据库、跑命令、长连接）放后端。后端是一个 **stdio MCP server**，用 Host 上的 Node（18+）运行：

- 入口是清单里 \`server.entry\` 指的那个文件（ES module）。
- **依赖必须自带**：没有 \`npm install\` 这一步，不支持原生模块。要么只用 Node 标准库（内置 \`fetch\`），
  要么把纯 JS 依赖打包成单文件 / 连 \`node_modules\` 一起放进应用文件夹。
- 协议是按行分隔的 JSON-RPC：要应答 \`initialize\`、\`tools/list\`、\`tools/call\`。不想带 MCP SDK 就手写，几十行。
- **后端的工具有两个调用方**：界面（\`aide.tools.call(name, args)\` / \`aide.tools.list()\`）和 agent 会话
  （工具名 \`mcp__app-<id>__<工具名>\`）。两边各起各的进程，所以**状态不要放在内存里**，
  落到环境变量 \`AIDE_APP_DATA\` 指的目录。
- 只往 stdout 写协议消息；日志写 stderr。
- 不改动任何东西的工具，在 \`tools/list\` 里标上 \`"annotations": { "readOnlyHint": true }\`：
  应用**安装后**，agent 调这类工具不再逐次问用户。开发态下不生效（每次都问），别为此困惑。
  会写入、删除、发请求的工具**不要**标。

## 写完怎么知道对不对

读应用文件夹里的 **\`.aide-dev.log\`**。Aide 把这些记在里面：

- \`manifest: …\` 清单的问题（id 与文件夹名不一致、未知权限、路径越界……），修好后会出现 \`manifest: ok\`
- \`ui error: …\` 界面里的报错：未捕获异常、未处理的 Promise 拒绝、\`console.error\`
- \`server: …\` 后端的 stderr，以及 \`server … failed: …\` 调用失败的原因

Aide 第一次看到一个应用就会写一行 \`manifest: ok\`（或清单的问题）。改完文件等几秒再读它：
日志里有 \`manifest: ok\`、没有新报错，再告诉用户可以试了。

**等了十几秒还没有这个文件** = Aide 没在看这个文件夹：它打开的是另一个工作区（只扫窗口当前打开的
工作区和日常目录）。这时直接把这一点告诉用户，请他确认打开的是这个工作区——不要去翻 Aide 的配置
或源码，也不要把应用复制到别的目录。
用户反馈「点了没反应 / 白屏」时，先读这个文件。

## 常见错误

- 忘了引 \`/aide-app.js\`，\`aide\` 未定义。
- 从 CDN 引库 → 被拦，白屏。把文件下载进应用文件夹。
- 用了 \`localStorage\` → 抛 SecurityError。
- 清单里申请了权限却没用，或用了没申请的。
- 后端往 stdout 打日志，把协议搅乱。
`;

/** 幂等落地：内容不同才写。任何失败都跳过，不影响会话。 */
export function ensureAppSkill(env: Env): void {
  const file = appSkillPath(env);
  try {
    // mkdirSync 独立 try：bun 的 recursive mkdir 对已存在目录抛 EEXIST（Node 是 no-op）
    try {
      mkdirSync(safeDirname(file), { recursive: true });
    } catch {
      /* 父目录已存在或不可创建，继续尝试写 */
    }
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* 不存在，下面写 */
    }
    if (current !== APP_SKILL_CONTENT) writeFileSync(file, APP_SKILL_CONTENT, "utf8");
  } catch {
    /* 配置目录不可写等情况：跳过 */
  }
}

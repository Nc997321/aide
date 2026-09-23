// @vitest-environment jsdom
//
// 投影脚本是**注入进页面的源码字符串**：`projection.test.ts` 那层字符串断言看不出它在真 DOM 上
// 跑起来对不对——页面侧一个错字（写错的属性、走岔的分支）在那边全绿，只在真页面上现形。
// 所以这一份把它**跑起来**：`buildProjectionScript()` 的产物当表达式求值（与 `ExecuteScript` /
// `Runtime.evaluate` 同一条路），断言的是**行为**。
//
// ⚠️ 三条环境事实（都不是被测对象，写在这里免得后人误读）：
// 1. jsdom 没有 `innerText`（浏览器专有），所以下面按浏览器语义补了个最小实现——
//    投影脚本要的正是"浏览器自己判可见性"这条契约（见 `projectText` 的注释）。
// 2. jsdom 由**仓库根**的 devDependency 提供（vitest 按 node 解析一路上溯找到的）。sidecar 独立
//    安装（没有根 node_modules）时这个文件会报找不到 jsdom——那时请把断言挪回 `projection.test.ts`
//    的装配不变量，**别往 sidecar 加依赖**（它刻意不在 workspace 里）。
// 3. 全仓 tsconfig 只装 node types（`lib: ["ES2022"]`），没有 DOM lib，所以下面用 `dom.*` 取那几个
//    全局——**别去动 tsconfig 的 lib**（那份配置服务于生产构建，为一份测试放开 DOM 是反的）。
import { describe, it, expect } from "vitest";
import { buildProjectionScript } from "./projection.js";

/** jsdom 环境提供的全局（类型上自己收窄，见文件头第 3 条）。 */
const dom = globalThis as unknown as {
  document: any;
  HTMLElement: any;
  getComputedStyle: (el: any) => { display: string };
};

/**
 * 跑一次真投影。脚本形态是 IIFE 表达式，`return` 包一层即按表达式求值；
 * 脚本里的 `document` / `getComputedStyle` 由 jsdom 环境的全局提供。
 */
function project(opts: { includeHidden?: boolean } = {}): Record<string, any> {
  return new Function("return " + buildProjectionScript(opts))() as Record<string, any>;
}

/**
 * 按浏览器语义补一个**最小** `innerText`：跳过不渲染的子树（`display:none` / `hidden` 属性），
 * 其余取文本、折叠空白。
 *
 * 它不是被测对象——被测的是投影脚本**怎么用它**（"什么算可见交给浏览器自己判"）。把它写清楚，
 * 免得读者以为过滤逻辑是脚本自己做的。
 */
function installInnerText(): void {
  const notRendered = (el: any): boolean =>
    el.hidden === true ||
    (el.style && el.style.display === "none") ||
    dom.getComputedStyle(el).display === "none";

  const collect = (node: any, out: string[]): void => {
    for (const child of Array.from(node.childNodes) as any[]) {
      if (child.nodeType === 3) out.push(child.nodeValue ?? "");
      else if (child.nodeType === 1 && !notRendered(child)) collect(child, out);
    }
  };

  Object.defineProperty(dom.HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: any) {
      const out: string[] = [];
      collect(this, out);
      return out.join(" ").replace(/\s+/g, " ").trim();
    },
  });
}

/** 一份最小的"渲染中 + 隐藏"文档：两个标记各自只出现一次，断言不会互相顶替。 */
function domWithHidden(): void {
  dom.document.body.innerHTML =
    '<div id="shown">SHOWNMARK</div><div id="hidden" style="display:none">HIDDENMARK</div>';
}

describe("投影脚本：真 DOM 上的运行行为", () => {
  /**
   * 老运行时 / 无 body：拿不到 `innerText` ⇒ 脚本必须**承认这份没过滤**（`textFiltered:false`
   * 让 format.ts 出旁注），而不是把 `textContent` 冒充成过滤过的结果。
   */
  it("(i) innerText 不可用时如实报「这份没过滤」，隐藏文本在里面", () => {
    // jsdom 本来就没有；显式删一次是防串场（同一文件里别的用例会把它装上）。
    delete (dom.HTMLElement.prototype as any).innerText;
    domWithHidden();

    const r = project();

    expect(r.ok).toBe(true);
    expect(r.textFiltered).toBe(false);
    expect(r.text).toContain("HIDDENMARK");
  });

  /** 常态：`display:none` 的内容不该出现在正文里，标志说这一份过滤过了。 */
  it("(ii) 常规 DOM + 隐藏容器 → 隐藏文本不在，标志说过滤过了", () => {
    installInnerText();
    domWithHidden();

    const r = project();

    expect(r.textFiltered).toBe(true);
    expect(r.text).toContain("SHOWNMARK");
    expect(r.text).not.toContain("HIDDENMARK");
    // 这四类计数是**隐藏项唯一会说话的地方**；隐藏的只是"文本"时四个桶全是 0 ⇒ 一行 NOTE 都不会
    // 有。所以"正文只列渲染中的文本、include_hidden 也管它"这句只能写在工具描述里（工具面）。
    expect(r.hiddenSkipped).toEqual({ headings: 0, tables: 0, fields: 0, clickables: 0 });
  });

  /** 开关真的管正文：`include_hidden` 打开后隐藏文本**在**（与骨架"列隐藏项"同义）。 */
  it("(iii) include_hidden:true → 隐藏文本在正文里", () => {
    installInnerText();
    domWithHidden();

    const r = project({ includeHidden: true });

    expect(r.textFiltered).toBe(true);
    expect(r.text).toContain("HIDDENMARK");
  });
});

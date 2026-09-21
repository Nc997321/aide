import { describe, it, expect } from "vitest";
import { buildProjectionScript } from "./projection.js";
import { CLICKABLE_MARKUP_SELECTOR } from "./clickable.js";

/** 缺省那一份（`includeHidden: false`）。 */
const SCRIPT = buildProjectionScript();

/**
 * 投影脚本是**注入进页面的源码字符串**，不是本进程能跑的函数——vitest 环境是 `node`，
 * 没有 DOM（也不为此引 jsdom/happy-dom）。
 *
 * 所以这里只钉**在 node 里能真验的部分**，不把字符串断言冒充行为验证：
 * - 语法可解析（`new Function`）——这条抓的是**模板字面量转义**那一类只在运行时才爆的错
 *   （`\\s` 写成 `\s` 会变成回车，脚本在页面上直接 SyntaxError，本地全绿）。
 * - 契约不变量：零站点痕迹、无硬编码 URL、密码框值被 redact、信封两条分支都在。
 * - 装配不变量：选项真的注入了、共享判据真的内插了（漏一个，"看不见的漂移"就开始了）。
 *
 * **未覆盖（如实）**：真实 DOM 上的抽取行为——由端到端在真页面（`docs/testing/` 的夹具页）
 * 验证；`clickable.test.ts` 覆盖判据逻辑本身。
 */
describe("投影脚本：语法与模板字面量转义", () => {
  it("是一个可解析的 JS 表达式（转义写错时这条会红）", () => {
    // 脚本形态是 IIFE 表达式；用 return 包一层即按表达式解析，等价于 ExecuteScript 的解析路径。
    expect(() => new Function("return " + SCRIPT)).not.toThrow();
  });

  it("模板占位符已全部求值（残留 ${ 说明有未转义/漏插值）", () => {
    expect(SCRIPT).not.toContain("${");
  });

  it("上限常量已内插进去（不是字面量 LIMITS 名）", () => {
    expect(SCRIPT).toContain("var LIMITS = {");
    expect(SCRIPT).toContain('"nodes":1500');
    // 光标扫描的样式预算也是内插的（它是这次新增的最贵一步，别漏）。
    expect(SCRIPT).toContain('"styleProbes":2000');
  });
});

describe("投影脚本：装配不变量", () => {
  it("缺省 includeHidden=false（隐藏项默认不列）", () => {
    expect(SCRIPT).toContain("var INCLUDE_HIDDEN = false;");
  });

  it("includeHidden:true 真的注进脚本（原型那种一页叠多个隐藏状态的场景）", () => {
    expect(buildProjectionScript({ includeHidden: true })).toContain("var INCLUDE_HIDDEN = true;");
  });

  it("隐藏项计数四类都在（不静默丢：拒列什么就报什么）", () => {
    expect(SCRIPT).toContain("var skipped = { tables: 0, fields: 0, clickables: 0, headings: 0 };");
    expect(SCRIPT).toContain("out.hiddenSkipped = skipped;");
  });

  /**
   * 「可点击」判据只有一份：read 的索引与 act 的候选都内插 `clickable.ts`。
   * 这条红了说明有人又在投影脚本里手写了一套——那正是"索引里没有、按文本也点不到"的来源。
   */
  it("可点击判据是共享片段（选择器原样来自 clickable.ts）", () => {
    // 选择器经 JSON.stringify 内插，源码里是转义过的字符串字面量——按同一形态比对。
    expect(SCRIPT).toContain(JSON.stringify(CLICKABLE_MARKUP_SELECTOR));
    expect(SCRIPT).toContain("function clickableByStyle(el)");
    expect(SCRIPT).toContain("var cs = doc.querySelectorAll(CLICKABLE_MARKUP);");
    // 光标扫描：剪枝 + 预算，两边都在（少了任一，"点不到的 div 按钮"就回来了）。
    expect(SCRIPT).toContain("probes--");
    expect(SCRIPT).toContain("if (probes <= 0) truncated = true;");
  });
});

describe("投影脚本：契约不变量", () => {
  /**
   * 「通用 vs 补丁」的守卫。这条红了说明有人往通用层塞了站点 know-how——站点适配该住
   * skill 的 reference 文件（数据），不进这里。
   */
  it("零站点痕迹：无站点名、无硬编码 URL", () => {
    const lower = SCRIPT.toLowerCase();
    for (const hint of ["lanhu", "蓝湖", "axure", "zentao", "禅道", "figma", "confluence"]) {
      expect(lower, `投影脚本里出现了站点名词: ${hint}`).not.toContain(hint);
    }
    // 通用抽取器不需要任何具体 URL；出现一个就基本可以断定是站点适配漏进来了。
    expect(SCRIPT).not.toMatch(/https?:\/\//);
  });

  it("密码框的值被 redact（用户凭据不进模型上下文）", () => {
    expect(SCRIPT).toContain("type === 'password'");
    expect(SCRIPT).toContain("[redacted]");
  });

  it("返回对象而非 JSON.stringify（stringify 会双重编码）", () => {
    expect(SCRIPT).not.toContain("JSON.stringify");
    expect(SCRIPT).toContain("result.ok = true");
  });

  /**
   * 页面脚本抛异常时 ExecuteScript 回 null，与「确实返回 null」不可区分——
   * 所以脚本自己必须兜住异常并回 ok:false 信封。这条钉住那个 catch。
   */
  it("顶层 try/catch 产出 ok:false 信封（否则失败会伪装成空页面）", () => {
    expect(SCRIPT).toContain("result.ok = true");
    expect(SCRIPT).toContain("ok: false");
    expect(SCRIPT).toContain("page projection failed");
  });

  it("跨域 iframe 只报 src 并标 sameOrigin:false（不假装读到了）", () => {
    expect(SCRIPT).toContain("sameOrigin: false");
    expect(SCRIPT).toContain("contentDocument");
  });

  it("表格 / 表单 / 可点元素 / 大纲四类通用词汇都在（这是它作为通用抽取器的全部本事）", () => {
    expect(SCRIPT).toContain("h1,h2,h3,h4,h5,h6");
    expect(SCRIPT).toContain("input,select,textarea");
    expect(SCRIPT).toContain("tr");
  });

  /** 传统企业后台大量用 <td>标签</td><td><input></td>，label/for 缺失——这条兜底是通用的。 */
  it("标签关联含表格布局兜底（无 label/for 的后台仍能认出字段含义）", () => {
    expect(SCRIPT).toContain("label[for=");
    expect(SCRIPT).toContain("previousElementSibling");
  });
});

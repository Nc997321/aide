import { describe, it, expect } from "vitest";
import { PAGE_PROJECTION_SCRIPT } from "./projection.js";

/**
 * 投影脚本是**注入进页面的源码字符串**，不是本进程能跑的函数——vitest 环境是 `node`，
 * 没有 DOM（也不为此引 jsdom/happy-dom）。
 *
 * 所以这里只钉**在 node 里能真验的部分**，不把字符串断言冒充行为验证：
 * - 语法可解析（`new Function`）——这条抓的是**模板字面量转义**那一类只在运行时才爆的错
 *   （`\\s` 写成 `\s` 会变成回车，脚本在页面上直接 SyntaxError，本地全绿）。
 * - 契约不变量：零站点痕迹、无硬编码 URL、密码框值被 redact、信封两条分支都在。
 *
 * **未覆盖（如实）**：真实 DOM 上的抽取行为——由端到端在真页面（嵌入式浏览器里打开）验证。
 */
describe("投影脚本：语法与模板字面量转义", () => {
  it("是一个可解析的 JS 表达式（转义写错时这条会红）", () => {
    // 脚本形态是 IIFE 表达式；用 return 包一层即按表达式解析，等价于 ExecuteScript 的解析路径。
    expect(() => new Function("return " + PAGE_PROJECTION_SCRIPT)).not.toThrow();
  });

  it("模板占位符已全部求值（残留 ${ 说明有未转义/漏插值）", () => {
    expect(PAGE_PROJECTION_SCRIPT).not.toContain("${");
  });

  it("上限常量已内插进去（不是字面量 LIMITS 名）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("var LIMITS = {");
    expect(PAGE_PROJECTION_SCRIPT).toContain('"nodes":1500');
  });
});

describe("投影脚本：契约不变量", () => {
  /**
   * 「通用 vs 补丁」的守卫。这条红了说明有人往通用层塞了站点 know-how——
   * 站点适配该住 skill 的 reference 文件（数据），不进这里。
   */
  it("零站点痕迹：无站点名、无硬编码 URL", () => {
    const lower = PAGE_PROJECTION_SCRIPT.toLowerCase();
    for (const hint of ["lanhu", "蓝湖", "axure", "zentao", "禅道", "figma", "confluence"]) {
      expect(lower, `投影脚本里出现了站点名词: ${hint}`).not.toContain(hint);
    }
    // 通用抽取器不需要任何具体 URL；出现一个就基本可以断定是站点适配漏进来了。
    expect(PAGE_PROJECTION_SCRIPT).not.toMatch(/https?:\/\//);
  });

  it("密码框的值被 redact（用户凭据不进模型上下文）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("type === 'password'");
    expect(PAGE_PROJECTION_SCRIPT).toContain("[redacted]");
  });

  it("返回对象而非 JSON.stringify（stringify 会双重编码）", () => {
    expect(PAGE_PROJECTION_SCRIPT).not.toContain("JSON.stringify");
    expect(PAGE_PROJECTION_SCRIPT).toContain("result.ok = true");
  });

  /**
   * 页面脚本抛异常时 ExecuteScript 回 null，与「确实返回 null」不可区分——
   * 所以脚本自己必须兜住异常并回 ok:false 信封。这条钉住那个 catch。
   */
  it("顶层 try/catch 产出 ok:false 信封（否则失败会伪装成空页面）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("result.ok = true");
    expect(PAGE_PROJECTION_SCRIPT).toContain("ok: false");
    expect(PAGE_PROJECTION_SCRIPT).toContain("page projection failed");
  });

  it("跨域 iframe 只报 src 并标 sameOrigin:false（不假装读到了）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("sameOrigin: false");
    expect(PAGE_PROJECTION_SCRIPT).toContain("contentDocument");
  });

  it("表格 / 表单 / 可点元素 / 大纲四类通用词汇都在（这是它作为通用抽取器的全部本事）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("h1,h2,h3,h4,h5,h6");
    expect(PAGE_PROJECTION_SCRIPT).toContain("input,select,textarea");
    expect(PAGE_PROJECTION_SCRIPT).toContain('button,[role="button"]');
    expect(PAGE_PROJECTION_SCRIPT).toContain("tr");
  });

  /** 传统企业后台大量用 <td>标签</td><td><input></td>，label/for 缺失——这条兜底是通用的。 */
  it("标签关联含表格布局兜底（无 label/for 的后台仍能认出字段含义）", () => {
    expect(PAGE_PROJECTION_SCRIPT).toContain("label[for=");
    expect(PAGE_PROJECTION_SCRIPT).toContain("previousElementSibling");
  });
});

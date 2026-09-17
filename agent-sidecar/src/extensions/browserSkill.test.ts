import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureBrowserSkill,
  browserSkillPath,
  browserReferencePath,
  SKILL_CONTENT,
  PAGE_EXTRACTION_REFERENCE,
} from "./browserSkill.js";

describe("browserSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "browser-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地 SKILL.md（frontmatter 触发描述 + 强制工作流）", () => {
    ensureBrowserSkill(env);
    const file = browserSkillPath(env);
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, "utf8");
    expect(content).toContain("name: browser-inspect");
    // frontmatter 的触发词必须是**任务词**（原型/规格页/读页面），不是站点词——
    // 否则这个 skill 只会对某一个站点生效。
    expect(content).toContain("design prototype");
    expect(content).toContain("spec page");
    // 工作流硬约束
    expect(content).toContain("Call \`browser_tabs\`");
    expect(content).toContain("Call \`browser_read\` before anything else");
    expect(content).toContain("browser_act");
  });

  it("落地 references/page-extraction.md（通用抽取指南）", () => {
    ensureBrowserSkill(env);
    const ref = browserReferencePath(env, "page-extraction");
    expect(existsSync(ref)).toBe(true);
    const content = readFileSync(ref, "utf8");
    expect(content).toContain("Return a small object");
    expect(content).toContain("envelope");
    // 凭据不进上下文这条是硬纪律，必须写在模型读得到的地方
    expect(content).toContain("Never read \`type=password\`");
  });

  it("内容漂移自动重写，未漂移不动", () => {
    ensureBrowserSkill(env);
    const file = browserSkillPath(env);
    writeFileSync(file, "stale content", "utf8");
    ensureBrowserSkill(env);
    expect(readFileSync(file, "utf8")).toBe(SKILL_CONTENT);
  });

  it("配置目录不可写时静默跳过（不阻塞会话启动）", () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(() =>
      ensureBrowserSkill({ CLAUDE_CONFIG_DIR: path.join(blocker, "sub") }),
    ).not.toThrow();
  });

  /**
   * 落地内容里**不许出现站点名词**——站点适配是用户/agent 事后往 references/ 写的**数据**，
   * 不是我们预置的猜测。没见过真实 DOM 就写选择器 = 编造，比没有更糟。
   */
  it("预置内容零站点痕迹（站点适配只能作为 reference 数据后加）", () => {
    const all = (SKILL_CONTENT + PAGE_EXTRACTION_REFERENCE).toLowerCase();
    for (const hint of ["lanhu", "蓝湖", "axure", "figma", "sketch", "zeplin", "禅道", "zentao"]) {
      expect(all, `预置内容里出现了站点名词: ${hint}`).not.toContain(hint);
    }
  });

  /** reference 目录是**扩展点**：加站点 = 加文件。这条把约定写进测试，防它被悄悄删掉。 */
  it("SKILL.md 里写明站点适配住 references/（换站点不改代码的落点）", () => {
    expect(SKILL_CONTENT).toContain("Site adapters live in \`references/\`");
    expect(SKILL_CONTENT).toContain("adding a site means adding data, not code");
  });
});

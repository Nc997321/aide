import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureDesignSkill, designSkillPath, DESIGN_SKILL_CONTENT } from "./designSkill.js";
import { APP_SKILL_CONTENT } from "./appSkill.js";

describe("designSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "design-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地 SKILL.md（frontmatter 触发描述覆盖三类产出）", () => {
    ensureDesignSkill(env);
    const file = designSkillPath(env);
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, "utf8");
    expect(content.startsWith("---\nname: aide-design\n")).toBe(true);
    const description = content.split("\n")[2];
    expect(description).toContain("sidebar app");
    expect(description).toContain("slide deck");
    expect(description).toContain("standalone HTML page");
  });

  it("描述行保持短：它进每个会话的上下文，正文才是按需加载", () => {
    const description = DESIGN_SKILL_CONTENT.split("\n")[2];
    expect(description.startsWith("description: ")).toBe(true);
    expect(description.length).toBeLessThan(300);
  });

  it("硬约束都写在模型读得到的地方", () => {
    // 用户的话 > 已有设计 > 自己的选择
    expect(DESIGN_SKILL_CONTENT).toContain("用户的原话 > 已有的设计 > 你自己的选择");
    // 侧栏应用只用 Aide 主题变量；不引外网字体
    expect(DESIGN_SKILL_CONTENT).toContain("var(--aide-bg-base)");
    expect(DESIGN_SKILL_CONTENT).toContain("不要引外网字体");
    // 先定变量方案；独立页面明暗两套
    expect(DESIGN_SKILL_CONTENT).toContain(":root");
    expect(DESIGN_SKILL_CONTENT).toContain("prefers-color-scheme: dark");
    // 交付前看一遍，不陷入反复微调
    expect(DESIGN_SKILL_CONTENT).toContain("不要反复截图微调");
  });

  it("提到的 Aide 主题变量都是 aide-app 技能里承诺给应用的那几个", () => {
    const vars = new Set(DESIGN_SKILL_CONTENT.match(/--aide-[a-z-]+/g));
    expect(vars.size).toBeGreaterThan(0);
    for (const v of vars) expect(APP_SKILL_CONTENT, v).toContain(v);
  });

  it("aide-app 技能把界面观感指到这里", () => {
    expect(APP_SKILL_CONTENT).toContain("aide-design");
  });

  it("内容漂移自动重写；配置目录不可写时静默跳过", () => {
    ensureDesignSkill(env);
    const file = designSkillPath(env);
    writeFileSync(file, "stale content", "utf8");
    ensureDesignSkill(env);
    expect(readFileSync(file, "utf8")).toBe(DESIGN_SKILL_CONTENT);

    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(() => ensureDesignSkill({ CLAUDE_CONFIG_DIR: path.join(blocker, "sub") })).not.toThrow();
  });
});

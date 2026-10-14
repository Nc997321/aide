import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureWebAcceptanceSkill,
  webAcceptanceSkillPath,
  WEB_ACCEPTANCE_SKILL_CONTENT,
} from "./webAcceptanceSkill.js";

describe("webAcceptanceSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "web-acceptance-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地 SKILL.md", () => {
    ensureWebAcceptanceSkill(env);
    const file = webAcceptanceSkillPath(env);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").startsWith("---\nname: web-acceptance\n")).toBe(true);
  });

  const description = WEB_ACCEPTANCE_SKILL_CONTENT.split("\n")[2]!;

  it("描述行保持短：它进每个会话的上下文，正文才是按需加载", () => {
    expect(description.startsWith("description: ")).toBe(true);
    expect(description.length).toBeLessThan(300);
  });

  it("触发边界：只管开发后的验收，明确排除探查式走查（用户的硬要求）", () => {
    expect(description).toContain("ONLY");
    expect(description).toContain("after building or changing");
    expect(description).toContain("Not for exploratory checks");
    // 正文开头再判一次，拿不准就问
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("那是探查");
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("要完整验收走查，还是只看这一处？");
  });

  it("三条测试纪律都写在模型读得到的地方", () => {
    // 先列清单再动手
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("先把清单简短列给用户，再开始执行");
    // 三方对账 + 筛选的通过标准
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("返回的每一行都满足条件");
    // 写后回读
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("「保存成功」的提示不是证据");
    // 未测必须交代
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("一条都不能悄悄消失");
  });

  it("写数据的边界：像生产就先问、只动自己造的、收尾清理", () => {
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("先问，不写");
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("只动自己造的数据");
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("收尾时删掉自己造的数据");
  });

  it("工具说明不在这里重复，指向 browser-inspect；正文不出现站点名词", () => {
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).toContain("browser-inspect");
    expect(WEB_ACCEPTANCE_SKILL_CONTENT).not.toMatch(/https?:\/\//);
  });
});

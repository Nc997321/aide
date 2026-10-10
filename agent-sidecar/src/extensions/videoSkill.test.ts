import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureVideoSkill, videoSkillPath, VIDEO_SKILL_CONTENT } from "./videoSkill.js";

describe("videoSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "video-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地 SKILL.md（frontmatter 触发描述是任务词）", () => {
    ensureVideoSkill(env);
    const file = videoSkillPath(env);
    expect(existsSync(file)).toBe(true);

    const content = readFileSync(file, "utf8");
    expect(content.startsWith("---\nname: aide-video\n")).toBe(true);
    expect(content).toContain("make, produce or edit a video");
  });

  it("硬纪律都写在模型读得到的地方", () => {
    // 环境不满足就停，不绕过
    expect(VIDEO_SKILL_CONTENT).toContain("node -v");
    expect(VIDEO_SKILL_CONTENT).toContain("不要想办法绕过");
    // 能力边界与授权如实说
    expect(VIDEO_SKILL_CONTENT).toContain("不能凭一句话生成实拍画面");
    expect(VIDEO_SKILL_CONTENT).toContain("商用要买授权");
    // 动画由帧号推导；没截帧看过不许说做好了
    expect(VIDEO_SKILL_CONTENT).toContain("useCurrentFrame()");
    expect(VIDEO_SKILL_CONTENT).toContain("npx remotion still Main");
    expect(VIDEO_SKILL_CONTENT).toContain("没截帧看过就不要说「做好了」");
    // 工程落在工作区，不进用户家目录
    expect(VIDEO_SKILL_CONTENT).toContain("放在**当前工作区**下");
  });

  it("内容漂移自动重写，未漂移不动", () => {
    ensureVideoSkill(env);
    const file = videoSkillPath(env);
    writeFileSync(file, "stale content", "utf8");
    ensureVideoSkill(env);
    expect(readFileSync(file, "utf8")).toBe(VIDEO_SKILL_CONTENT);
  });

  it("配置目录不可写时静默跳过（不阻塞会话启动）", () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(() => ensureVideoSkill({ CLAUDE_CONFIG_DIR: path.join(blocker, "sub") })).not.toThrow();
  });
});

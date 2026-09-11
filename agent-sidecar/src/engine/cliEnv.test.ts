import { describe, it, expect } from "vitest";
import { buildCliEnv } from "./cliEnv.js";

describe("buildCliEnv", () => {
  it("per-session envOverrides 覆盖进程 env；空值不覆盖", () => {
    const env = buildCliEnv({
      processEnv: { ANTHROPIC_BASE_URL: "https://global", PATH: "/bin" } as NodeJS.ProcessEnv,
      envOverrides: { ANTHROPIC_BASE_URL: "https://session", ANTHROPIC_API_KEY: "" },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://session");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // 空串不写入
    expect(env.PATH).toBe("/bin");
  });

  it("CLAUDE_CODE_EFFORT_LEVEL 恒被删除（进程 env 与 overrides 两路都堵死）", () => {
    const env = buildCliEnv({
      processEnv: { CLAUDE_CODE_EFFORT_LEVEL: "high" } as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" },
    });
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it("automation 会话目录优先：CLAUDE_CONFIG_DIR 指向隔离配置根", () => {
    const env = buildCliEnv({
      processEnv: { CLAUDE_CONFIG_DIR: "/global" } as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CONFIG_DIR: "/from-override" },
      automationSessionDir: "/scoped/session-1",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/scoped/session-1");
    // 未下发 sessionDir（空串/undefined）时跟随覆盖链
    const env2 = buildCliEnv({
      processEnv: {} as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CONFIG_DIR: "/from-override" },
      automationSessionDir: "",
    });
    expect(env2.CLAUDE_CONFIG_DIR).toBe("/from-override");
  });

  it("固定注入：TODO_TOOLS=1；SUBAGENT_MODEL 键恒在", () => {
    const env = buildCliEnv({ processEnv: {} as NodeJS.ProcessEnv, envOverrides: {} });
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
    expect("CLAUDE_CODE_SUBAGENT_MODEL" in env).toBe(true);
  });
});

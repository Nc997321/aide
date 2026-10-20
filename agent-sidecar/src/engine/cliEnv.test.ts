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
      configDirOverride: "/scoped/session-1",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/scoped/session-1");
    // 未下发 sessionDir（空串/undefined）时跟随覆盖链
    const env2 = buildCliEnv({
      processEnv: {} as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CONFIG_DIR: "/from-override" },
      configDirOverride: "",
    });
    expect(env2.CLAUDE_CONFIG_DIR).toBe("/from-override");
  });

  it("AIDE_KB_CONFIG_FILE 不进 CLI 子进程（Bash 工具继承 env 即得凭据路径）", () => {
    const env = buildCliEnv({
      processEnv: { AIDE_KB_CONFIG_FILE: "/x/knowledge.json", PATH: "/bin" } as NodeJS.ProcessEnv,
      envOverrides: {},
    });
    expect(env.AIDE_KB_CONFIG_FILE).toBeUndefined();
    expect(env.PATH).toBe("/bin"); // 其余透传不受影响
    // 覆盖链最后一环也堵死：envOverrides 想塞也塞不进
    const env2 = buildCliEnv({
      processEnv: {} as NodeJS.ProcessEnv,
      envOverrides: { AIDE_KB_CONFIG_FILE: "/y/knowledge.json" },
    });
    expect(env2.AIDE_KB_CONFIG_FILE).toBeUndefined();
  });

  it("固定注入：TODO_TOOLS=1；SUBAGENT_MODEL 键恒在", () => {
    const env = buildCliEnv({ processEnv: {} as NodeJS.ProcessEnv, envOverrides: {} });
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
    expect("CLAUDE_CODE_SUBAGENT_MODEL" in env).toBe(true);
  });

  it("子代理模型按本会话的供应商配置折算，不看进程 env", () => {
    // 无法别名化的全 id → 硬钉死原值；来源必须是本条 send 的 env
    const env = buildCliEnv({
      processEnv: {} as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4.1-flash:cloud" },
    });
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4.1-flash:cloud");
    // 值等于本会话的 sonnet 映射 → 可别名化 → inherit（交给 hook 动态兜底）
    const aliased = buildCliEnv({
      processEnv: {} as NodeJS.ProcessEnv,
      envOverrides: {
        CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4.1-flash:cloud",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4.1-flash:cloud",
      },
    });
    expect(aliased.CLAUDE_CODE_SUBAGENT_MODEL).toBe("inherit");
  });

  it("EXTRA_BODY 恒不存在——进程 env 与 overrides 两路残值都堵死（思考恒开）", () => {
    // EXTRA_BODY 是**硬覆盖**：残值 `{"thinking":{"type":"disabled"}}` 会静默吃掉每个会话的思考。
    const env = buildCliEnv({
      processEnv: { CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' } as NodeJS.ProcessEnv,
      envOverrides: { CLAUDE_CODE_EXTRA_BODY: '{"top_k":1}' },
    });
    expect(env.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
  });
});

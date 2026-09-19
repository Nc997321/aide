import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DirEntry } from "@aide/sdk/utils/fileMentions";

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  findFilesByName: vi.fn(),
}));

vi.mock("@aide/sdk/api", () => ({
  api: {
    listDirectory: mocks.listDirectory,
    findFilesByName: mocks.findFilesByName,
  },
}));

import {
  useMentionSuggest,
  mentionTokenAt,
  splitQueryPath,
  localSuggestions,
  fuzzySuggestions,
  projectSuggestions,
  mergeSuggestions,
  applyPick,
  MAX_SUGGESTIONS,
  type ProjectSource,
} from "./useMentionSuggest";

const E = (name: string, is_dir = false): DirEntry => ({ name, is_dir });
const WS = "C:/repo";
const BS = String.fromCharCode(92); // 反斜杠：绕开各层转义

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("mentionTokenAt（光标锚定的 @token）", () => {
  it("整串就是一个 token：光标在末尾", () => {
    expect(mentionTokenAt("@src/components/", 16)).toEqual({ at: 0, query: "src/components/" });
  });

  it("光标停在 token 中间：只取到光标处", () => {
    expect(mentionTokenAt("@src/components/", 4)).toEqual({ at: 0, query: "src" });
  });

  it("句中 @（前面是空格）：at 指向 @ 本身", () => {
    expect(mentionTokenAt("看下 @src/ 有什么", 8)).toEqual({ at: 3, query: "src/" });
  });

  it("裸 @：query 为空串", () => {
    expect(mentionTokenAt("@", 1)).toEqual({ at: 0, query: "" });
  });

  it("反斜杠 token 同样识别（Windows 手打）", () => {
    expect(mentionTokenAt("@src" + BS + "comp", 9)).toEqual({ at: 0, query: "src" + BS + "comp" });
  });

  it("不误吞邮箱 a@b.com", () => {
    expect(mentionTokenAt("a@b.com", 7)).toBeNull();
  });

  it("光标已离开 token（token 后有空格）→ 关闭", () => {
    expect(mentionTokenAt("@src/ 有什么", 9)).toBeNull();
  });

  it("@@ 双 @ 不触发（前一个 @ 不构成边界）", () => {
    expect(mentionTokenAt("@@src", 5)).toBeNull();
  });
});

describe("splitQueryPath（按最后一个分隔符切开）", () => {
  it("无分隔符：全是叶子", () => {
    expect(splitQueryPath("foo")).toEqual({ dir: "", leaf: "foo" });
  });

  it("正斜杠", () => {
    expect(splitQueryPath("src/comp")).toEqual({ dir: "src/", leaf: "comp" });
  });

  it("反斜杠", () => {
    expect(splitQueryPath("src" + BS + "comp")).toEqual({ dir: "src" + BS, leaf: "comp" });
  });

  it("尾分隔符 = 换层（叶子为空）", () => {
    expect(splitQueryPath("src/components/")).toEqual({ dir: "src/components/", leaf: "" });
  });
});

describe("localSuggestions（同层候选项）", () => {
  it("按叶子前缀过滤，大小写不敏感", () => {
    const entries = [E("src", true), E("Static"), E("docs", true)];
    expect(names(localSuggestions(entries, { dir: "", leaf: "s" }))).toEqual(["src", "Static"]);
  });

  it("目录在前、同组按名升序（对齐 Rust list_directory）", () => {
    const entries = [E("zeta.ts"), E("Beta", true), E("alpha.ts"), E("Alpha", true)];
    expect(names(localSuggestions(entries, { dir: "", leaf: "" }))).toEqual([
      "Alpha",
      "Beta",
      "alpha.ts",
      "zeta.ts",
    ]);
  });

  it("目录前缀写回：根层 rel = name，子层 rel = dir/name", () => {
    const entries = [E("main.ts")];
    expect(localSuggestions(entries, { dir: "", leaf: "" })[0]).toMatchObject({ dir: "", rel: "main.ts" });
    expect(localSuggestions(entries, { dir: "src", leaf: "" })[0]).toMatchObject({
      dir: "src",
      rel: "src/main.ts",
    });
  });

  it("来源标 local", () => {
    expect(localSuggestions([E("a.ts")], { dir: "", leaf: "" })[0].origin).toBe("local");
  });

  it("行尾展示的 dir 剥尾分隔符（@src/ 的 dir 是 src/，留着会被 RTL 翻成前导斜杠）", () => {
    expect(localSuggestions([E("main.ts")], { dir: "src/", leaf: "" })[0].dir).toBe("src");
    expect(localSuggestions([E("main.ts")], { dir: "src", leaf: "" })[0].dir).toBe("src");
  });

  it("无命中 → 空数组", () => {
    expect(localSuggestions([E("a.ts")], { dir: "", leaf: "zzz" })).toEqual([]);
  });
});

describe("fuzzySuggestions（全仓兜底：绝对路径 → 展示/写回形态）", () => {
  it("工作区内的文件：dir 为工作区相对目录", () => {
    expect(fuzzySuggestions(["C:/repo/src/a/b/chat.rs"], WS)).toEqual([
      { name: "chat.rs", dir: "src/a/b", rel: "src/a/b/chat.rs", isDir: false, origin: "fuzzy" },
    ]);
  });

  it("工作区外/根不匹配的文件：dir 为绝对目录（不回退成相对）", () => {
    expect(fuzzySuggestions(["D:/other/x/chat.rs"], WS)[0]).toMatchObject({
      dir: "D:/other/x",
      rel: "D:/other/x/chat.rs",
    });
  });

  it("Windows 反斜杠根同样能相对化", () => {
    expect(fuzzySuggestions(["C:" + BS + "repo" + BS + "src" + BS + "chat.rs"], "C:" + BS + "repo")[0]).toMatchObject({
      dir: "src",
      rel: "src/chat.rs",
    });
  });
});

describe("projectSuggestions（其它已注册工作区）", () => {
  const P = (path: string, missing = false): ProjectSource => ({ name: path, missing });
  const SESSION = "C:" + BS + "work" + BS + "frontend";
  const ctx = (leaf: string) => ({ sessionWs: SESSION, leaf });
  const projects = [
    P("C:" + BS + "work"), // 祖先
    P(SESSION), // 自己
    P("C:" + BS + "work" + BS + "backend-api"),
    P("D:" + BS + "repo" + BS + "mobile-app"),
    P("C:" + BS + "work" + BS + "gateway", true), // 路径不在了
  ];

  it("剔掉自身工作区与它的祖先（「其它项目」＝不是我所在的地方）", () => {
    expect(names(projectSuggestions(projects, ctx("")))).toEqual(["backend-api", "mobile-app"]);
  });

  it("剔掉 missing（登记的路径已不在，列出来只会选了才发现）", () => {
    expect(names(projectSuggestions(projects, ctx("")))).not.toContain("gateway");
  });

  it("叶子为空 → 全列（这就是「看得见其它项目」的入口）", () => {
    expect(projectSuggestions(projects, ctx(""))).toHaveLength(2);
  });

  it("叶子按名**包含**匹配，不是前缀", () => {
    expect(names(projectSuggestions(projects, ctx("api")))).toEqual(["backend-api"]);
    expect(names(projectSuggestions(projects, ctx("BACK")))).toEqual(["backend-api"]);
  });

  it("name = 路径末段；dir = 父目录（同名项目靠它区分）", () => {
    const row = projectSuggestions(projects, ctx(""))[0];
    expect(row).toMatchObject({ name: "backend-api", dir: "C:" + BS + "work", isDir: true });
  });

  it("rel 是登记表的原样绝对路径（写回文本与授权都认它，不做归一）", () => {
    expect(projectSuggestions(projects, ctx(""))[0].rel).toBe("C:" + BS + "work" + BS + "backend-api");
  });

  it("来源标 project", () => {
    expect(projectSuggestions(projects, ctx(""))[0].origin).toBe("project");
  });

  it("盘符根：末段显示成 C:（不出现空白行）", () => {
    expect(names(projectSuggestions([P("C:/")], { sessionWs: "D:/x", leaf: "" }))).toEqual(["C:"]);
  });
});

describe("mergeSuggestions（三源排序 / 去重 / 上限）", () => {
  const proj = [{ name: "backend-api", dir: "C:/work", rel: "C:/work/backend-api", isDir: true, origin: "project" as const }];
  const local = [
    { name: "src", dir: "", rel: "src", isDir: true, origin: "local" as const },
    { name: "src-tauri", dir: "", rel: "src-tauri", isDir: true, origin: "local" as const },
  ];
  const fuzzy = [
    { name: "chat.rs", dir: "src-tauri/src/commands", rel: "src-tauri/src/commands/chat.rs", isDir: false, origin: "fuzzy" as const },
    { name: "instructions.ts", dir: "agent-sidecar/src/engine", rel: "agent-sidecar/src/engine/instructions.ts", isDir: false, origin: "fuzzy" as const },
  ];

  it("顺序：项目 → 本层（保序）→ 兜底（保序）", () => {
    expect(names(mergeSuggestions(proj, local, fuzzy))).toEqual([
      "backend-api", "src", "src-tauri", "chat.rs", "instructions.ts",
    ]);
  });

  it("同 rel 的兜底被前面两源吃掉（去重）", () => {
    const dup = [{ name: "src", dir: "", rel: "src", isDir: false, origin: "fuzzy" as const }];
    expect(mergeSuggestions(proj, local, dup).filter((r) => r.rel === "src")).toHaveLength(1);
  });

  it("同名不同路径：两条都留（去重按路径不按名字）", () => {
    const sameName = [{ name: "src", dir: "other", rel: "other/src", isDir: false, origin: "fuzzy" as const }];
    expect(names(mergeSuggestions(proj, local, sameName))).toEqual(["backend-api", "src", "src-tauri", "src"]);
  });

  it("项目占满上限时，本层与兜底被挤掉", () => {
    const manyProj = Array.from({ length: 12 }, (_, i) => ({
      name: `p${i}`, dir: "C:/work", rel: `C:/work/p${i}`, isDir: true, origin: "project" as const,
    }));
    const merged = mergeSuggestions(manyProj, local, fuzzy);
    expect(merged).toHaveLength(MAX_SUGGESTIONS);
    expect(merged.every((r) => r.origin === "project")).toBe(true);
  });

  it("封顶 MAX_SUGGESTIONS 条", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `f${i}.ts`, dir: "", rel: `f${i}.ts`, isDir: false, origin: "fuzzy" as const,
    }));
    expect(mergeSuggestions([], [], many)).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("applyPick（下钻 vs 引用）", () => {
  const tok = { at: 0, query: "src/" };
  const dir = { name: "components", dir: "src", rel: "src/components", isDir: true, origin: "local" as const };
  const file = { name: "main.ts", dir: "src", rel: "src/main.ts", isDir: false, origin: "local" as const };

  it("引用：写回 @rel + 尾空格，光标落在其后", () => {
    expect(applyPick("@src/", tok, file, "commit")).toEqual({ text: "@src/main.ts ", caret: 13 });
  });

  it("下钻：不带尾空格，光标落在新层末尾", () => {
    expect(applyPick("@src/", tok, dir, "drill")).toEqual({ text: "@src/components/", caret: 16 });
  });

  it("下钻后的文本能再次解析出下一层 token（可继续钻）", () => {
    const { text, caret } = applyPick("@src/", tok, dir, "drill");
    expect(mentionTokenAt(text, caret)).toEqual({ at: 0, query: "src/components/" });
  });

  it("引用后的文本正好能被 findMentionTokens 认领 → 交由 useInlineMention 转芯片", () => {
    const { text } = applyPick("@src/", tok, file, "commit");
    expect(/@([^\s@]+) /.exec(text)?.[1]).toBe("src/main.ts");
  });

  it("句中替换只动 token 本身，其余文本原样", () => {
    expect(applyPick("看下 @src/ 有什么", { at: 3, query: "src/" }, file, "commit")).toEqual({
      text: "看下 @src/main.ts  有什么",
      caret: 16,
    });
  });

  it("根层项：rel 就是 name（无多余分隔符）", () => {
    const rootFile = { name: "package.json", dir: "", rel: "package.json", isDir: false, origin: "local" as const };
    expect(applyPick("@", { at: 0, query: "" }, rootFile, "commit")).toEqual({
      text: "@package.json ",
      caret: 14,
    });
  });

  it("项目行：引用写回登记表里的绝对路径", () => {
    const proj = {
      name: "backend-api", dir: "C:" + BS + "work",
      rel: "C:" + BS + "work" + BS + "backend-api", isDir: true, origin: "project" as const,
    };
    expect(applyPick("@back", { at: 0, query: "back" }, proj, "commit")).toEqual({
      text: "@C:" + BS + "work" + BS + "backend-api ",
      caret: 21, // "@" + 19 字符路径 + 尾空格
    });
    expect(applyPick("@back", { at: 0, query: "back" }, proj, "drill").text)
      .toBe("@C:" + BS + "work" + BS + "backend-api/");
  });
});

describe("useMentionSuggest（取数 / 缓存 / 竞态 / 项目）", () => {
  /** 项目相关的用例把会话工作区放深一层，才谈得上"祖先" */
  const SESSION = "C:/work/frontend";
  const OTHER = [
    { name: "C:/work", missing: false }, // 祖先：不该出现（SESSION 在它里面）
    { name: SESSION, missing: false }, // 会话自己：不该出现
    { name: "C:/work/backend-api", missing: false }, // 兄弟：该出现
    { name: "D:/repo/mobile-app", missing: false },
  ];

  const setup = (ws = SESSION, projects: ProjectSource[] = OTHER) => {
    const s = useMentionSuggest({ workspacePath: () => ws, projects: () => projects, fuzzyDebounceMs: 0 });
    return s;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listDirectory.mockResolvedValue([E("src", true), E("docs", true), E("package.json")]);
    mocks.findFilesByName.mockResolvedValue([]);
  });

  it("裸 @：项目在最前，再本层（目录在前、按名升序）", async () => {
    const s = setup();
    await s.refresh("@", 1);

    expect(mocks.listDirectory).toHaveBeenCalledWith(SESSION, false, false);
    expect(s.items.value.map((r) => [r.name, r.origin])).toEqual([
      ["backend-api", "project"],
      ["mobile-app", "project"],
      ["docs", "local"],
      ["src", "local"],
      ["package.json", "local"],
    ]);
    expect(s.visible.value).toBe(true);
  });

  it("项目里不含当前会话工作区自己与它的祖先", async () => {
    const s = setup();
    await s.refresh("@", 1);

    const rels = s.items.value.filter((r) => r.origin === "project").map((r) => r.rel);
    expect(rels).toEqual(["C:/work/backend-api", "D:/repo/mobile-app"]);
  });

  it("敲了分隔符就不再列项目（已经在某个目录里了）", async () => {
    const s = setup();
    await s.refresh("@src/", 5);

    expect(s.items.value.every((r) => r.origin === "local")).toBe(true);
  });

  it("项目按名包含匹配（@api → backend-api）", async () => {
    const s = setup();
    await s.refresh("@api", 4);

    expect(names(s.items.value)).toEqual(["backend-api"]);
  });

  it("没给项目源（老调用点）→ 行为与从前一致", async () => {
    const s = useMentionSuggest({ workspacePath: () => WS, fuzzyDebounceMs: 0 });
    await s.refresh("@", 1);

    expect(s.items.value.every((r) => r.origin === "local")).toBe(true);
  });

  it("同层继续打字：不发第二次 IPC（缓存本地筛）", async () => {
    const s = setup();
    mocks.listDirectory.mockResolvedValue([E("components", true), E("composables", true)]);
    await s.refresh("@src/c", 6);
    await s.refresh("@src/co", 7);

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1);
    expect(names(s.items.value)).toEqual(["components", "composables"]);
  });

  it("换层才发新请求，且列的是拼接后（尾分隔符已剥）的绝对目录", async () => {
    const s = setup();
    await s.refresh("@src/", 5);
    await s.refresh("@src" + BS, 5); // 反斜杠写法同一层：缓存命中，不再发

    expect(mocks.listDirectory).toHaveBeenCalledTimes(1);
    expect(mocks.listDirectory).toHaveBeenCalledWith(`${SESSION}/src`, false, false);
  });

  it("叶子为空不跑模糊兜底（空查询本就无意义）", async () => {
    const s = setup();
    await s.refresh("@src/", 5);

    expect(mocks.findFilesByName).not.toHaveBeenCalled();
  });

  it("模糊兜底：只在无分隔符时跑，结果标 fuzzy 并带 rel", async () => {
    const s = setup();
    mocks.listDirectory.mockResolvedValue([E("src", true)]);
    mocks.findFilesByName.mockResolvedValue([`${SESSION}/src/a/chat.rs`]);
    await s.refresh("@s", 2);

    expect(mocks.findFilesByName).toHaveBeenCalledWith("s", SESSION, expect.any(Number));
    expect(s.items.value.map((r) => [r.name, r.origin])).toEqual([
      ["src", "local"],
      ["chat.rs", "fuzzy"],
    ]);
  });

  it("无工作区 + 相对 token：不弹、零 IPC", async () => {
    const s = setup("");
    await s.refresh("@src/", 5);

    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(s.visible.value).toBe(false);
  });

  it("无工作区 + 绝对路径 token：照列（绝对目录不需要工作区）", async () => {
    const s = setup("");
    await s.refresh("@D:/other/", 10);

    expect(mocks.listDirectory).toHaveBeenCalledWith("D:/other", false, false);
    expect(s.visible.value).toBe(true);
  });

  it("列目录失败：静默关菜单，不抛", async () => {
    const s = setup();
    mocks.listDirectory.mockRejectedValue(new Error("boom"));
    await expect(s.refresh("@src/", 5)).resolves.toBeUndefined();

    expect(s.visible.value).toBe(false);
    expect(s.items.value).toEqual([]);
  });

  it("模糊兜底失败：同层结果照常展示", async () => {
    const s = setup();
    mocks.listDirectory.mockResolvedValue([E("src", true)]);
    mocks.findFilesByName.mockRejectedValue(new Error("boom"));
    await s.refresh("@s", 2);

    expect(names(s.items.value)).toEqual(["src"]);
  });

  it("过期请求不覆盖新状态（慢的旧 IPC 回来时已换层）", async () => {
    const s = setup();
    let releaseSlow: ((v: DirEntry[]) => void) | undefined;
    mocks.listDirectory
      .mockImplementationOnce(() => new Promise<DirEntry[]>((res) => { releaseSlow = res; })) // 旧：src
      .mockResolvedValueOnce([E("chat.rs")]); // 新：src-tauri

    const stale = s.refresh("@src/", 5);
    await s.refresh("@src-tauri/", 11);
    releaseSlow?.([E("SHOULD_NOT_WIN")]);
    await stale;

    expect(names(s.items.value)).toEqual(["chat.rs"]);
  });

  it("无 token（光标已离开）：关菜单", async () => {
    const s = setup();
    await s.refresh("@src/ 有什么", 11);

    expect(s.visible.value).toBe(false);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it("hide()：清空候选与高亮", async () => {
    const s = setup();
    await s.refresh("@", 1);
    s.move(1);
    s.hide();

    expect(s.visible.value).toBe(false);
    expect(s.items.value).toEqual([]);
    expect(s.active.value).toBe(0);
  });

  it("move/current：高亮不越界，current 取到当前项", async () => {
    // 这条不挂项目源：纯本层便于数行（项目参与排序另有专测）
    const s = useMentionSuggest({ workspacePath: () => WS, fuzzyDebounceMs: 0 });
    mocks.listDirectory.mockResolvedValue([E("a", true), E("b.ts")]);
    await s.refresh("@", 1);

    expect(s.current()?.name).toBe("a");
    s.move(-1); // 已在首行：不动
    expect(s.active.value).toBe(0);
    s.move(1);
    expect(s.current()?.name).toBe("b.ts");
    s.move(1); // 已在末行：不动
    expect(s.active.value).toBe(1);
  });

  it("刷新时高亮回到首行（换层后不该停在上一次的序号）", async () => {
    const s = setup();
    mocks.listDirectory.mockResolvedValue([E("a", true), E("b", true), E("c", true)]);
    await s.refresh("@", 1);
    s.move(2);
    await s.refresh("@/", 2);

    expect(s.active.value).toBe(0);
  });
});

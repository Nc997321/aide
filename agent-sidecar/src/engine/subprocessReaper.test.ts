import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  _testResetReaper,
  _testTrackedSids,
  isClaudeImage,
  killProcessTree,
  probeFromPsComm,
  probeFromTasklistCsv,
  probeProcess,
  reapAllSync,
  reapSessionSubprocess,
  rekeySessionSubprocess,
  shouldKill,
  sweepStaleRegistryEntries,
  trackSessionSubprocess,
} from "./subprocessReaper.js";

/** 远超平台 pid 上限的值：两次探针之间不会被复用（测试用"肯定不存在"的靶子）。 */
const DEAD_PID = 4_000_000_000;

describe("subprocessReaper — 纯核心：镜像名与动手判据", () => {
  it("recognizes claude binaries, ignores everything else", () => {
    for (const image of ["claude", "claude.exe", "CLAUDE.EXE", "C:\\x\\claude.exe"]) {
      expect(isClaudeImage(image)).toBe(true);
    }
    for (const image of ["node.exe", "claudette.exe", "myclaude.exe", ""]) {
      expect(isClaudeImage(image)).toBe(false);
    }
  });

  it("kills only a live process that really is claude (pid 复用防线)", () => {
    expect(shouldKill({ kind: "claude", image: "claude.exe" })).toBe(true);
    expect(shouldKill({ kind: "gone" })).toBe(false);
    expect(shouldKill({ kind: "other", image: "node.exe" })).toBe(false);
  });
});

describe("subprocessReaper — 纯核心：探针输出解析", () => {
  it("parses tasklist CSV rows", () => {
    expect(probeFromTasklistCsv('"claude.exe","44936","Console","1","145,000 K"')).toEqual({
      kind: "claude",
      image: "claude.exe",
    });
    expect(probeFromTasklistCsv('"node.exe","1234","Console","1","50,000 K"')).toEqual({
      kind: "other",
      image: "node.exe",
    });
  });

  it("treats tasklist's localized 'no match' text and empty output as gone", () => {
    expect(probeFromTasklistCsv("信息: 没有运行的任务匹配指定标准。").kind).toBe("gone");
    expect(probeFromTasklistCsv("INFO: No tasks are running which match the specified criteria.").kind).toBe("gone");
    expect(probeFromTasklistCsv("").kind).toBe("gone");
  });

  it("parses ps comm output, empty means gone", () => {
    expect(probeFromPsComm("claude\n").kind).toBe("claude");
    expect(probeFromPsComm("   node\n").kind).toBe("other");
    expect(probeFromPsComm("").kind).toBe("gone");
    expect(probeFromPsComm("\n").kind).toBe("gone");
  });
});

describe("subprocessReaper — 外壳：探针实测", () => {
  it("reports a nonexistent pid as gone", () => {
    expect(probeProcess(DEAD_PID).kind).toBe("gone");
  });

  it("reports our own (non-claude) process as other, not claude", () => {
    // 本测试进程是 node：探针必须识别成 other——这是"不误杀"的最后一道闸
    expect(probeProcess(process.pid).kind).toBe("other");
  });
});

describe("subprocessReaper — 登记表与强杀", () => {
  let dir: string;
  const SID = "sid-reap";

  beforeEach(() => {
    _testResetReaper();
    dir = mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  });

  afterEach(() => {
    _testResetReaper();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeEntry = (pid: number, sessionId: string, procStart?: string): string => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const file = path.join(dir, "sessions", `${pid}.json`);
    writeFileSync(file, JSON.stringify({ pid, sessionId, procStart }), "utf8");
    return file;
  };

  it("re-key follows session_init (tempId → realId)", () => {
    trackSessionSubprocess("temp-1", dir);
    rekeySessionSubprocess("temp-1", SID);
    expect(_testTrackedSids()).toEqual([SID]); // 旧键不留痕：拿它反查会落空
  });

  it("does nothing when the session has no registry entry (已优雅退出自清条目)", () => {
    trackSessionSubprocess(SID, dir);
    expect(() => reapSessionSubprocess(SID, 0)).not.toThrow();
  });

  it("never kills a pid that is not claude (条目残留在，但 pid 已被复用)", () => {
    // 靶子用本进程自己的 pid：条目声称它是 claude，探针会揭穿 → 绝不动手
    const file = writeEntry(process.pid, SID);
    trackSessionSubprocess(SID, dir);
    reapAllSync();
    expect(existsSync(file)).toBe(true); // 没杀 → 条目保留，交给启动清扫
  });

  it("reapAllSync survives an unresolvable configDir", () => {
    trackSessionSubprocess(SID, undefined);
    expect(reapAllSync()).toBe(0);
  });

  it("reapAllSync without tracked sessions is a no-op", () => {
    expect(reapAllSync()).toBe(0);
  });
});

describe("subprocessReaper — 外壳：杀树实测（孙子进程一起走）", () => {
  /** 起一棵真进程树：父进程再 spawn 一个长睡的孙子，模拟 claude.exe → rust-analyzer。
   *  孙子 pid 经 stdout 回传（父进程自己打印）。 */
  async function spawnTree(): Promise<{ parentPid: number; childPid: number }> {
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });',
      "console.log(c.pid);",
      "setTimeout(()=>{}, 60000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", parentScript], { stdio: ["ignore", "pipe", "ignore"] });
    const childPid = await new Promise<number>((resolve, reject) => {
      parent.stdout?.once("data", (buf: Buffer) => resolve(Number(buf.toString().trim())));
      parent.once("error", reject);
      setTimeout(() => reject(new Error("父进程没吐出孙子 pid")), 10_000);
    });
    return { parentPid: parent.pid!, childPid };
  }

  /** 轮询到进程消失（强杀是异步生效的）。 */
  async function waitGone(pid: number): Promise<boolean> {
    for (let i = 0; i < 50; i += 1) {
      if (probeProcess(pid).kind === "gone") return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  it("killProcessTree 连孙子一起杀（Windows 不连带杀子进程，全靠 /T）", async () => {
    const { parentPid, childPid } = await spawnTree();
    try {
      expect(probeProcess(childPid).kind).not.toBe("gone"); // 孙子确实活着
      killProcessTree(parentPid);
      expect(await waitGone(parentPid)).toBe(true);
      expect(await waitGone(childPid)).toBe(true); // ← 这条是承诺本身
    } finally {
      killProcessTree(parentPid); // 兜底：断言失败也别留孤儿
      killProcessTree(childPid);
    }
  }, 20_000);
});

describe("subprocessReaper — 启动清扫（残条目）", () => {
  let dir: string;

  beforeEach(() => {
    _testResetReaper();
    dir = mkdtempSync(path.join(os.tmpdir(), "reaper-sweep-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeEntry = (pid: number, sessionId: string): string => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const file = path.join(dir, "sessions", `${pid}.json`);
    writeFileSync(file, JSON.stringify({ pid, sessionId }), "utf8");
    return file;
  };

  it("deletes entries whose pid is gone (被强杀的 claude.exe 留下指纹)", () => {
    const stale = writeEntry(DEAD_PID, "sid-stale");
    expect(sweepStaleRegistryEntries(dir)).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps entries whose pid is alive — 可能是另一个实例的会话", () => {
    const live = writeEntry(process.pid, "sid-other-instance");
    expect(sweepStaleRegistryEntries(dir)).toBe(0);
    expect(existsSync(live)).toBe(true);
  });

  it("is a no-op without a config dir", () => {
    expect(sweepStaleRegistryEntries(undefined)).toBe(0);
  });
});

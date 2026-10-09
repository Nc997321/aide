import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, needsUpgrade, MIN_SERVER_VERSION, upgradeCommand } from "./serverVersion";

describe("compareVersions", () => {
  it("按数字段比，不是按字符串比（0.10 比 0.9 新）", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("缺位当 0", () => {
    expect(compareVersions("0.5", "0.5.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBe(-1);
  });

  it("认不出的段当 0，不抛", () => {
    expect(compareVersions("dev", "0.5.0")).toBe(-1);
    expect(compareVersions("", "0.5.0")).toBe(-1);
  });
});

describe("needsUpgrade", () => {
  // 这一条是**核心**：0.5.0 之前的服务端根本没有 version 字段，
  // 「没有字段」必须判成"该升级"，否则最需要提示的那一档反而不提示。
  it("服务端没报版本 = 旧", () => {
    expect(needsUpgrade(undefined)).toBe(true);
    expect(needsUpgrade(null)).toBe(true);
    expect(needsUpgrade("")).toBe(true);
  });

  it("开发构建（dev）不催", () => {
    expect(needsUpgrade("dev")).toBe(false);
  });

  it("低于最低要求要催，够用不催", () => {
    expect(needsUpgrade("0.4.0")).toBe(true);
    expect(needsUpgrade(MIN_SERVER_VERSION)).toBe(false);
    expect(needsUpgrade("0.5.1")).toBe(false);
    expect(needsUpgrade("1.0.0")).toBe(false);
  });

  it("认不出的号不拿它吓用户", () => {
    expect(needsUpgrade("nightly-2026")).toBe(false);
  });
});

describe("upgradeCommand", () => {
  const IMG = "r.example/ns/aide-knowledge";

  /** 在临时部署目录里真跑这条命令（docker 换成记账的桩），返回跑完后的 .env 与 docker 调用。 */
  function runIn(env: string | null): { env: string; docker: string } {
    const dir = mkdtempSync(join(tmpdir(), "kb-upgrade-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), '#!/bin/sh\necho "$@" >> "$DOCKER_LOG"\n');
    chmodSync(join(bin, "docker"), 0o755);
    if (env !== null) writeFileSync(join(dir, ".env"), env);
    const log = join(dir, "docker.log");
    execFileSync("bash", ["-c", upgradeCommand(IMG, "0.6.0")], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log },
    });
    return { env: readFileSync(join(dir, ".env"), "utf8"), docker: existsSync(log) ? readFileSync(log, "utf8") : "" };
  }

  const kbImages = (env: string) => env.split("\n").filter((l) => l.startsWith("KB_IMAGE="));

  // 回归：旧部署的 .env 钉着旧版本号时，「固定命令」只会把旧版本重拉一遍（2026-10-09）
  it.skipIf(process.platform === "win32")(".env 里钉着旧版本：替换成目标版本，其余配置原样保留", () => {
    const r = runIn("DB_PASSWORD=secret\nKB_IMAGE=r.example/ns/aide-knowledge:0.4.0\nKB_ALLOWED_CIDR=10.0.0.0/8\n");
    expect(kbImages(r.env)).toEqual([`KB_IMAGE=${IMG}:0.6.0`]);
    expect(r.env).toContain("DB_PASSWORD=secret");
    expect(r.env).toContain("KB_ALLOWED_CIDR=10.0.0.0/8");
    expect(r.docker).toBe("compose pull knowledge\ncompose up -d knowledge\n");
  });

  it.skipIf(process.platform === "win32")(".env 末尾没换行：新行不会粘到最后一行上", () => {
    const r = runIn("DB_PASSWORD=secret");
    expect(r.env).toContain("DB_PASSWORD=secret\n");
    expect(kbImages(r.env)).toEqual([`KB_IMAGE=${IMG}:0.6.0`]);
  });

  it.skipIf(process.platform === "win32")(".env 原有权限保留（里面有数据库口令），不留临时文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-upgrade-"));
    writeFileSync(join(dir, ".env"), "DB_PASSWORD=secret\n");
    chmodSync(join(dir, ".env"), 0o600);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), "#!/bin/sh\n");
    chmodSync(join(bin, "docker"), 0o755);
    execFileSync("bash", ["-c", upgradeCommand(IMG, "0.6.0")], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, ".env.kbnew"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("没有 .env（旧 compose 默认值钉版本的部署）：新建并写入目标版本", () => {
    const r = runIn(null);
    expect(kbImages(r.env)).toEqual([`KB_IMAGE=${IMG}:0.6.0`]);
  });

  it("只重建知识库服务，不碰数据卷", () => {
    const c = upgradeCommand(IMG, "stable");
    expect(c).toContain(`${IMG}:stable`);
    // 删卷的两种写法：down -v / --volumes。（grep -v 是另一回事，不算）
    expect(c).not.toMatch(/\bdown\b|--volumes|compose[^&]*\s-v\b/);
  });
});

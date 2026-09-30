import { describe, it, expect } from "vitest";
import { compareVersions, needsUpgrade, MIN_SERVER_VERSION, UPGRADE_COMMAND } from "./serverVersion";

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

describe("UPGRADE_COMMAND", () => {
  // 这条命令**不随版本变**（compose 跟的是移动标签 :stable）——
  // 一旦里面出现了具体版本号，说明有人把它钉死了，用户就得每次学新命令。
  it("里面不出现具体版本号", () => {
    expect(UPGRADE_COMMAND).not.toMatch(/\d+\.\d+\.\d+/);
    expect(UPGRADE_COMMAND).toContain("docker compose pull knowledge");
  });
});

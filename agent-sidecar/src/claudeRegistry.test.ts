import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  registryEntrySessionId,
  removeSessionRegistryEntry,
  removeSessionRegistryEntryFromEnv,
} from "./claudeRegistry.js";

describe("claudeRegistry — registryEntrySessionId（纯核心）", () => {
  it("extracts sessionId from a registry entry", () => {
    const raw = JSON.stringify({
      pid: 68736,
      sessionId: "2c3271cc-0589-404f-b26e-80946ad48b6a",
      cwd: "C:\\proj",
      name: "cypress-agent-c6",
      nameSource: "derived",
    });
    expect(registryEntrySessionId(raw)).toBe("2c3271cc-0589-404f-b26e-80946ad48b6a");
  });

  it("returns null for broken JSON", () => {
    expect(registryEntrySessionId("{ not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    // 外部进程写的文件不可信：字符串/数字等非对象形态也是非法态
    expect(registryEntrySessionId('"just a string"')).toBeNull();
    expect(registryEntrySessionId("123")).toBeNull();
  });

  it("returns null when sessionId is missing / non-string / empty", () => {
    expect(registryEntrySessionId('{"pid":1}')).toBeNull();
    expect(registryEntrySessionId('{"sessionId":123}')).toBeNull();
    expect(registryEntrySessionId('{"sessionId":""}')).toBeNull();
  });
});

describe("claudeRegistry — removeSessionRegistryEntry（临时目录实测 IO）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "claude-reg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeEntry = (name: string, sessionId: string | null): void => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const raw =
      sessionId === null
        ? "{ broken"
        : JSON.stringify({ pid: 1, sessionId });
    writeFileSync(path.join(dir, "sessions", name), raw, "utf8");
  };

  it("removes the matching entry, keeps others", () => {
    writeEntry("111.json", "sid-target");
    writeEntry("222.json", "sid-other");
    removeSessionRegistryEntry(dir, "sid-target");
    expect(existsSync(path.join(dir, "sessions", "111.json"))).toBe(false);
    expect(existsSync(path.join(dir, "sessions", "222.json"))).toBe(true);
  });

  it("skips broken-JSON entries without throwing", () => {
    writeEntry("bad.json", null);
    expect(() => removeSessionRegistryEntry(dir, "sid-x")).not.toThrow();
    expect(existsSync(path.join(dir, "sessions", "bad.json"))).toBe(true);
  });

  it("leaves .key files and non-file entries untouched", () => {
    writeEntry("111.json", "sid-target");
    writeFileSync(path.join(dir, "sessions", "111.deadbeef.key"), "key-bytes", "utf8");
    removeSessionRegistryEntry(dir, "sid-target");
    // 条目删了，同 pid 的 peer 密钥不动（不归本模块管）
    expect(existsSync(path.join(dir, "sessions", "111.deadbeef.key"))).toBe(true);
  });

  it("skips unreadable entries (dir named *.json) and still removes the rest", () => {
    // 名字像条目的子目录：readFileSync EISDIR → 单条目 catch 跳过，不阻断扫描
    writeEntry("111.json", "sid-target");
    mkdirSync(path.join(dir, "sessions", "trap.json"));
    expect(() => removeSessionRegistryEntry(dir, "sid-target")).not.toThrow();
    expect(existsSync(path.join(dir, "sessions", "111.json"))).toBe(false);
    expect(existsSync(path.join(dir, "sessions", "trap.json"))).toBe(true);
  });

  it("is a silent no-op when sessions dir is missing", () => {
    expect(() => removeSessionRegistryEntry(dir, "sid-x")).not.toThrow();
  });
});

describe("claudeRegistry — removeSessionRegistryEntryFromEnv（env 门）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "claude-reg-env-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delegates removal when CLAUDE_CONFIG_DIR is set", () => {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const entry = path.join(dir, "sessions", "42.json");
    writeFileSync(entry, JSON.stringify({ pid: 42, sessionId: "sid-env" }), "utf8");
    removeSessionRegistryEntryFromEnv({ CLAUDE_CONFIG_DIR: dir }, "sid-env");
    expect(existsSync(entry)).toBe(false);
  });

  it("is a no-op without CLAUDE_CONFIG_DIR (异常部署形态防御)", () => {
    expect(() => removeSessionRegistryEntryFromEnv({}, "sid-x")).not.toThrow();
  });
});
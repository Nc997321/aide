import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKbConfig, readKbConfig, KB_CONFIG_FILE_ENV } from "./config.js";

describe("parseKbConfig", () => {
  it("正常形状 → 配置，尾斜杠被剥掉", () => {
    const cfg = parseKbConfig('{"version":1,"baseUrl":"http://kb:8788/","token":"t"}');
    expect(cfg).toEqual({ baseUrl: "http://kb:8788", token: "t" });
  });

  it("JSON 坏 → null（不抛）", () => {
    expect(parseKbConfig("{ not json")).toBeNull();
  });

  it("version 不认识 → null（fail-closed，给将来演进留门）", () => {
    expect(parseKbConfig('{"version":2,"baseUrl":"http://kb","token":"t"}')).toBeNull();
  });

  it("baseUrl 缺失或空 → null", () => {
    expect(parseKbConfig('{"version":1,"token":"t"}')).toBeNull();
    expect(parseKbConfig('{"version":1,"baseUrl":"","token":"t"}')).toBeNull();
  });

  it("token 缺失或空 → null", () => {
    expect(parseKbConfig('{"version":1,"baseUrl":"http://kb"}')).toBeNull();
    expect(parseKbConfig('{"version":1,"baseUrl":"http://kb","token":""}')).toBeNull();
  });

  it("非对象（数组/字符串/null）→ null", () => {
    expect(parseKbConfig("[]")).toBeNull();
    expect(parseKbConfig("null")).toBeNull();
    expect(parseKbConfig('"x"')).toBeNull();
  });
});

describe("readKbConfig", () => {
  it("env 没给路径 → null（不是错误：说明这台机器没登录过知识库）", () => {
    expect(readKbConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("路径指向不存在的文件 → null", () => {
    const env = { [KB_CONFIG_FILE_ENV]: join(tmpdir(), "kb-nope-does-not-exist.json") } as NodeJS.ProcessEnv;
    expect(readKbConfig(env)).toBeNull();
  });

  it("正常文件 → 配置", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-cfg-"));
    const file = join(dir, "knowledge.json");
    writeFileSync(file, '{"version":1,"baseUrl":"http://kb:8788","token":"t"}');
    try {
      expect(readKbConfig({ [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv)).toEqual({
        baseUrl: "http://kb:8788",
        token: "t",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

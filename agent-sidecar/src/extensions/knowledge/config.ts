// 知识库运行时凭据：桌面前端 → Rust 写 `~/.aide/knowledge.json` → 这里**每次工具调用现读**。
//
// 为什么现读而不是会话级下发：MCP server 的闭包值随 query() spawn 冻结
// （session-worker.ts 的 startLoop → queryContext.ts），会话中途重新登录知识库后
// 旧值会一直用到开新会话——现读让重登自愈（设计 spec §3）。
// 为什么凭据在文件里而不是 env：env 会被 Bash 工具子进程继承，模型跑 `env` 即可
// 外带（engine/sessionMetadata.ts 红线）。env 里只有**路径**。
import { readFileSync } from "node:fs";

export interface KbRuntimeConfig {
  baseUrl: string;
  token: string;
}

/** 凭据文件路径的 env 键：由 Rust spawn sidecar 时注入（只有路径，没有凭据）。 */
export const KB_CONFIG_FILE_ENV = "AIDE_KB_CONFIG_FILE";

const SUPPORTED_VERSION = 1;

/**
 * 纯函数：凭据 JSON 文本 → 配置或 null。fail-closed：任何一处不对都当「未配置」，
 * 由调用方给出「请先登录」的引导文本。永不抛。
 */
export function parseKbConfig(raw: string): KbRuntimeConfig | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null; // 坏 JSON = 未配置，不向上抛（工具层红线是失败也返回文本）
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.version !== SUPPORTED_VERSION) return null;
  if (typeof o.baseUrl !== "string" || o.baseUrl.length === 0) return null;
  if (typeof o.token !== "string" || o.token.length === 0) return null;
  return { baseUrl: o.baseUrl.replace(/\/+$/, ""), token: o.token };
}

/** 读凭据文件。env 没给路径 / 文件不存在 / 内容坏 → null（= 这台机器没登录过）。 */
export function readKbConfig(env: NodeJS.ProcessEnv = process.env): KbRuntimeConfig | null {
  const path = env[KB_CONFIG_FILE_ENV];
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // 文件不存在 = 从未登录；权限问题同样降级成「未配置」
  }
  return parseKbConfig(raw);
}

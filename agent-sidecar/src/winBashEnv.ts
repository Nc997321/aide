import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Windows 上 Bash 工具输出 UTF-8 化（内建，免用户配置）。
 *
 * 根因：SDK 的 Bash 工具在 Windows 跑 Git Bash，Windows 原生 CLI（ping/netstat 等）
 * 按系统 ANSI 代码页（中文机器 = GBK/CP936）输出，终端按 UTF-8 解码 → 全角乱码。
 * 解法：给 bash 一个 BASH_ENV 启动文件（非交互 bash 唯一会 source 的启动钩子），
 * 里面 `chcp.com 65001` 把控制台代码页切到 UTF-8，原生命令输出即为 UTF-8。
 *
 * 该文件由 sidecar 启动时自动落地到配置目录（随 app 分发，换机器/重装都自带），
 * 并把 process.env.BASH_ENV 指过去——SessionWorker 构造 cliEnv 时以 process.env
 * 为底，自然流进 SDK 子进程。用户已自行设置 BASH_ENV 时尊重用户，不覆盖。
 */

const BASHRC_CONTENT =
  "# aide 内置：Windows 原生 CLI 输出切 UTF-8，防 GBK 乱码（此文件由 aide 自动维护，勿手改）\n" +
  "chcp.com 65001 > /dev/null 2>&1\n";

type Env = Record<string, string | undefined>;

/** bashrc 落地路径：配置目录下的 aide-bashrc。 */
export function bashrcPath(env: Env): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return path.join(dir, "aide-bashrc");
}

/**
 * Windows 且用户未自设 BASH_ENV 时：确保 bashrc 文件存在且内容最新，
 * 并把 env.BASH_ENV 指过去（正斜杠形式，Git Bash 更稳）。
 * 非 Windows / 写盘失败均为 no-op（永不阻塞会话启动）。
 */
export function ensureWindowsBashEnv(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  if (env.BASH_ENV) return;
  try {
    const file = bashrcPath(env);
    mkdirSync(path.dirname(file), { recursive: true });
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* 不存在，下面写 */
    }
    if (current !== BASHRC_CONTENT) writeFileSync(file, BASHRC_CONTENT, "utf8");
    env.BASH_ENV = file.replace(/\\/g, "/");
  } catch {
    /* 配置目录不可写等情况：跳过注入，不影响会话 */
  }
}

// 散装 skills/agents 经 SDK options.plugins 旁路注入 agent。
//
// 背景：Aide 用 settingSources:[] 隔离 SDK 文件系统 settings 体系，副作用是 SDK
// 文件系统 skill 发现被断掉，且 SDK 发现机制只认 .claude/skills，覆盖不到 Aide
// 的 .aide/claude/ 命名空间。SDK 文档给的唯一旁路：options.plugins 从特定路径
// 加载。本模块把用户级 ~/.aide/claude/ 与受信任项目级 {cwd}/.aide/claude/ 当
// 无清单 local plugin 注入，Aide 自动写 .claude-plugin/plugin.json 指定唯一 name
// （用户级/项目级目录名都叫 claude，无清单会撞名）。.aide/ gitignore，清单不
// 进版本库。全部 skipMcpDiscovery:true，散装 plugin 不贡献 MCP（与 Aide
// strictMcpConfig 门控隔离）。永不阻塞会话：目录不存在/写失败 → 跳过降级。
// 设计：docs/superpowers/specs/2026-08-03-dispatch-skills-plugins-injection-design.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 用户级 plugin name（skill 命名空间前缀 aide-user:）。符合 SDK 正则 ^[A-Za-z0-9][-A-Za-z0-9._]*$。 */
export const USER_PLUGIN_NAME = "aide-user";
/** 项目级 plugin name（skill 命名空间前缀 aide-project:）。单会话仅一个 cwd，固定名不撞用户级。 */
export const PROJECT_PLUGIN_NAME = "aide-project";

/** SDK plugin 配置（与 sdk.d.ts SdkPluginConfig 结构一致，本地定义避免耦合 SDK 内部类型）。 */
export interface SdkPluginConfig {
  type: "local";
  path: string;
  skipMcpDiscovery?: boolean;
}

const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";

/**
 * 幂等写 {pluginRoot}/.claude-plugin/plugin.json = {"name": name}。
 * - 文件已存在且 JSON.parse 后 name 匹配 → 跳过写，返回 true
 * - 文件不存在 / 损坏 / name 不匹配 → mkdir + 写入，成功返回 true
 * - 任何 IO 异常 → catch 返回 false，不抛（调用方降级跳过该 plugin）
 */
export function ensureDispatchManifest(pluginRoot: string, name: string): boolean {
  const manifestDir = join(pluginRoot, MANIFEST_DIR);
  const manifestFile = join(manifestDir, MANIFEST_FILE);
  const desired = JSON.stringify({ name }) + "\n";

  if (existsSync(manifestFile)) {
    try {
      const cur = readFileSync(manifestFile, "utf8");
      if (JSON.parse(cur)?.name === name) return true;
    } catch {
      // 损坏 JSON → 落到下面重写
    }
  }

  try {
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(manifestFile, desired, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建散装 plugin 注入配置：用户级 + 项目级（仅 trusted）。
 *
 * - lightweight → []
 * - 用户级：claude home = process.env.CLAUDE_CONFIG_DIR（fallback ~/.aide/claude，
 *   与 codegraphSkill.ts:50 同源）。目录存在 + ensureDispatchManifest 成功 → 注入
 * - 项目级：{cwd}/.aide/claude，仅 trusted。同样门控
 * - 每条 skipMcpDiscovery:true（散装 plugin 不贡献 MCP，与 Aide strictMcpConfig 隔离）
 * - 目录不存在 / ensure 失败 → 跳过该条（降级，不阻塞）
 */
export function buildDispatchPluginsOption(
  cwd: string,
  trusted: boolean,
  /** 远程车道：桌面用户扩展在目标机上的镜像（send.extensions.userDir）。缺省 = 本机 claude home。 */
  userRoot?: string | null,
): SdkPluginConfig[] {
  const out: SdkPluginConfig[] = [];

  const claudeHome = userRoot || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".aide", "claude");
  if (existsSync(claudeHome) && ensureDispatchManifest(claudeHome, USER_PLUGIN_NAME)) {
    out.push({ type: "local", path: claudeHome, skipMcpDiscovery: true });
  }

  if (trusted) {
    const projectRoot = resolve(cwd, ".aide", "claude");
    if (existsSync(projectRoot) && ensureDispatchManifest(projectRoot, PROJECT_PLUGIN_NAME)) {
      out.push({ type: "local", path: projectRoot, skipMcpDiscovery: true });
    }
  }

  return out;
}

/** 读 Rust 维护的 enabled-plugins.json（AIDE_ENABLED_PLUGINS_FILE），构建 SDK
 *  options.plugins 的市场插件条目。损坏/缺席 → 空数组（降级不阻塞会话）。
 *  历史住 session-worker.ts 模块级，插件域归位迁来（纯移动）。 */
export function buildPluginsOption(
  /** 远程车道：桌面启用插件在目标机上的镜像（send.extensions.plugins），优先于清单文件。 */
  mirrored?: { path: string }[],
): { type: "local"; path: string }[] {
  if (mirrored) {
    return mirrored.filter((e) => e.path && existsSync(e.path)).map((e) => ({ type: "local" as const, path: e.path }));
  }
  const file = process.env.AIDE_ENABLED_PLUGINS_FILE;
  if (!file) return [];
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as { path: string }[];
    return arr
      .filter((e) => e.path && existsSync(e.path))
      .map((e) => ({ type: "local" as const, path: e.path }));
  } catch {
    // 清单损坏/不可读：不带市场插件（降级，不阻塞会话）
    return [];
  }
}

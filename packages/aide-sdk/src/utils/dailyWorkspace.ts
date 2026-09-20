/**
 * 「日常」模式的归属 —— 全项目唯一判定来源（桌面 + PWA 共用）。
 *
 * 日常背后是一个真实工作区（`<配置目录>/workspace`），它对 UI 隐身：不在
 * list_workspaces 里、不激活、WorkspacePicker 看不到。一个会话是不是"日常"，
 * 等价于它的 wsKey 是不是这一个 —— 归属本来就是会话属性（wsPath/wsKey 已在
 * 会话档案里），所以**零新增会话字段**。
 *
 * 纯策略（isDailyKey / visibleWorkspaces / dailyWorkspaceBind）与 IO
 * （ensureDailyWorkspace）分开：前者脱离 transport 也能测。
 * 设计见 docs/superpowers/specs/2026-09-20-daily-mode-design.md
 */
import { api } from "../api";
import type { WorkspaceInfo } from "../types";

let dailyKey: string | null = null;
let dailyPath = "";
let inflight: Promise<boolean> | null = null;
let unavailable = false;

/** 装载归属（ensureDailyWorkspace 内部用；测试可直接喂）。 */
export function setDailyWorkspace(key: string, path: string): void {
  dailyKey = key;
  dailyPath = path;
}

/**
 * 懒加载一次并缓存。失败只 warn 一次并返回 false —— 远程端（PWA / 鸿蒙）的 RPC
 * 白名单不含 daily_workspace，这是**预期**的降级路径，不是错误：那边没有"日常"
 * 概念，一切照旧。
 */
export async function ensureDailyWorkspace(): Promise<boolean> {
  if (dailyKey) return true;
  if (unavailable) return false;
  inflight ??= api
    .dailyWorkspace()
    .then((w) => {
      setDailyWorkspace(w.key, w.path);
      return true;
    })
    .catch((e: unknown) => {
      unavailable = true;
      console.warn("[daily] 日常归属不可用（远程端无此命令？），日常模式降级为普通工作区", e);
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 这个 key 是不是日常。未装载时恒 false（失败开放：不认识就当普通工作区）。 */
export function isDailyKey(key: string | null | undefined): boolean {
  return !!key && key === dailyKey;
}

/** 日常会话的归属（空白 tab / hero 落点绑定用）；未装载时 null。 */
export function dailyWorkspaceBind(): { wsKey: string; wsPath: string } | null {
  return dailyKey ? { wsKey: dailyKey, wsPath: dailyPath } : null;
}

/**
 * 从工作区列表里剔除日常条目 —— **唯一过滤点**（侧栏分区与 WorkspacePicker 都
 * 经此列表），渲染期不要再滤一次。不原地改入参。
 */
export function visibleWorkspaces(list: WorkspaceInfo[]): WorkspaceInfo[] {
  return list.filter((w) => !isDailyKey(w.key));
}

/** 仅测试用：清掉模块级缓存（同一文件的多个用例共享模块实例）。 */
export function __resetDailyWorkspaceForTest(): void {
  dailyKey = null;
  dailyPath = "";
  inflight = null;
  unavailable = false;
}

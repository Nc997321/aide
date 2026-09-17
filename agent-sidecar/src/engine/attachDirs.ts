// 会话中扩根（@目录 授权）——与 effortSwitch.ts 同族的"活体 flag 切换"。
//
// 形状沿用 effortSwitch（窄结构接口 + 无变化 no-op + 成败都有回声），但把「判定」与
// 「落地」拆成两个函数：applyEffortSwitch 的单参数对象是 5 字段，照抄即照抄超限
// （见写代码理念的参数铁律）。纯函数那半（decideAttach）可以直接单测。
//
// 真相源：worker 实例的账本（session-worker.additionalDirs）。本模块不持有状态。
import type { ChatEvent } from "./types.js";

/** 只声明要用到的那一格（SDK Query 的结构子集，避免拖重型类型）。 */
export interface FlagSettingsQuery {
  applyFlagSettings(settings: { permissions?: { additionalDirectories?: string[] } }): Promise<void>;
}

export interface AttachDecision {
  /** 合并后的**全量**账本（并集去重，保序：先来的在前）。 */
  dirs: string[];
  /** 本轮回声：被 Rust 判掉（未注册/非法）的条目——不参与授权，只负责"别静默"。 */
  rejected: string[];
  /** 有没有事要报：账本变了、或有回声。false = 整条 no-op（不坐实、不广播）。 */
  active: boolean;
}

/** 归一键：Windows 形态（盘符/UNC）不区分大小写，分隔符归一、剥尾分隔符。
 *  只用于**比对**，入账保留原值（下发/显示不丢用户的写法）。 */
function dirKey(dir: string): string {
  const p = dir.trim().replace(/[\\/]+$/, "").replace(/[\\/]/g, "/");
  return /^[a-zA-Z]:\//.test(p) || p.startsWith("//") ? p.toLowerCase() : p;
}

/** 纯函数：并集合并（幂等）。同一目录重复上报不产生变化，也不产生广播。 */
export function decideAttach(
  current: string[],
  incoming: string[],
  rejected: string[] = [],
): AttachDecision {
  const dirs = [...current];
  const seen = new Set(current.map(dirKey));
  let changed = false;
  for (const raw of incoming) {
    const dir = raw.trim();
    if (!dir) continue;
    const key = dirKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
    changed = true;
  }
  return { dirs, rejected, active: changed || rejected.length > 0 };
}

/**
 * 落地。三种情形：
 *  - `query` 未起（含首条消息）：只落账 + 回声——下次 spawn 时账本进
 *    `options.additionalDirectories` 生效；
 *  - `query` 在跑：走 `applyFlagSettings` 实时扩根（实测有效，见方案「spike 实测」S1）。
 *    **成功/失败都 commit + emit 全量**：失败不回滚账本（目录已粘性成立，新会话或
 *    query 重起时必然落地），error 带原文让前端能提示；
 *  - 无变化且无回声：no-op（对齐 effortSwitch 的"同值不坐实不广播"）。
 */
export function applyAttachExtension(
  query: FlagSettingsQuery | null,
  decision: AttachDecision,
  io: { emit: (e: ChatEvent) => void; commit: (dirs: string[]) => void },
): void {
  if (!decision.active) return;
  io.commit(decision.dirs);

  const echo = (error?: string) =>
    io.emit({
      type: "workspace_attached",
      dirs: decision.dirs,
      ...(decision.rejected.length ? { rejected: decision.rejected } : {}),
      ...(error ? { error } : {}),
    });

  // 空账本没有可扩的根（账本只增不减，正常不会走到这里；防御性短路）
  if (!query || decision.dirs.length === 0) {
    echo();
    return;
  }
  // permissions 这一格归本模块独占：applyFlagSettings 的连续调用是**顶层 key 浅合并**
  // （sdk.d.ts:2601-2603），第二次传 {permissions:{...}} 会整体替换上一次的 permissions
  // 对象。今天没有别的写入者（只有 effortLevel/outputStyle 这类标量），这是隐式不变量。
  query
    .applyFlagSettings({ permissions: { additionalDirectories: decision.dirs } })
    .then(() => echo())
    .catch((e: unknown) => echo(String((e as Error)?.message ?? e)));
}

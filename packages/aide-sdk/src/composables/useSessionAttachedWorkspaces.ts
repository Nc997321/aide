import { reactive } from "vue";

/**
 * 会话 id → 本会话的附加目录账本 的模块级注册表（与 useSessionWorkspaces 同构）。
 *
 * **账本的真相在 sidecar worker 里**（它决定 spawn 的 options 与会话中的
 * applyFlagSettings，见方案 C 段）；这里只是给各端显示用的镜像，唯一写入方是 sidecar
 * 广播的 `workspace_attached` 事件——那是**全量账本**，所以整份覆盖即可（幂等）。
 *
 * 为什么不做本地乐观更新：worker 账本随进程消失（杀 sidecar / 会话重开），且远程端
 * 无法知道别的客户端授过什么——只有 sidecar 一处知道全部。发送时客户端把"已知全量"
 * 再报一遍（方案 D9），这张表越新越准，重连自愈也靠它。
 *
 * 除账本外还捎带两份**回声**（不参与授权，只负责"别静默"）：`rejected` = Rust 判掉的
 * 未注册/非法目录，`error` = 活体扩根（applyFlagSettings）失败的原文。
 */
export interface AttachedEntry {
  dirs: string[];
  /** 上一次带目录的 send 里被 Rust 判掉、没进账本的条目。 */
  rejected: string[];
  /** 活体扩根的失败原文（有值 = 当前轮没扩成功，等下一条 send 或下次 spawn 再落）。 */
  error?: string;
}

const attached = reactive<Record<string, AttachedEntry>>({});

export function useSessionAttachedWorkspaces() {
  /** 本会话已知的附加目录（无记录 = 空数组，读点不必判 undefined）。 */
  function attachedOf(sessionId: string): string[] {
    return attached[sessionId]?.dirs ?? [];
  }

  /** 未注册/被拒的目录（回声，见上）。 */
  function rejectedOf(sessionId: string): string[] {
    return attached[sessionId]?.rejected ?? [];
  }

  /** 活体扩根失败原文（回声，见上）。 */
  function errorOf(sessionId: string): string | undefined {
    return attached[sessionId]?.error;
  }

  /** 事件回灌：sidecar 发的是全量账本，整份覆盖。空账本 + 无回声 = 删条目。 */
  function setAll(sessionId: string, dirs: string[], rejected: string[] = [], error?: string): void {
    if (!dirs.length && !rejected.length && !error) {
      delete attached[sessionId];
      return;
    }
    attached[sessionId] = {
      dirs: [...dirs],
      rejected: [...rejected],
      ...(error ? { error } : {}),
    };
  }

  /** 临时 id 被 SDK 确认为真实 id：账本条目原地搬迁（与 useSessionWorkspaces.migrate
   *  同范式，同挂 finalizeSession 链）。 */
  function migrate(oldId: string, newId: string): void {
    const entry = attached[oldId];
    if (!entry) return;
    attached[newId] = entry;
    delete attached[oldId];
  }

  /** 会话销毁时收口（关 tab / 删会话）。读点全有兜底。 */
  function removeWorkspace(sessionId: string): void {
    delete attached[sessionId];
  }

  /** 测试钩子：清空注册表（__resetForTest 的全局复位链路一环）。 */
  function clearAll(): void {
    for (const k of Object.keys(attached)) delete attached[k];
  }

  return {
    attached,
    attachedOf,
    rejectedOf,
    errorOf,
    setAll,
    migrate,
    removeWorkspace,
    clearAll,
  };
}

import { reactive } from "vue";
import {
  readSessionWorkspace,
  writeSessionWorkspace,
} from "./sessionIdentity/persistence/sessionMeta";

/**
 * 会话 id → 所属工作区 的模块级注册表（与 useSessionNames 同构）。
 *
 * 混合 tab 布局下，会话可能来自任意工作区：sidecar 启动 cwd、tab 上的
 * 工作区后缀标识、快照校验都要靠它。写入方：SidebarLeft（加载会话列表时）、
 * App.vue（新会话创建时归属当前工作区）、布局快照恢复（seed）。
 *
 * **注册表是内存态，但不该是"真相的全部"**：WebView 重载即空，`disposeSession`
 * （关 tab / 预览改绑）也会显式删条目。缺条目的会话下一条消息带着
 * `workspaceRoot: null` 出门 → Rust 回落**当前活动工作区** → 整个进程
 * （cwd / 记忆目录 / CLAUDE.md / 转录落点）跑进别的项目（2026-09-18 串档事故）。
 * 所以归属另有落盘副本（`<sid>.json` 的 wsPath/wsKey），由下面「落盘」一节的
 * 两个函数负责对账——注册表仍是**读**的唯一入口，别的地方不要各自读盘。
 */
export interface SessionWorkspaceInfo {
  /** 编码后的工作区 key（`~/.aide/claude/projects/` 目录名） */
  wsKey: string;
  /** 工作区根路径（send_message 的 cwd） */
  wsPath: string;
}

const workspaces = reactive<Record<string, SessionWorkspaceInfo>>({});

/**
 * 盘上已知的归属：`sid → wsPath`，`null` = 读过了、档案里没有。
 * `has()` 即"读没读过"——`ensureWorkspaceKnown` 只读一次，`persistWorkspaceIfDirty`
 * 拿它判断"盘上已经就是这个值吗"。与注册表同生命周期（same 清空 / 过户 / 收口）。
 */
const persistedWs = new Map<string, string | null>();

/** 从工作区路径提取展示名（最后一段目录名），与侧栏 workspaceLabel 同规则。 */
export function workspaceLabelFromPath(wsPath: string): string {
  const parts = wsPath.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || wsPath;
}

/**
 * 回种：注册表没有这条会话的归属时，从档案（`<sid>.json`）读一次补上。
 *
 * 调用点（都在 useChatSession）：打开/切到某条会话时、发送前。**调用方负责挡掉
 * 临时 id**（`pendingSids`）——盘上不可能有它，读一次纯浪费；本模块不引
 * useChatSession 的 state（那是反向依赖，会成环）。
 *
 * 两条不变量：
 *  - 已有条目**绝不覆盖**：注册表里的值都来自权威来源（侧栏列表 / 布局快照 /
 *    创建时快照），档案只是它们的落盘副本；
 *  - 负结果照样入账（`null`）：不重复读盘，但**不落盘**——"查不到"不是归属。
 */
export async function ensureWorkspaceKnown(sessionId: string): Promise<void> {
  if (!sessionId || persistedWs.has(sessionId)) return;
  const disk = await readSessionWorkspace(sessionId);
  persistedWs.set(sessionId, disk?.wsPath ?? null);
  if (workspaces[sessionId] || !disk?.wsPath) return;
  workspaces[sessionId] = { wsKey: disk.wsKey ?? "", wsPath: disk.wsPath };
}

/**
 * 落盘：把注册表里的归属对账进档案（只在盘上不是这个值时才写）。
 *
 * 为什么必须落：注册表是内存态，而归属是**会话自身属性**——重开（关 tab / WebView
 * 重载）后要靠档案把它接回来，否则 Rust 侧只能回落活动工作区，进程整个跑错项目。
 * 存量会话（本字段落地前建的）因此会在第一次发送时被补写，从此变成持久归属。
 *
 * 契约：只在**真实 id** 上调用（定名后）；写失败只留痕不抛——它挂在发送路径上，
 * 不许拖住消息（盘上那份缺失的代价是"下次重开回落"，不是"这条消息发不出去"）。
 */
export async function persistWorkspaceIfDirty(sessionId: string): Promise<void> {
  const cur = workspaces[sessionId];
  if (!sessionId || !cur?.wsPath) return;
  if (persistedWs.get(sessionId) === cur.wsPath) return;
  try {
    await writeSessionWorkspace(sessionId, {
      wsPath: { op: "set", value: cur.wsPath },
      // 没有 key 就 clear 而不是写空串：空串在 Rust 读侧被 filter 掉，
      // 写进去只是留一条永远读不到的垃圾。
      wsKey: cur.wsKey ? { op: "set", value: cur.wsKey } : { op: "clear" },
    });
    persistedWs.set(sessionId, cur.wsPath);
  } catch (e) {
    console.warn("[sessionWorkspaces] 归属落盘失败：", sessionId, e);
  }
}

export function useSessionWorkspaces() {
  function setWorkspace(sessionId: string, info: SessionWorkspaceInfo) {
    if (!info.wsPath && !info.wsKey) return;
    workspaces[sessionId] = info;
  }

  function setMany(sessionIds: Array<{ id: string }>, info: SessionWorkspaceInfo) {
    for (const s of sessionIds) setWorkspace(s.id, info);
  }

  function workspaceOf(sessionId: string): SessionWorkspaceInfo | null {
    return workspaces[sessionId] ?? null;
  }

  /** 临时 id 被 SDK 确认为真实 id：归属条目原地搬迁（与 useChatSession 里
   *  stores/sessionState/provider 的 temp→real 搬迁同范式）。
   *
   *  盘上快照**不搬**：唯一调用点是 finalize，oldId 必是临时号——临时号从不读盘
   *  （读点都挡了 pending），所以它名下不可能有快照。真实 id 以"未知"开局，
   *  紧随其后的 `persistWorkspaceIfDirty(realId)` 正好把它写下去。 */
  function migrate(oldId: string, newId: string) {
    const info = workspaces[oldId];
    if (!info) return;
    workspaces[newId] = info;
    delete workspaces[oldId];
  }

  /** 会话销毁时收口归属条目（关 tab / 删会话 / 预览改绑）。读点 workspaceOf
   *  有 `?? null` 兜底，删后自然回落 null。
   *
   *  盘上快照一并丢弃：重开这条会话时 `ensureWorkspaceKnown` 会重读一次档案，
   *  拿盘上的最新值（销毁期间别的端可能改过归属）。 */
  function removeWorkspace(sessionId: string): void {
    delete workspaces[sessionId];
    persistedWs.delete(sessionId);
  }

  /** 测试钩子：清空注册表（__resetForTest 的全局复位链路一环）。 */
  function clearAll(): void {
    for (const k of Object.keys(workspaces)) delete workspaces[k];
    persistedWs.clear();
  }

  return {
    workspaces,
    setWorkspace,
    setMany,
    workspaceOf,
    migrate,
    removeWorkspace,
    clearAll,
  };
}

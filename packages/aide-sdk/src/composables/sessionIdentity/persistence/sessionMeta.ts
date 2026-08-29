import { api } from "../../../api";

/**
 * L1 持久层：会话元数据 `<sid>.json` 的 provider/model 读写收口。
 *
 * 取代散落的 `api.sessionProvider`/`sessionModel`/`setSessionProvider`/`setSessionModel`
 * 直连。self-heal 并入写入路径——空串/null = 删字段（与 Rust 侧 `set_session_*` 的
 * 空串语义对齐：写空串 → 从 JSON 删字段，读回 filter 空串 → None），保证盘上记录
 * 永不出现脏值。
 *
 * effort 同属 `<sid>.json` 落盘模式但不在本层范围（L2/L3 不涉及 effort 门控），
 * 未来 effort 收口位置在此。
 */

export interface SessionMeta {
  provider: string | null;
  model: string | null;
}

export interface SessionMetaPatch {
  /** undefined = 不动；null | "" = 删字段；非空 = 写。 */
  provider?: string | null;
  /** undefined = 不动；null | "" = 删字段；非空 = 写。 */
  model?: string | null;
}

/** 读 `<sid>.json` 的 provider + model（并行 IPC）。两者皆空 → null（无元数据）。
 *  读失败（IPC reject）按"无元数据"降级返回 null——读不到等于没有，是安全默认。 */
export async function readSessionMeta(sid: string): Promise<SessionMeta | null> {
  const [provider, model] = await Promise.all([
    api.sessionProvider(sid).catch(() => null),
    api.sessionModel(sid).catch(() => null),
  ]);
  if (!provider && !model) return null;
  return { provider, model };
}

/** 唯一落盘入口。按 patch 写 provider/model：undefined 不动，null|"" 删字段，非空写入。
 *  写失败（IPC reject）冒泡给调用方（L2）做降级——本层不吞错，落盘失败影响跨重启，
 *  必须让上层知道。调用方必须 await，禁止 fire-and-forget。 */
export async function writeSessionMeta(sid: string, patch: SessionMetaPatch): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (patch.provider !== undefined) {
    tasks.push(api.setSessionProvider(sid, patch.provider ?? ""));
  }
  if (patch.model !== undefined) {
    tasks.push(api.setSessionModel(sid, patch.model ?? ""));
  }
  await Promise.all(tasks);
}
import { api } from "../../../api";
import type { MetaField, SessionWorkspacePatch, SessionWorkspaceRef } from "../../../types/chat";

/**
 * L1 持久层：会话元数据 `<sid>.json` 的**唯一**写入收口。
 *
 * 身份字段（provider / model / effort）走一次调用写齐的 `writeSessionMeta`；工作区
 * 归属（wsPath / wsKey）走 `writeSessionWorkspace`——两者在 Rust 侧共用同一个加锁的
 * 合并写，拆两条命令是因为并成一条会有 5 个同型 MetaField 的位置参数（交换即静默
 * 错位），且写入时机不同源（归属每次发送对账，身份切换时坐实）。
 *
 * 取代散落的 `api.setSessionProvider` / `setSessionModel` / `setSessionEffort` 直连——
 * 它们各自对同一个文件做一遍 read-modify-write，并发写两个字段时后写的覆盖先写的。
 *
 * 写语义用 `MetaField` 三态（keep / clear / set）显式表达，取代「空串 = 删字段」的
 * 魔法值约定——那种写法把操作类型编码进值域，且无法表达「本次不动这个字段」。
 */

export interface SessionMeta {
  provider: string | null;
  model: string | null;
}

/** 写入 patch：字段语义用 MetaField 三态显式表达（keep / clear / set），
 *  不再用 `undefined | null | "" | string` 四态把操作类型编码进值域。
 *  与 Rust `SessionMetaPatch` / 远端 `set_session_meta` 同形。 */
export type SessionMetaPatch = {
  provider?: MetaField;
  model?: MetaField;
  effort?: MetaField;
};

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

/** `<sid>.json` 的唯一落盘入口。按 patch 写 provider / model / effort，**单次调用**
 *  写齐——Rust 侧一次读、一次写，多字段之间不可能互相覆盖。
 *
 *  此前是 `Promise.all` 并行两个单字段命令（set_session_provider / set_session_model），
 *  各自 read-modify-write 同一个文件，后落盘的覆盖先落盘的（lost update）——首次发送时
 *  「写 provider」与「写 model」几乎同时，最容易撞。
 *
 *  写失败（IPC reject）冒泡给调用方（L2）做降级——本层不吞错，落盘失败影响跨重启，
 *  必须让上层知道。调用方必须 await，禁止 fire-and-forget。 */
export async function writeSessionMeta(sid: string, patch: SessionMetaPatch): Promise<void> {
  await api.setSessionMeta(sid, patch);
}

/** 读会话自持的工作区归属；没记过 / 无档案 / IPC 失败 → null。
 *
 *  与 `readSessionMeta` 分开而不是并进去：身份字段的读取结果直接喂给
 *  `consistentProviderId`（"有档案"与"记过供应商"在那里是两回事），塞进无关字段
 *  会悄悄改变身份解析的判据；而且归属缺失是常态（本字段落地前的存量会话），
 *  调用方需要能单独判断"这条会话没记过归属"。 */
export async function readSessionWorkspace(sid: string): Promise<SessionWorkspaceRef | null> {
  return api.sessionWorkspace(sid).catch(() => null);
}

/** 工作区归属的唯一落盘入口。写失败（IPC reject）冒泡给调用方做降级——
 *  落盘失败影响重开后的 cwd，必须让上层看得见（与 `writeSessionMeta` 同纪律）。 */
export async function writeSessionWorkspace(
  sid: string,
  patch: SessionWorkspacePatch,
): Promise<void> {
  await api.setSessionWorkspace(sid, patch);
}
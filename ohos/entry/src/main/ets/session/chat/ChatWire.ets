/**
 * 会话域 JSON 边界小工具（chat/ 子模块共用）。
 *
 * 上游散落在各文件：crypto.randomUUID（消息/块 id）与 e['field'] 探测收窄
 * （events.ts / pagination.ts 各处 as cast）；ArkTS 化收敛到本文件统一出口。
 * 取值约定：缺省/类型不符一律回退零值（''/false/空记录），坏帧不进 store。
 */
import { util } from '@kit.ArkTS';

export function uuid(): string {
  return util.generateRandomUUID(true);
}

export function emptyRecord(): Record<string, Object> {
  return {};
}

/** Record 载荷取字符串（缺省/类型不符 → 空串）。 */
export function str(p: Record<string, Object>, key: string): string {
  const v: Object | undefined = p[key];
  return v !== undefined && typeof v === 'string' ? v as string : '';
}

export function bool(p: Record<string, Object>, key: string): boolean {
  const v: Object | undefined = p[key];
  return v !== undefined && typeof v === 'boolean' ? v as boolean : false;
}

export function obj(p: Record<string, Object>, key: string): Object {
  const v: Object | undefined = p[key];
  return v !== undefined ? v : emptyRecord();
}

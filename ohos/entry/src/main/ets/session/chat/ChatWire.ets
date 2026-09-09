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

/** Record 载荷取数值（缺省/类型不符 → 0）。 */
export function num(p: Record<string, Object>, key: string): number {
  const v: Object | undefined = p[key];
  return v !== undefined && typeof v === 'number' ? v as number : 0;
}

export function obj(p: Record<string, Object>, key: string): Object {
  const v: Object | undefined = p[key];
  return v !== undefined ? v : emptyRecord();
}

/** 工具入参单行摘要（对照 PWA toolArg：file_path/command/pattern/path/url 优先）。 */
export function toolSummary(input: Object): string {
  if (typeof input === 'string') {
    return input;
  }
  const rec: Record<string, Object> = input as Record<string, Object>;
  const keys: string[] = ['file_path', 'command', 'pattern', 'path', 'url'];
  for (let i = 0; i < keys.length; i++) {
    const v: Object | undefined = rec[keys[i]];
    if (v !== undefined && typeof v === 'string' && v !== '') {
      return v;
    }
  }
  return '';
}

/** 工具入参 JSON（权限卡展示；序列化失败兜底 String——对照 PWA toolInput）。 */
export function inputJson(input: Object): string {
  try {
    return JSON.stringify(input);
  } catch (e) {
    return String(input);
  }
}

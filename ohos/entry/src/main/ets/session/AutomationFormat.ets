/**
 * 自动化域纯展示函数：调度/时间/时长/摘要/枚举文案。
 *
 * 格式机械对照桌面 src/composables/useAutomation.ts（scheduleText /
 * shortTime / formatDurationMs）与 AutomationDetail.vue（runSummary /
 * tokensText）；枚举文案对照 design/automation/app.html（ohos 评审定稿，
 * 权限两档：auto=自动 / full=全自动）。无状态无副作用，不 import 模型层。
 */
import { Schedule, RunRecord, RunUsage } from '../sdk/types';

const WEEKDAY_TXT: string[] = ['一', '二', '三', '四', '五', '六', '日'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 调度的人类可读摘要（抽屉行 / 详情 chip）：每天 18:30 / 每周一、三 18:30 /
 *  每月 5 日 18:30 / 每 2 小时 / 单次 · 08-21 10:00。 */
export function scheduleText(s: Schedule): string {
  if (s.kind === 'daily') {
    return `每天 ${s.time ?? ''}`;
  }
  if (s.kind === 'weekly') {
    const ws: number[] = s.weekdays ?? [];
    const parts: string[] = [];
    for (let i = 0; i < ws.length; i++) {
      const d: number = ws[i];
      parts.push(`周${d >= 1 && d <= 7 ? WEEKDAY_TXT[d - 1] : String(d)}`);
    }
    if (parts.length === 0) {
      return '每周 ??:??';
    }
    return `每${parts.join('、')} ${s.time ?? ''}`;
  }
  if (s.kind === 'monthly') {
    return `每月 ${s.day ?? 0} 日 ${s.time ?? ''}`;
  }
  if (s.kind === 'interval') {
    return `每 ${s.every ?? 0} ${unitLabel(s.unit ?? '')}`;
  }
  if (s.kind === 'once') {
    return `单次 · ${shortTime(s.at ?? '')}`;
  }
  return '';
}

/** 本地 ISO → "MM-DD HH:MM"（与桌面同式：replace T 后切片；不解析时区）。 */
export function shortTime(iso: string | null): string {
  if (iso === null || iso === '') {
    return '';
  }
  return iso.replace('T', ' ').slice(5, 16);
}

/** 毫秒时长 → "45s" / "3m05"（桌面同式；null = 未知 → 空串）。 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null) {
    return '';
  }
  const s: number = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m: number = Math.floor(s / 60);
  return `${m}m${pad2(s % 60)}`;
}

/** 运行记录时长（finishedAt−startedAt）；运行中/坏数据 → null。 */
export function runDurationMs(r: RunRecord): number | null {
  if (r.finishedAt === null) {
    return null;
  }
  const ms: number = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
  return ms >= 0 ? ms : null;
}

/** token 用量摘要（桌面同式）："31.2k·90%缓"；无样本/零量 → 空串。 */
export function tokensText(u: RunUsage | null): string {
  if (u === null) {
    return '';
  }
  const total: number = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  if (total === 0) {
    return '';
  }
  const k: string = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
  const pct: number = Math.round((u.cacheReadTokens / total) * 100);
  return `${k}·${pct}%缓`;
}

/** 运行行主文案（桌面同式，error/note 优先于 summary）。 */
export function runSummary(r: RunRecord): string {
  if (r.error !== null && r.error !== '') {
    return `失败 — ${r.error}`;
  }
  if (r.note === 'overlap') {
    return '跳过 — 上次运行尚未结束';
  }
  if (r.note === 'missed-skip') {
    return '跳过 — 客户端未运行（策略：跳过）';
  }
  if (r.note === 'missed-ask') {
    return '跳过 — 客户端未运行（策略：询问）';
  }
  if (r.status === 'running') {
    return '正在运行 — 点击查看实时输出';
  }
  if (r.summary !== null && r.summary !== '') {
    return r.summary;
  }
  return '查看完整转录';
}

// ── 枚举文案（对照原型；未收录值回退原文）──

export function statusLabel(s: string): string {
  if (s === 'succeeded') {
    return '成功';
  }
  if (s === 'failed') {
    return '失败';
  }
  if (s === 'running') {
    return '运行中';
  }
  if (s === 'skipped') {
    return '跳过';
  }
  return s;
}

export function triggerLabel(t: string): string {
  if (t === 'schedule') {
    return '调度';
  }
  if (t === 'manual') {
    return '手动';
  }
  if (t === 'catchup') {
    return '补跑';
  }
  return t;
}

export function modeLabel(m: string): string {
  if (m === 'explore') {
    return '指令';
  }
  if (m === 'playbook') {
    return '手册';
  }
  return m;
}

/** 权限预设（v1 两档定案；readonly 是旧档 serde 别名，归并 auto，不出假选项）。 */
export function presetLabel(p: string): string {
  if (p === 'auto') {
    return '自动';
  }
  if (p === 'full') {
    return '全自动';
  }
  return p;
}

/** 错过策略 seg 文案：catchup=补跑一次 / skip=跳过并记录（ask 暂不在 seg 暴露）。 */
export function missedLabel(m: string): string {
  if (m === 'catchup') {
    return '补跑一次';
  }
  if (m === 'skip') {
    return '跳过并记录';
  }
  return m;
}

/** 思考档文案（ohos 三档；协议另有 medium/xhigh，未收录回退原文）。 */
export function effortLabel(v: string): string {
  if (v === 'low') {
    return '快速';
  }
  if (v === 'high') {
    return '均衡';
  }
  if (v === 'max') {
    return '极致';
  }
  return v;
}

export function unitLabel(u: string): string {
  if (u === 'minutes') {
    return '分钟';
  }
  if (u === 'hours') {
    return '小时';
  }
  if (u === 'days') {
    return '天';
  }
  return u;
}

/** 运行行成本（桌面同式 $0.043；null → 空串）。 */
export function costText(usd: number | null): string {
  if (usd === null) {
    return '';
  }
  return `$${usd.toFixed(3)}`;
}

/** 运行行 note 角标固定文案（原型 NOTE_TXT；未收录值回退原文）。 */
export function noteText(n: string): string {
  if (n === 'overlap') {
    return '上一次运行尚未结束，本次跳过';
  }
  if (n === 'missed-skip') {
    return '桌面离线错过排程，按「跳过并记录」处理';
  }
  if (n === 'missed-ask') {
    return '桌面离线错过排程';
  }
  return n;
}
